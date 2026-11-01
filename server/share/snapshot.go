// 冻结快照管理（P-20261003-320）：分享创建时把分享根复制进隔离目录，访客
// 读副本而非项目目录——内容定格（「给同事看这个版本」）且敏感扫描即对副本
// 本身（所见即所扫）。
//
// 落盘纪律：副本是车道 2 大块数据，住 <DataDir>/artifacts/share-snapshots/
//（同 trash/recordings 惯例），目录名 = store.FrozenNativeToken（零代际派生
// token）——rotate 换短链不改目录名，副本原地不动；清账三通道：撤销即删
//（管理面显式调 DeleteFrozenSnapshot）+ 记录 TTL 到期随 CleanupExpired 消亡
// 后由孤儿对账兜底（GcOrphanSnapshots）+ 双体积护栏（单份/总量，超限拒绝）。
//
// 复制安全边界与访客面同源：源侧 os.Root 双层锚定（项目根 → 分享根）+
// 分享根路径逐段符号链接拒绝；树内符号链接一律跳过（不跟随也不重建——
// 与 live 访客面「符号链接不可见」语义一致，且规避 Windows 建链权限问题）。
// 目标目录名是服务端派生 token（base36 定长），无路径注入面。

package share

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
)

// MaxFrozenBytes 单份冻结快照的体积上限（200MB）：同步复制压在创建请求的
// 可等待时长内（SSB 上走盘 ~秒级），超限目标劝退走 live 活视图——评审/留证
// 要的是定格与可扫，不是无限大的镜像
const MaxFrozenBytes = 200 << 20

// MaxFrozenTotalBytes 快照库总量上限（1GB）：磁盘占用的第二道护栏（第一道
// 是单份 200MB × 记录 TTL 30 天）。创建路径预算 = 既有总量 + 本次复制量，
// 触顶拒绝并引导撤销旧冻结链；清账回收后自然回线
const MaxFrozenTotalBytes = 1 << 30

// 冻结快照的稳定错误（原文即前端 KNOWN_ERROR_I18N 的匹配契约，改文案须
// 同步 web/src/api/http.ts 的正则）。文本唯一事实源在 errmarkers 注册表
// （P-20261004-29）
var (
	// ErrFrozenTooLarge 目标超过单份冻结上限（提示走 live）
	ErrFrozenTooLarge = errors.New(errmarkers.FrozenTooLarge)
	// ErrFrozenQuota 快照库总量触顶（引导撤销旧冻结链或走 live）
	ErrFrozenQuota = errors.New(errmarkers.FrozenQuota)
	// ErrReplayTooLarge 回放 cast 快照超过单份上限（P-20261004-103，同
	// MaxFrozenBytes 护栏——录制窗口 15 分钟上限下实际不可达，纯防御）
	ErrReplayTooLarge = errors.New(errmarkers.ReplayTooLarge)
)

// snapMu 串行化快照复制/删除/对账（全局一把锁足够：创建是用户手工低频操作，
// 复制期间持锁让并发冻结排队而非交错写同一目录；trashMu 同款先例）
var snapMu sync.Mutex

// SnapshotsRoot 冻结快照根（车道 2：<DataDir>/artifacts/share-snapshots/；
// 独立函数供测试经 SC_DATA_DIR 隔离，同 recording.ArtifactsDir 惯例）
func SnapshotsRoot() string {
	return filepath.Join(config.DataDir(), "artifacts", "share-snapshots")
}

// snapshotDir 单份快照目录（nativeToken 必须是服务端派生 token，调用方保证）
func snapshotDir(nativeToken string) string {
	return filepath.Join(SnapshotsRoot(), nativeToken)
}

// HasFrozenSnapshot 快照副本是否在盘（幂等创建跳过复制的判断依据：记录在
// 而副本丢失时宁可重拷修复，不给访客留永久 target_gone 的坏链）
func HasFrozenSnapshot(nativeToken string) bool {
	info, err := os.Stat(snapshotDir(nativeToken))
	return err == nil && info.IsDir()
}

