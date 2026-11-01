package system

import (
	"runtime"
	"time"

	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 本机体检趋势历史（P-20261005-169）：P-317 体检是按需单次，本机这个最关键
// 的主机反而无跨天趋势（远程主机有 diaghist 环比，P-20261002-18）。三条链路：
//   - 每日定时入账：module.go 的 selfcheck-snapshot 分钟巡检（日报同款调度
//     惯例——「今日未快照」即补；当日与否从已落盘的最新快照日期判定，重启
//     追赶零额外内存标记）
//   - 手动体检入账：GET /api/selfcheck 每次随体检落一条（快照密度自然，任务书④）
//   - 读取：GET /api/selfcheck 响应内联 hist（远程诊断 compare 内联同款，
//     前端免二次请求；agent 趋势数值同端点可读）
//
// 存储形态：store/selfcheckhist.go 独立 kind（DiagSnapshot 无会话/终端字段，
// 同 kind 塞「(local)」键要靠读取方逐处规避，独立 kind 天然互斥）。

// collectSelfCheckSnapshot 从既有内存/探测面提取本机数值快照。全程零子进程：
// 磁盘走 diskVolumes 既有探测（P-12 同源，sysinfo 平台分支），内存/goroutine
// 走 runtime，会话/终端数走终端管理器计数——每日链路在调度器专属 goroutine
// 串行执行，不与请求路径争抢
func collectSelfCheckSnapshot() store.SelfCheckSnapshot {
	snap := store.SelfCheckSnapshot{
		Terminals:  len(terminal.DefaultManager.ListSessions()),
		Goroutines: runtime.NumGoroutine(),
	}
	snap.ActiveSessions, _, _ = terminal.DefaultManager.RunningCount("")
	// 磁盘取数据盘（DataDir 所在卷）——数据面落盘能力所在的卷，与 disk 体检
	// 条目同源；不可观测（挂载抖动/权限）保持零值哨兵，消费方隐藏该指标
	for _, v := range diskVolumes() {
		if v.Role == diskRoleData {
			snap.DiskAvailMB = int64(v.TotalMB - v.UsedMB)
			snap.DiskTotalMB = int64(v.TotalMB)
			break
		}
	}
	// 内存取进程堆（heapAlloc）：系统级内存 win/mac/linux 各一套读取分支，
	// 而本机趋势关心的是实例自身退化——进程口径与 /api/system/health 同源
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	snap.MemUsedMB = int64(ms.HeapAlloc / 1024 / 1024)
	return snap
}

// selfCheckCollect 提取口变量化供单测注入确定值（selfCheckProbeTimeout 同款
// 惯例）：真实链路恒指向 collectSelfCheckSnapshot
var selfCheckCollect = collectSelfCheckSnapshot

// maybeSelfCheckDailySnapshot 每日定时链路：今天还没快照过就补一条。跨重启
// 去重不设内存标记——最新快照的日期就是答案（日报 checkedOn + 通知扫描的
// 同款问题，这里数据面自带答案）。返回是否入账（单测断言用）
func maybeSelfCheckDailySnapshot(now time.Time) bool {
	s := store.Get()
	if s == nil {
		return false
	}
	if latest, ok := s.SelfCheckHist.Latest(); ok && sameLocalDate(latest.Time, now) {
		return false
	}
	s.SelfCheckHist.Append(selfCheckCollect())
	return true
}

// sameLocalDate 两个时刻是否同一天（服务器本地时区——日报存档日期派生同口径，
// 跨日零点边界两处判定天然一致）
func sameLocalDate(a, b time.Time) bool {
	ay, am, ad := a.Local().Date()
	by, bm, bd := b.Local().Date()
	return ay == by && am == bm && ad == bd
}

// selfCheckHistInfo GET /api/selfcheck 响应内联的趋势面：latest=本次快照
// （恒有），prev/delta=与上一次的对比（首次体检无历史时缺省，前端隐藏趋势条），
// runs=环形窗内总次数。远程诊断 diagCompare 内联同构，前端零新请求
type selfCheckHistInfo struct {
	Runs   int                      `json:"runs"`
	Latest store.SelfCheckSnapshot  `json:"latest"`
	Prev   *store.SelfCheckSnapshot `json:"prev,omitempty"`
	Delta  *store.SelfCheckDelta    `json:"delta,omitempty"`
}

// recordSelfCheckSnapshot 手动体检入账 + 组装对比面：读上一次 → 入账本次 →
// 组装。读在写前——prev 的语义是「本次之前最近一次」，快速连击也按真实先后
// 各自入账。Append 尽力而为（失败仅日志），绝不阻断体检响应
func recordSelfCheckSnapshot() selfCheckHistInfo {
	snap := selfCheckCollect()
	info := selfCheckHistInfo{Latest: snap}
	s := store.Get()
	if s == nil {
		return info
	}
	if p, ok := s.SelfCheckHist.Latest(); ok {
		prev := p
		d := store.DiffSelfCheckSnapshot(prev, snap)
		info.Prev = &prev
		info.Delta = &d
	}
	s.SelfCheckHist.Append(snap)
	info.Runs = len(s.SelfCheckHist.History(0))
	return info
}
