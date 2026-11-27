package diagnostics

import (
	"encoding/json"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"sync"
	"time"
)

// Go 运行时快照 + 服务生命周期趋势环（P-20261126-3 S1）：性能取证此前对
// GC 统计/堆趋势/协程堆积零覆盖（MemStats 只在 selfcheck 每日历史取了一个
// HeapAlloc）——本文件回答「为什么慢」的第一类现场：GC 风暴、内存泄漏、
// goroutine 泄漏/堆积发生在什么时间点（与 stalls 时间线对时）。
//
// 生命周期与纪律（复用 hosthistory 的幂等 Start/Stop 与内存环形态）：
//   - Start/Stop 由 app 组合根拉起；CLI 采集进程不启动（趋势段写 skipped）；
//   - 纯标准库（runtime/debug/pprof.Lookup），三平台一致，零子进程；
//   - ReadMemStats 会短暂 STW——60s 采样间隔远低于可感知阈值（selfcheck
//     按需调用是先例），且不在请求热路径；
//   - 采样不持锁读、只锁追加、不写盘；趋势里 PauseTotal 用**增量**（绝对值
//     单调增长不可比），首点 baselineWarmup=true。

const (
	// goRuntimeInterval 趋势采样间隔
	goRuntimeInterval = 60 * time.Second
	// goRuntimeCapacity 2 小时点数（120 × 60s）
	goRuntimeCapacity = 120
)

// GoRuntimePoint 趋势环单点（内存字段 MB，一位小数——趋势量级口径）
type GoRuntimePoint struct {
	At string `json:"at"`
	// HeapAllocMB/HeapSysMB/SysMB 内存三个口径：存活堆/保留堆/进程总虚拟
	HeapAllocMB float64 `json:"heapAllocMb,omitempty"`
	HeapSysMB   float64 `json:"heapSysMb,omitempty"`
	SysMB       float64 `json:"sysMb,omitempty"`
	// NumGoroutine 协程数（泄漏/堆积趋势）
	NumGoroutine int `json:"numGoroutine,omitempty"`
	// PauseTotalMsDelta GC 暂停总时长**增量**（GC 风暴=单点突增；绝对值单调不可比）
	PauseTotalMsDelta float64 `json:"pauseTotalMsDelta,omitempty"`
	// BaselineWarmup 首点无 PauseTotal 前值，增量不可算
	BaselineWarmup bool `json:"baselineWarmup,omitempty"`
}

// GoRuntimeTrend 趋势段（CLI/未启动 = skipped，理由如实）
type GoRuntimeTrend struct {
	Status     string           `json:"status"` // ok | skipped
	Reason     string           `json:"reason,omitempty"`
	IntervalMS int64            `json:"intervalMs,omitempty"`
	Capacity   int              `json:"capacity,omitempty"`
	Count      int              `json:"count"`
	Points     []GoRuntimePoint `json:"points"`
	Skipped    []string         `json:"skippedFields,omitempty"`
}

// GoRuntimeDoc state/goruntime.json：快照段 + 趋势段
type GoRuntimeDoc struct {
	GeneratedAt string `json:"generatedAt"`
	// Status 整段结局：ok（api/服务进程）| skipped（CLI——快照是采集器自身进程
	// 的，对排障目标进程无意义，scope 字段注明）
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	// Scope 快照归属：service-process（api 形态）| collector-process（CLI 形态，
	// 不是被诊断的服务——读者不得把这两个数当服务状态）
	Scope string `json:"scope,omitempty"`
	// GoVersion/GOMAXPROCS/NumGoroutine/NumOSThreads 运行时基线
	GoVersion    string `json:"goVersion"`
	GOMAXPROCS   int    `json:"gomaxprocs"`
	NumGoroutine int    `json:"numGoroutine"`
	// NumOSThreads runtime 创建的 OS 线程数（threadcreate profile 计数；
	// 与 OS 总线程数有差——非 Go 线程不在内，OS 口径见 host.json process 段）
	NumOSThreads int `json:"numOSThreads,omitempty"`
	// MemStats 关键子集（原始字节口径）
	HeapAllocBytes    int64  `json:"heapAllocBytes"`
	HeapSysBytes      int64  `json:"heapSysBytes"`
	HeapIdleBytes     int64  `json:"heapIdleBytes,omitempty"`
	HeapReleasedBytes int64  `json:"heapReleasedBytes,omitempty"`
	SysBytes          int64  `json:"sysBytes"`
	NextGCBytes       int64  `json:"nextGcBytes,omitempty"`
	HeapObjects       uint64 `json:"heapObjects"`
	// GC 统计（debug.ReadGCStats：近 256 次暂停的分布基础）
	NumGC         uint32  `json:"numGc"`
	PauseTotalMS  float64 `json:"pauseTotalMs"`
	PauseAvgMS    float64 `json:"pauseAvgMs,omitempty"`
	PauseMaxMS    float64 `json:"pauseMaxMs,omitempty"`
	PauseLastMS   float64 `json:"pauseLastMs,omitempty"`
	GCCPUFraction float64 `json:"gcCpuFraction,omitempty"`
	// 采样率登记（P-20261126-3 S3：启动期 installDiagProfileRates 装的 block/mutex
	// 采样率；未安装=0 且 installed=false——block/mutex 档案因此为空是「没开采样」
	// 而不是「无竞争」，CC_DIAG_PROFILE_RATE=0 全关时同样落这里）
	BlockProfileRate      int  `json:"blockProfileRate,omitempty"`
	MutexProfileFraction  int  `json:"mutexProfileFraction,omitempty"`
	ProfileRatesInstalled bool `json:"profileRatesInstalled,omitempty"`
	// Trend 趋势段
	Trend GoRuntimeTrend `json:"trend"`
	Note  string         `json:"note"`
}