// CreateFrozenSnapshot 把项目根 rootDir 内 rel 分享根整树复制为冻结快照，
// 返回复制字节数。调用方契约：rel 已过 NormalizeRelPath 且 StatTarget 校验
// 存在（本函数对分享根路径再做一次逐段符号链接拒绝，防御纵深与扫描同款）。
// 双护栏触顶 / 复制失败时清掉半成品目录整体回滚，不留残壳（残壳由下一次
// 创建的预清理与孤儿对账双兜底）
func CreateFrozenSnapshot(rootDir, rel, nativeToken string) (int64, error) {
	snapMu.Lock()
	defer snapMu.Unlock()

	destDir := snapshotDir(nativeToken)
	// 预算：既有快照总量（目录级个位数，WalkDir 成本可忽略；跳过本次目标
	// 目录——预清理发生在预算之后，旧残壳不计入本次额度）
	used, err := dirTotalBytes(SnapshotsRoot(), destDir)
	if err != nil {
		return 0, err
	}

	// 源锚定 + 复制（源信任链与刷新路径共用，见 openShareSource）
	srcRoot, walkName, err := openShareSource(rootDir, rel)
	if err != nil {
		return 0, err
	}
	defer srcRoot.Close()

	// 预清理 + 建目录：RemoveAll 幂等（目录不存在 = 无事发生），清掉崩溃/
	// 失败残留的旧残壳，保证目标目录里只有本次复制的内容
	if err := os.RemoveAll(destDir); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return 0, err
	}

	budget := &copyBudget{usedBefore: used}
	if err := copyTreeInto(srcRoot.FS(), walkName, destDir, rel, budget); err != nil {
		_ = os.RemoveAll(destDir) // 半成品整体回滚
		return 0, err
	}
	return budget.copied, nil
}

// CreateFrozenSnapshotMulti 多路径冻结快照（P-20261008-1）：把 rels 各自的
// 子树复制进同一副本，保留项目内相对结构（destDir/<rel>/...）。每条路径的
// 源锚定/符号链接跳过与单路径同源（openShareSource + copyTreeInto 原语）；
// 单份体积护栏是**合计预算**——全部路径累计触 MaxFrozenBytes 即拒绝（任务书
// 语义：N 路径合计触顶时拒绝并提示拆分），总量护栏仍与快照库对账同口径。
// 任一路径失败整体回滚（与单路径「失败即无」一致），不留半成品。
// 调用方契约：rels 已归一（NormalizeRelPath/CanonicalSharePaths）且逐项
// StatTarget 校验存在；嵌套选择由调用方先去重（本函数再做一次词法兜底防
// 同一内容双份复制/双份计费）
func CreateFrozenSnapshotMulti(rootDir string, rels []string, nativeToken string) (int64, error) {
	rels = dedupeNestedRels(rels)
	if len(rels) == 0 {
		return 0, fmt.Errorf("share: frozen batch requires at least one path")
	}
	snapMu.Lock()
	defer snapMu.Unlock()

	destDir := snapshotDir(nativeToken)
	used, err := dirTotalBytes(SnapshotsRoot(), destDir)
	if err != nil {
		return 0, err
	}
	if err := os.RemoveAll(destDir); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return 0, err
	}
	budget := &copyBudget{usedBefore: used}
	if err := copyRelsInto(rootDir, rels, destDir, budget); err != nil {
		_ = os.RemoveAll(destDir) // 半成品整体回滚（单路径同款）
		return 0, err
	}
	return budget.copied, nil
}

