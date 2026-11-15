// 源根 mtime 采样与惰性对比（P-20261114-3-S2 快照陈旧徽标，主档）：frozen
// 分享的访客内容是创建时的定格副本，源在创建后变化 → 管理面应显「源已更新」。
// 判定双档（评审修订点②，主备互换）：
//   - 本文件 = **正确性主档**：管理面列表请求时惰性对比「源根当前 mtime 聚合
//     vs 创建时基准」（store.Share.SourceMtimes），覆盖内核总线订阅的三个盲区
//     ——进程重启丢事件、inotify 降级窗口（轮询广播 path=项目根，前缀过滤失效）、
//     订阅装配前的窗口，防「假新鲜」漏报；
//   - shareapi.staleHub = 即时性加速器：file.changed 订阅 + 分享根前缀过滤，
//     秒级置位；主档兜底其漏报，两者判定互不依赖。
//
// 护栏（上限防大树遍历）：采样/对比都是子树 WalkDir，条目预算
// StaleScanEntryCap 共享于单条分享的全部根——超限即放弃本条对比（unknown：
// 不置位、不误报、不部分判定），真实评审包（≤50 项 × 几个目录）远低于此。
//
// 聚合口径：子树全体条目（文件+目录）mtime 的最大值。任何新增/改写/删除都会
// 把某条目或其父目录 mtime 顶到新值，max 不等（双向）即判定变更——删除基准里
// mtime 最大的文件会让当前 max **变小**，等值比较天然覆盖。已知边界（mtime
// 判定的固有局限，注释如实）：mtime 被人为拨回旧值的改写、时钟超前文件掩盖
// 其后的普通写入、跨设备 mtimeserver 粒度内的两次写入，主档可能漏报（加速器
// 或下次真实变更兜底）；不追求等价内容指纹（哈希全树）——那是复制级成本，
// 与「列表请求惰性对比」的量级预算不符。

package share

import (
	"errors"
	"io/fs"
	"sync/atomic"
)

// StaleScanEntryCap 采样/对比的条目预算（单条分享全部根共享）：超限放弃判定
// 返回 unknown——上限护栏防大树遍历（任务书语义「超限即跳过对比标记 unknown
// 不置位不误报」）。量级考量：这是「每次列表请求 × 每条未陈旧 frozen 分享」
// 的 WalkDir 上界（staleHub 另有 2s 节流），4000 条目在本地盘约几十毫秒；
// 与 watch 降级指纹（2000/项目/5s 轮）、目录打包护栏（20000/一次性）同族取中。
// var 供单测注入小档位（files.duplicate dupMaxEntries 同款测试缝）
var StaleScanEntryCap = 4000

// errStaleBudget 预算耗尽的内部哨兵（不外发——调用方只见 ok=false）。刻意
// 不用 fs.SkipAll：SkipAll 让 WalkDir 以 nil 返回，耗尽会被误读成采样成功
var errStaleBudget = errors.New("share: staleness scan entry budget exhausted")

// CaptureSourceMtimes 对 rels 各分享根做基准采样：键 = 规范化相对路径（调用方
// 传入的形态，单路径含项目根空串；批量 = CanonicalSharePaths 产物），值 = 子树
// max mtime（UnixNano）。任一根超条目预算 / 源不可达 / 采样失败 → (nil, false)
// ——基准宁缺勿错（无基准 = 不追踪，管理面不置位）。源锚定与快照复制同信任链
// （openShareSource：项目根 os.Root 双层 + 分享根逐段符号链接拒绝），树内符号
// 链接不跟随（与访客面「符号链接不可见」语义一致）。rel 集合与记录字段一致
// 由调用方保证（本函数只读盘，不读记录）
func CaptureSourceMtimes(rootDir string, rels []string) (map[string]int64, bool) {
	if len(rels) == 0 {
		return nil, false
	}
	budget := StaleScanEntryCap
	out := make(map[string]int64, len(rels))
	for _, rel := range rels {
		max, ok := captureRelMax(rootDir, rel, &budget)
		if !ok {
			return nil, false // 整单放弃：部分基准 = 部分盲区，比无基准更难对账
		}
		out[rel] = max
	}
	return out, true
}

// SourceChanged 惰性对比（主档判定原语）：源根当前聚合 vs 基准（CaptureSource
// Mtimes 的产物）。三态经 (changed, ok) 表达：ok=false = 无法判定（源不可达/
// 超预算/基准形态非法）——调用方不置位不误报；changed=true = 当前聚合与基准
// 不等（含变小：删除了 max 条目）。rels 与基准键集不必全等：键缺失的根按
// 「有基准无判定」处理（记录形态演进防御），仅对键齐全的根逐根判定
func SourceChanged(rootDir string, rels []string, baseline map[string]int64) (changed, ok bool) {
	if len(baseline) == 0 {
		return false, false
	}
	budget := StaleScanEntryCap
	for _, rel := range rels {
		base, present := baseline[rel]
		if !present {
			return false, false // 基准键集与根集不齐：整体 unknown（部分判定易漂移）
		}
		cur, ok := captureRelMax(rootDir, rel, &budget)
		if !ok {
			return false, false
		}
		if cur != base {
			return true, true
		}
	}
	// 基准里有而 rels 没有的键（调用方根集缩水）：无法对比，按 unknown
	if len(baseline) != len(rels) {
		return false, false
	}
	return false, true
}

// captureRelMax 单个分享根的 max mtime 采样（budget 为跨根共享的剩余预算，
// 指针传递——多根合计受同一上限，单条分享的对比代价有界）。源锚定复用
// openShareSource（创建/刷新复制同款信任链）；文件分享锚定父目录走名单限定
// 单文件，WalkDir 天然只产出该文件。ok=false = 超预算/源不可达（unknown）
func captureRelMax(rootDir, rel string, budget *int) (max int64, ok bool) {
	if staleProbeFail.Load() {
		return 0, false // 单测缝：模拟源不可达（免构造不可读目录）
	}
	srcRoot, walkName, err := openShareSource(rootDir, rel)
	if err != nil {
		return 0, false
	}
	defer srcRoot.Close()
	err = fs.WalkDir(srcRoot.FS(), walkName, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// 符号链接不跟随（与快照复制一致；其指向内容的 mtime 不属本子树）
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if *budget <= 0 {
			return errStaleBudget
		}
		*budget--
		info, ierr := d.Info()
		if ierr != nil {
			return nil // 竞态删除等瞬时态：该条目跳过（尽力而为采样）
		}
		if mt := info.ModTime().UnixNano(); mt > max {
			max = mt
		}
		return nil
	})
	if err != nil {
		return 0, false
	}
	return max, true
}

// HasStaleBaseline 记录是否携带可用基准（shareapi 投影的前置闸）：nil/空 =
// 未采样（超限/失败/存量记录），不追踪陈旧。frozen 门在调用方（投影只认
// frozen file 形态），这里只答基准有无
func HasStaleBaseline(m map[string]int64) bool { return len(m) > 0 }

// staleProbeOnce 单测缝：置位后 captureRelMax 记账走 os.Stat 直探（绕过
// WalkDir 注入桩用）。当前无注入桩——留作空实现占位会被 lint 报 unused，
// 故以原子标志形态落地：测试经 SetStaleProbeFail 模拟「源不可达 unknown」
var staleProbeFail atomic.Bool

// SetStaleProbeFail 单测注入口：true = 采样/对比一律按源不可达处理（unknown），
// 模拟项目根消失/权限受限面，免构造不可读目录
func SetStaleProbeFail(v bool) { staleProbeFail.Store(v) }