type goRuntimeSampler struct {
	stop chan struct{}
	done chan struct{}
	mu   sync.Mutex
	pts  []GoRuntimePoint
	// lastPauseTotal 增量基准（毫秒；首点前为 0 且 warmup）
	lastPauseTotal float64
	have           bool
}

var goRuntimeState struct {
	mu sync.Mutex
	s  *goRuntimeSampler
}

// StartGoRuntime 启动趋势采样（幂等）。app 生命周期拉起；CLI 不启动。
func StartGoRuntime() {
	goRuntimeState.mu.Lock()
	defer goRuntimeState.mu.Unlock()
	if goRuntimeState.s != nil {
		return
	}
	s := &goRuntimeSampler{stop: make(chan struct{}), done: make(chan struct{})}
	// 启动即**同步**采首点：立刻导出也有首点，且与快照无竞态（放进 goroutine
	// 的话，Start 返回后立刻导出会看到空环——被误读成「服务刚启动没采到」）。
	// ReadMemStats STW 微秒级，启动期一次可接受。
	s.record(time.Now())
	goRuntimeState.s = s
	go s.run()
}

// StopGoRuntime 停止趋势采样（幂等；进程重启即清零——趋势只服务本进程生命周期）
func StopGoRuntime() {
	goRuntimeState.mu.Lock()
	s := goRuntimeState.s
	goRuntimeState.s = nil
	goRuntimeState.mu.Unlock()
	if s == nil {
		return
	}
	close(s.stop)
	<-s.done
}

func (s *goRuntimeSampler) run() {
	defer close(s.done)
	t := time.NewTicker(goRuntimeInterval)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case now := <-t.C:
			s.record(now)
		}
	}
}

// record 采一个趋势点（ReadMemStats 短暂 STW：60s 间隔可接受，selfcheck 先例）
func (s *goRuntimeSampler) record(now time.Time) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	var gc debug.GCStats
	gc.PauseQuantiles = make([]time.Duration, 1) // 只要最近一次暂停，分布看快照段
	debug.ReadGCStats(&gc)
	pt := GoRuntimePoint{
		At:           now.Format(time.RFC3339),
		HeapAllocMB:  mbOf(float64(ms.HeapAlloc)),
		HeapSysMB:    mbOf(float64(ms.HeapSys)),
		SysMB:        mbOf(float64(ms.Sys)),
		NumGoroutine: runtime.NumGoroutine(),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pauseTotalMS := float64(gc.PauseTotal) / float64(time.Millisecond)
	if s.have {
		delta := pauseTotalMS - s.lastPauseTotal
		if delta < 0 {
			delta = 0 // 单调计数防御
		}
		pt.PauseTotalMsDelta = delta
	} else {
		pt.BaselineWarmup = true
	}
	s.lastPauseTotal = pauseTotalMS
	s.have = true
	if len(s.pts) >= goRuntimeCapacity {
		copy(s.pts, s.pts[1:])
		s.pts[len(s.pts)-1] = pt
		return
	}
	s.pts = append(s.pts, pt)
}