// copyRelsInto 逐路径复制进同一目标目录（多路径创建与刷新共用）：每条路径
// 独立打开源锚定，复制字节累计进同一 budget——合计护栏天然覆盖 N 路径
func copyRelsInto(rootDir string, rels []string, destDir string, budget *copyBudget) error {
	for _, rel := range rels {
		srcRoot, walkName, err := openShareSource(rootDir, rel)
		if err != nil {
			return err
		}
		err = copyTreeInto(srcRoot.FS(), walkName, destDir, rel, budget)
		srcRoot.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// dedupeNestedRels 多路径嵌套去重：路径落在另一选中路径子树内时随父路径
// （排序后前缀判定；父路径在前，子项被吸收），完全重复项同样只留一份。与
// files-archive 的 dedupNestedTargets 同规则——分享是同一内容单份定格，
// 重复项只会造成双份复制与合计护栏虚高。空串（项目根）不是合法的多路径
// 选择项，先行丢弃（CanonicalSharePaths 已拒绝，这里兜底防未来直调）
func dedupeNestedRels(rels []string) []string {
	sorted := append([]string(nil), rels...)
	sort.Strings(sorted)
	out := make([]string, 0, len(sorted))
	seen := make(map[string]bool, len(sorted))
	for _, p := range sorted {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		nested := false
		for _, q := range out {
			if strings.HasPrefix(p, q+"/") {
				nested = true
				break
			}
		}
		if !nested {
			out = append(out, p)
		}
	}
	return out
}

// openShareSource 分享根的源侧锚定（创建与刷新两条复制路径共用一套信任链）：
// 项目根 → 分享根双层 os.Root（与访客面 resolveRel 同源）+ 分享根路径逐段
// 符号链接拒绝。OpenRoot 只接受目录：目录分享锚定分享根整树走 "."；文件
// 分享锚定其父目录、只走该文件（锚点收在分享根父级 + 走名单限定单文件，
// 边界仍是分享根本身，不会把父目录其他内容吸进副本）。
// 返回的 srcRoot 由调用方 Close
func openShareSource(rootDir, rel string) (srcRoot *os.Root, walkName string, err error) {
	projRoot, err := os.OpenRoot(rootDir)
	if err != nil {
		return nil, "", err
	}
	defer projRoot.Close()
	if herr := rejectSymlinkPath(projRoot, rel); herr != nil {
		return nil, "", fs.ErrNotExist
	}
	fsRel := rel
	if fsRel == "" {
		fsRel = "."
	}
	info, err := projRoot.Stat(fsRel)
	if err != nil {
		return nil, "", err
	}
	if info.IsDir() {
		srcRoot, err = projRoot.OpenRoot(fsRel)
		return srcRoot, ".", err
	}
	srcRoot, err = projRoot.OpenRoot(path.Dir(fsRel))
	return srcRoot, path.Base(fsRel), err
}

// frozenStagingSuffix 原地刷新（P-20261005-177）两段式的暂存目录后缀：
// <nativeToken>.staging——刷新的新副本先拷进暂存目录（在服务的旧副本全程
// 零扰动），敏感扫描确认后才换名顶替。孤儿对账按名字跳过暂存目录（不在
// keep 集，无豁免会被当作孤儿清掉，刷新中途即断）
const frozenStagingSuffix = ".staging"

// stagingDir 单次刷新的暂存目录（名字确定性派生：并发双刷新互踩的窗口由
// 「先 promote 者胜、后者如实报错且旧副本完好」兜底，见 PromoteFrozenSnapshot）
func stagingDir(nativeToken string) string {
	return snapshotDir(nativeToken) + frozenStagingSuffix
}

// StagedScanRel 刷新暂存副本的扫描相对路径（管理面对暂存目录跑敏感扫描用，
// 与创建路径「扫描根 = SnapshotsRoot()、rel = nativeToken[/分享根]」同布局）
func StagedScanRel(nativeToken, rel string) string {
	out := nativeToken + frozenStagingSuffix
	if rel != "" {
		out += "/" + rel
	}
	return out
}

// StageFrozenSnapshot 原地刷新第一段：把分享根当前内容重拷进暂存目录，
// 返回复制字节数。在服务的旧副本全程不触碰（访客面无感知）；锁内完成
// 源锚定+复制+双体积护栏（与创建同款信任链）。预算扣除旧副本——换名后
// 旧副本即消失，刷新不该比首次创建更苛刻（否则旧副本越大的链越刷不动）。
// 任何失败（护栏触顶/复制出错）暂存目录整体丢弃，旧副本不受影响——
// 「拒绝刷新绝不弄瞎既有链」与创建路径「失败即无」的刻意分野：刷新时
// 旧副本后面站着已分发给外部的访客
func StageFrozenSnapshot(rootDir, rel, nativeToken string) (int64, error) {
	snapMu.Lock()
	defer snapMu.Unlock()

	stage := stagingDir(nativeToken)
	// 预算 = 既有总量 − 旧副本 − 暂存残留（后两者都不计入本次额度：前者
	// 换名即消失，后者是上次刷新的失败残留）
	total, err := dirTotalBytes(SnapshotsRoot(), stage)
	if err != nil {
		return 0, err
	}
	oldSize, _ := dirTotalBytes(snapshotDir(nativeToken), "")
	used := total - oldSize

	srcRoot, walkName, err := openShareSource(rootDir, rel)
	if err != nil {
		return 0, err
	}
	defer srcRoot.Close()

	// 预清理 + 建目录：清掉上次刷新失败的暂存残壳，保证里面只有本次内容
	if err := os.RemoveAll(stage); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return 0, err
	}
	budget := &copyBudget{usedBefore: used}
	if err := copyTreeInto(srcRoot.FS(), walkName, stage, rel, budget); err != nil {
		_ = os.RemoveAll(stage) // 半成品整体丢弃，旧副本未动
		return 0, err
	}
	return budget.copied, nil
}

// StageFrozenSnapshotMulti 多路径冻结快照的原地刷新第一段（P-20261008-1）：
// 与 StageFrozenSnapshot 同语义（旧副本零扰动、预算扣除旧副本、失败丢弃
// 暂存），路径集合逐项重拷进同一个暂存目录。预算口径与创建一致——N 路径
// 合计受 MaxFrozenBytes 单份上限约束
func StageFrozenSnapshotMulti(rootDir string, rels []string, nativeToken string) (int64, error) {
	rels = dedupeNestedRels(rels)
	if len(rels) == 0 {
		return 0, fmt.Errorf("share: frozen batch requires at least one path")
	}
	snapMu.Lock()
	defer snapMu.Unlock()

	stage := stagingDir(nativeToken)
	total, err := dirTotalBytes(SnapshotsRoot(), stage)
	if err != nil {
		return 0, err
	}
	oldSize, _ := dirTotalBytes(snapshotDir(nativeToken), "")
	used := total - oldSize

	if err := os.RemoveAll(stage); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return 0, err
	}
	budget := &copyBudget{usedBefore: used}
	if err := copyRelsInto(rootDir, rels, stage, budget); err != nil {
		_ = os.RemoveAll(stage) // 半成品整体丢弃，旧副本未动
		return 0, err
	}
	return budget.copied, nil
}

// PromoteFrozenSnapshot 原地刷新第二段：暂存目录顶替旧副本（扫描确认后的
// 换名收口）。三步：旧副本换名让位（原子）→ 暂存目录换名顶上（原子）→
// 旧副本删账（尽力而为，失败残留由孤儿对账兜底清走）。访客可见的空窗
// = 两次换名之间的元数据操作间隙（µs 级，远小于按树删除；换入失败时旧
// 副本原位还原，链不因刷新失败而瞎）。暂存目录不在（并发刷新已被人收走/
// 残留被清）→ 如实报错且旧副本保持原样。
// 调用方契约：StageFrozenSnapshot 已成功且扫描放行
func PromoteFrozenSnapshot(nativeToken string) error {
	snapMu.Lock()
	defer snapMu.Unlock()

	destDir, stage := snapshotDir(nativeToken), stagingDir(nativeToken)
	old := destDir + ".old"
	// 上一次 promote 删账失败的残留先清位（幂等；换名让位才能成功）
	_ = os.RemoveAll(old)
	if err := os.Rename(destDir, old); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(stage, destDir); err != nil {
		// 换入失败：旧副本还原原位（尽力而为——还原再失败时孤儿对账按
		// keep 集对账会清掉错位的残壳，但链接已瞎，只能靠下次刷新修复）
		if rerr := os.Rename(old, destDir); rerr != nil {
			slog.Warn("share: frozen promote restore failed", "token", TokenSummary(nativeToken), "err", rerr)
		}
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		slog.Warn("share: frozen promote old copy cleanup failed", "token", TokenSummary(nativeToken), "err", err)
	}
	return nil
}

// DiscardFrozenStaging 丢弃暂存目录（扫描命中未确认——「未确认不换内容」
// 与创建路径的半成品随警告丢弃同语义）。幂等；旧副本全程未动
func DiscardFrozenStaging(nativeToken string) {
	snapMu.Lock()
	defer snapMu.Unlock()
	_ = os.RemoveAll(stagingDir(nativeToken))
}

// copyBudget 一次快照复制（单路径或 N 路径合计）的护栏预算。copied 是本次
// 已复制字节累计，usedBefore 是快照库既有占用——N 路径各自复制时共用同一
// 预算，单份上限（MaxFrozenBytes）因此天然表达「合计」语义（P-20261008-1）
type copyBudget struct {
	usedBefore int64
	copied     int64
}