// GoRuntimeSnapshot 组装 state/goruntime.json 文档。
// api 形态（service 进程内导出）status=ok + 趋势段；CLI 形态整段 status=skipped
// ——快照段仍然只描述采集器自身进程（scope=collector-process 显式注明），不
// 装作是被诊断的服务。
func GoRuntimeSnapshot(source string) GoRuntimeDoc {
	doc := GoRuntimeDoc{
		GeneratedAt: time.Now().Format(time.RFC3339),
	}
	doc.Trend.Points = []GoRuntimePoint{}
	doc.Note = "snapshot + trend ring answer WHY slow (GC storms / heap growth / goroutine pile-up); " +
		"cross-check stalls.json timestamps for the same window. trend pauseTotalMsDelta is an INCREMENT " +
		"(the absolute counter only ever grows). OS-level process CPU/RSS/handles live in host.json process + host-history.json"
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	var gc debug.GCStats
	// PauseQuantiles len=5 → min/25%/50%/75%/max（ReadGCStats 文档口径）；Pause
	// 容量 1 → 填最近一次暂停（most recent first）
	gc.PauseQuantiles = make([]time.Duration, 5)
	gc.Pause = make([]time.Duration, 1)
	debug.ReadGCStats(&gc)
	doc.GoVersion = runtime.Version()
	doc.GOMAXPROCS = runtime.GOMAXPROCS(0)
	doc.NumGoroutine = runtime.NumGoroutine()
	if tc := pprof.Lookup("threadcreate"); tc != nil {
		doc.NumOSThreads = tc.Count()
	}
	doc.HeapAllocBytes = int64(ms.HeapAlloc)
	doc.HeapSysBytes = int64(ms.HeapSys)
	doc.HeapIdleBytes = int64(ms.HeapIdle)
	doc.HeapReleasedBytes = int64(ms.HeapReleased)
	doc.SysBytes = int64(ms.Sys)
	doc.NextGCBytes = int64(ms.NextGC)
	doc.HeapObjects = ms.HeapObjects
	doc.NumGC = uint32(gc.NumGC)
	doc.PauseTotalMS = float64(gc.PauseTotal) / float64(time.Millisecond)
	if gc.NumGC > 0 {
		doc.PauseAvgMS = doc.PauseTotalMS / float64(gc.NumGC)
	}
	if len(gc.PauseQuantiles) == 5 {
		// 文档口径：[0]=min … [4]=max
		doc.PauseMaxMS = float64(gc.PauseQuantiles[4]) / float64(time.Millisecond)
	}
	if len(gc.Pause) > 0 {
		doc.PauseLastMS = float64(gc.Pause[0]) / float64(time.Millisecond)
	}
	doc.GCCPUFraction = ms.GCCPUFraction
	doc.BlockProfileRate, doc.MutexProfileFraction, doc.ProfileRatesInstalled = ProfileSamplingRates()

	if source == "cli" {
		doc.Status = "skipped"
		doc.Scope = "collector-process"
		doc.Reason = "offline CLI collection: these runtime figures describe the COLLECTOR process, not the " +
			"diagnosed service — do not read them as service state; start the service and export via " +
			"GET /api/system/diagnostics/export for service-process figures"
		doc.Trend.Status = "skipped"
		doc.Trend.Reason = "trend sampler is started by the service lifecycle only (offline CLI does not start it)"
		return doc
	}
	doc.Status = "ok"
	doc.Scope = "service-process"
	goRuntimeState.mu.Lock()
	s := goRuntimeState.s
	goRuntimeState.mu.Unlock()
	if s == nil {
		doc.Trend.Status = "skipped"
		doc.Trend.Reason = "trend sampler is started by the service lifecycle only"
		return doc
	}
	s.mu.Lock()
	doc.Trend.Points = append(doc.Trend.Points, s.pts...)
	s.mu.Unlock()
	doc.Trend.Status = "ok"
	doc.Trend.IntervalMS = goRuntimeInterval.Milliseconds()
	doc.Trend.Capacity = goRuntimeCapacity
	doc.Trend.Count = len(doc.Trend.Points)
	return doc
}

// renderGoRuntimeJSON state/goruntime.json 渲染
func renderGoRuntimeJSON(source string) string {
	buf, err := json.MarshalIndent(GoRuntimeSnapshot(source), "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// ResetGoRuntimeForTesting 清空趋势环（仅测试用）
func ResetGoRuntimeForTesting() {
	StopGoRuntime()
	goRuntimeState.mu.Lock()
	goRuntimeState.s = nil
	goRuntimeState.mu.Unlock()
}