// check 复制前护栏判定（哨兵错误经 errors.Is 可辨）
func (b *copyBudget) check(size int64) error {
	if b.copied+size > MaxFrozenBytes {
		return ErrFrozenTooLarge
	}
	if b.usedBefore+b.copied+size > MaxFrozenTotalBytes {
		return ErrFrozenQuota
	}
	return nil
}

// copyTreeInto 把 root 内 walkName 子树复制到 destDir 下，按分享根在项目内
// 的相对路径 rel 镜像存放（destDir/<rel>/...）：访客面冻结解析与 live 同构
// （rel = Path[/q]），文件/目录分享一套逻辑，zip 打包的前缀剥离也零特判。
// 不跟随符号链接，复制字节累计进 budget 并执行双体积护栏（单份/总量）
func copyTreeInto(root fs.FS, walkName, destDir, rel string, budget *copyBudget) error {
	return fs.WalkDir(root, walkName, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// 符号链接不跟随也不重建（与 live 访客面「符号链接不可见」语义一致；
		// Windows 无特权建链必败，跳过是唯一跨平台一致解）
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		// 镜像落点：分享根本身 → destDir/<rel>；子项 → destDir/<rel>/<子路径>。
		// 文件分享（walkName = 文件名）走名单里唯一条目即分享根本身 → destDir/<rel>
		sub := p
		if walkName != "." {
			sub = strings.TrimPrefix(p, walkName)
		}
		target := filepath.Join(destDir, filepath.FromSlash(rel))
		if sub != "" {
			target = filepath.Join(target, filepath.FromSlash(sub))
		}
		if d.IsDir() {
			info, ierr := d.Info()
			mode := fs.FileMode(0o755)
			if ierr == nil {
				mode = info.Mode().Perm()
			}
			return os.MkdirAll(target, mode)
		}
		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		// 护栏在复制前判：超出即中止（逐文件检查一次，量级 = 文件数）
		if err := budget.check(info.Size()); err != nil {
			return err
		}
		return copyFile(root, p, target, info.Mode().Perm(), budget)
	})
}

// copyFile 单文件复制（保留源权限；字节数累加进 budget）。父目录就地补建
// ——文件分享的镜像落点（destDir/<多级 rel>/file）不经过任何目录步进
func copyFile(root fs.FS, src, dest string, perm fs.FileMode, budget *copyBudget) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := root.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		if fi, serr := os.Stat(dest); serr == nil {
			budget.copied += fi.Size() // 实际落盘量为准（源 Size 在并发写场景可能过时）
		}
	}
	return err
}

// DeleteFrozenSnapshot 删除单份快照副本（撤销即删的落点；目录不存在幂等
// nil——调用方语义是「确保不在盘」，残壳清账另有孤儿对账兜底）
func DeleteFrozenSnapshot(nativeToken string) error {
	snapMu.Lock()
	defer snapMu.Unlock()
	return os.RemoveAll(snapshotDir(nativeToken))
}

// termFrozenFileName 终端输出冻结快照（P-20261005-205）目录内的单文件名。
// 目录名 = TermFrozenNativeToken（零代际派生），目录内恒一个净化文本文件；
// 访客面把分享根锚定在快照目录、rel 固定指向本文件（单文件形态的 resolve
// 语义 = 文件分享，raw/download 免 path 参数）。.txt 后缀让 raw 直出
// text/plain（preview 注册表按扩展名判定 MIME）、dl 链接自带可读文件名
const termFrozenFileName = "output.txt"

// castFileName 会话回放分享（P-20261004-103）快照目录内的单文件名。目录名 =
// CastNativeToken（零代际派生），目录内恒一个 asciinema v2 cast 文件；访客面
// /cast 端点直接取本文件（文本/明文，浏览器回放器解析）。.cast 后缀与录制
// 车道 artifacts/recordings/<id>.cast 同名习惯一致，下载后可交给外部播放器
const castFileName = "replay.cast"

// sessionFileName 会话回放只读分享（P-20261003-77）快照目录内的单文件名。
// 目录名 = SessionNativeToken（零代际派生），目录内恒一个 JSON 快照（会话
// 条目的解析后序列，敏感值已在写盘前按 P-108 模式集遮蔽）；访客面 /session
// 端点直接取本文件（application/json），访客页据此渲染只读时间线。.json
// 后缀让下载/调试直读形态自明
const sessionFileName = "session.json"

// HasTermFrozenSnapshot 终端输出单文件快照是否在盘（创建路径幂等短路探针：
// 记录在而副本丢失时重写修复，与冻结目录快照的 HasFrozenSnapshot 同款取向；
// 探文件比探目录更诚实——本形态目录内恒单文件，目录存在而文件缺失即坏副本）
func HasTermFrozenSnapshot(nativeToken string) bool {
	info, err := os.Stat(filepath.Join(snapshotDir(nativeToken), termFrozenFileName))
	return err == nil && !info.IsDir()
}

// HasCastSnapshot 会话回放快照是否在盘（同 HasTermFrozenSnapshot 的探针语义）
func HasCastSnapshot(nativeToken string) bool {
	info, err := os.Stat(filepath.Join(snapshotDir(nativeToken), castFileName))
	return err == nil && !info.IsDir()
}

// HasSessionSnapshot 会话回放条目快照是否在盘（同族探针语义：目录存在而
// session.json 缺失即坏副本，创建路径重写修复）
func HasSessionSnapshot(nativeToken string) bool {
	info, err := os.Stat(filepath.Join(snapshotDir(nativeToken), sessionFileName))
	return err == nil && !info.IsDir()
}

// WriteTermFrozenSnapshot 把终端输出的净化文本写入单文件快照（P-20261005-205；
// P-320 目录快照的单文件形态，同一 SnapshotsRoot 隔离区与清账通道）。
// 调用方契约：data 已完成 ANSI 剥离与敏感值遮蔽（快照本体即净本，访客面
// 零二次处理）；nativeToken 必须是 TermFrozenNativeToken 派生值（调用方
// 保证，目录名无注入面）。同 token 重复写入 = 同内容幂等重写（哈希派生
// 键的直推），兼作「记录在而副本丢失」的修复通道。
// 体积护栏：单份沿 MaxFrozenBytes（scrollback 历史天然有界 ≤16MB，护栏
// 纯防御）；总量沿 MaxFrozenTotalBytes 预算（触顶 ErrFrozenQuota 引导清旧）。
// 落盘走临时文件 + 同目录 rename（崩溃不半文件：访客要么读到完整旧内容
// 要么完整新内容，同 hash 语义下两者等价）
func WriteTermFrozenSnapshot(nativeToken string, data []byte) error {
	return writeSingleFileSnapshot(nativeToken, termFrozenFileName, data)
}

// WriteCastSnapshot 把会话回放 cast 文本写入单文件快照（P-20261004-103）。
// 调用方契约：data 已完成敏感值兜底遮蔽（mask.MaskText 链，快照本体即净本）；
// nativeToken 必须是 CastNativeToken 派生值（调用方保证，目录名无注入面）。
// 同 token 重复写入 = 覆盖（重分享可跟进录制内容），兼作副本丢失修复通道；
// 体积/总量护栏与落盘原语同 WriteTermFrozenSnapshot（同一 SnapshotsRoot
// 隔离区同一清账通道）
func WriteCastSnapshot(nativeToken string, data []byte) error {
	return writeSingleFileSnapshot(nativeToken, castFileName, data)
}

// WriteSessionSnapshot 把会话回放的条目快照 JSON 写入单文件快照
// （P-20261003-77）。调用方契约：data 是已完成 P-108 敏感值遮蔽的条目序列
// （快照本体即净本，访客面零二次处理）；nativeToken 必须是 SessionNativeToken
// 派生值（调用方保证，目录名无注入面）。同 token 重复写入 = 覆盖（重分享
// 跟进会话新增回合），兼作副本丢失修复通道；体积/总量护栏与落盘原语同
// WriteTermFrozenSnapshot（同一 SnapshotsRoot 隔离区同一清账通道）
func WriteSessionSnapshot(nativeToken string, data []byte) error {
	return writeSingleFileSnapshot(nativeToken, sessionFileName, data)
}

// writeSingleFileSnapshot 单文件快照写入原语（term-frozen/cast 两形态共用）：
// 体积护栏 + 总量预算 + 临时文件同目录 rename。fileName 是固定常量（调用方
// 保证，无路径注入面）
func writeSingleFileSnapshot(nativeToken, fileName string, data []byte) error {
	if len(data) > MaxFrozenBytes {
		return ErrFrozenTooLarge
	}
	snapMu.Lock()
	defer snapMu.Unlock()

	destDir := snapshotDir(nativeToken)
	// 总量预算：既有快照总量 + 本次写入量（目录级个位数，WalkDir 成本可忽略）
	used, err := dirTotalBytes(SnapshotsRoot(), destDir)
	if err != nil {
		return err
	}
	if used+int64(len(data)) > MaxFrozenTotalBytes {
		return ErrFrozenQuota
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(destDir, ".frozen-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		// 同目录 rename 三平台原子（Windows 走 MoveFileEx REPLACE_EXISTING，
		// Go 运行时已兜覆盖语义）——不先删旧件，避开「删后崩」的空窗
		err = os.Rename(tmpName, filepath.Join(destDir, fileName))
	}
	if err != nil {
		_ = os.Remove(tmpName) // 半成品临时件不留盘
		return err
	}
	return nil
}

// GcOrphanSnapshots 孤儿快照对账：删除 keep 集合之外的快照目录。keep 由
// 装配层从存活冻结记录重算（FrozenNativeToken 是零代际值，轮换记录同样
// 命中）——本函数只信 keep，不查记录。keep 为 nil 视为调用方事故（List
// 失败等），拒绝清账防误删全库；空 map 是合法「无冻结分享」，清光孤儿。
// 返回删除的目录数
func GcOrphanSnapshots(keep map[string]bool) (int, error) {
	if keep == nil {
		return 0, errors.New("share: gc skipped, keep set unavailable")
	}
	snapMu.Lock()
	defer snapMu.Unlock()
	entries, err := os.ReadDir(SnapshotsRoot())
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	for _, e := range entries {
		if keep[e.Name()] {
			continue
		}
		// 原地刷新（P-20261005-177）的暂存目录不在 keep 集（记录只锚正身
		// 目录名），但它是在途刷新的中间产物而非孤儿——扫走会把进行中的
		// 刷新拦腰折断（promote 阶段如实报错、旧副本完好，不至损数据，
		// 但刷新永远差最后一步）。跳过；残留由下次 Stage 的预清理收口
		if strings.HasSuffix(e.Name(), frozenStagingSuffix) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(SnapshotsRoot(), e.Name())); err != nil {
			slog.Warn("share: gc orphan snapshot failed", "dir", e.Name(), "err", err)
			continue
		}
		removed++
	}
	return removed, nil
}

// SnapshotUsage 快照库占用统计（P-20261005-176）：总量 + 逐目录字节量
// （map 键 = 快照目录名 = 零代际派生 token）。管理列表端点随取随算——
// 管理面低频读、目录个位数，逐树 WalkDir 与创建路径的预算遍历同原语同
// 量级；持 snapMu 与复制/删除串行（不计入在途复制的半份快照，瞬时值
// 恒为一致快照）。符号链接不跟随（dirTotalBytes 同纪律）；快照根不存在
// = 零占用（从未冻结过，非错误）。总量口径与创建护栏的预算一致（整棵
// SnapshotsRoot，含 TTL 未清的孤儿残壳——占用治理看到的就该是真实盘上量）
func SnapshotUsage() (int64, map[string]int64, error) {
	snapMu.Lock()
	defer snapMu.Unlock()
	root := SnapshotsRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, map[string]int64{}, nil
		}
		return 0, nil, err
	}
	perToken := make(map[string]int64, len(entries))
	var total int64
	for _, e := range entries {
		if !e.IsDir() {
			continue // 快照根下只应有目录；零散文件非快照不计入
		}
		used, err := dirTotalBytes(filepath.Join(root, e.Name()), "")
		if err != nil {
			return 0, nil, err
		}
		perToken[e.Name()] = used
		total += used
	}
	return total, perToken, nil
}

// dirTotalBytes 目录树字节总量（不跟随符号链接；missing 目录 = 0）。
// skip 目录跳过不计（创建路径用它排除本次目标目录的旧残壳）
func dirTotalBytes(dir, skip string) (int64, error) {
	total := int64(0)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipAll
			}
			return nil // 单条目不可读不阻断预算（尽力而为的上界估计）
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		// skip 目录整棵剪枝（先于 IsDir 分支——SkipDir 只对目录生效）
		if skip != "" && p == skip {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		if fi, ierr := d.Info(); ierr == nil {
			total += fi.Size()
		}
		return nil
	})
	return total, err
}
