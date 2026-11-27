package diagnostics

import (
	"encoding/json"
	"sync"
	"time"

	"codecombo/server/metrics"
)

// 宿主时序环（P-20261124-1 S3①b）：state/host-history.json 每 10s 采一次
// loadavg / PSI avg10 / diskstats 增量 / in-flight / 日志写耗时，1 小时 360 点
// 环形——单点 host.json 只能回答「此刻如何」，卡顿复盘需要「什么时候开始变」。
//
// P-20261126-3 S2 起三平台全启：Linux 采 /proc 宿主面；Windows/mac 采进程
// CPU%/RSS（此前「非 Linux 整段 skipped」让主力 Windows 机对自身进程退化一
// 无所知——进程自观测跨平台后不再 skipped，/proc-only 字段用既有 skippedFields
// 列出，不另造机制）。
//
// 生命周期与纪律：
//   - Start/Stop 由 app 组合根拉起；CLI 采集进程不启动（导出写 skipped）；
//   - Linux 只读 /proc，不 spawn df/iostat（避免又一次「探针自己卡死」）；
//     mac 进程面走一次 ps best-effort（2s 超时，失败只丢该点字段）；
//   - 采样不持锁读、只锁追加、不写盘；首点 baselineWarmup=true（磁盘/CPU 增量
//     需要前值，首点没有）。

const (
	// hostHistoryInterval 采样间隔
	hostHistoryInterval = 10 * time.Second
	// hostHistoryCapacity 1 小时点数（360 × 10s）
	hostHistoryCapacity = 360
)

// HostHistoryPoint 单个采样点（缺失字段 omitempty）
type HostHistoryPoint struct {
	At              string  `json:"at"`
	LoadAvg1        float64 `json:"loadAvg1,omitempty"`
	PressureCPU10   float64 `json:"pressureCpuAvg10,omitempty"`
	PressureMem10   float64 `json:"pressureMemAvg10,omitempty"`
	PressureIO10    float64 `json:"pressureIoAvg10,omitempty"`
	DiskReadBytes   int64   `json:"diskReadBytesDelta,omitempty"`
	DiskWriteBytes  int64   `json:"diskWriteBytesDelta,omitempty"`
	Inflight        int     `json:"inflight"`
	LogWriteMaxMS   int64   `json:"logWriteMaxMs,omitempty"`
	LogWriteSamples int64   `json:"logWriteSamples,omitempty"`
	// 进程自观测（P-20261126-3 S2，三平台）：CPU% 是采样间隔差分（单核归一，
	// 可 >100；darwin 用 ps 衰减均值，口径差异见 Note）；RSS 是进程常驻内存
	ProcessCPUPercent float64 `json:"processCpuPercent,omitempty"`
	ProcessRSSMB      float64 `json:"processRssMb,omitempty"`
	// ProcessCPUWarmup CPU% 差分首点（无前值基准）
	ProcessCPUWarmup bool `json:"processCpuWarmup,omitempty"`
	BaselineWarmup   bool `json:"baselineWarmup,omitempty"`
}

// HostHistory state/host-history.json 的结构
type HostHistory struct {
	GeneratedAt   string             `json:"generatedAt"`
	Status        string             `json:"status"` // ok | skipped
	Reason        string             `json:"reason,omitempty"`
	IntervalMS    int64              `json:"intervalMs,omitempty"`
	Capacity      int                `json:"capacity,omitempty"`
	Count         int                `json:"count"`
	Points        []HostHistoryPoint `json:"points"`
	SkippedFields []string           `json:"skippedFields,omitempty"`
	Note          string             `json:"note"`
}

type hostHistory struct {
	stop chan struct{}
	done chan struct{}
	mu   sync.Mutex
	pts  []HostHistoryPoint
}

var hostHistoryState struct {
	mu sync.Mutex
	h  *hostHistory
}

// StartHostHistory 启动采样（幂等）
func StartHostHistory() {
	hostHistoryState.mu.Lock()
	defer hostHistoryState.mu.Unlock()
	if hostHistoryState.h != nil {
		return
	}
	h := &hostHistory{stop: make(chan struct{}), done: make(chan struct{})}
	hostHistoryState.h = h
	go h.run()
}

// StopHostHistory 停止采样（幂等）
func StopHostHistory() {
	hostHistoryState.mu.Lock()
	h := hostHistoryState.h
	hostHistoryState.h = nil
	hostHistoryState.mu.Unlock()
	if h == nil {
		return
	}
	close(h.stop)
	<-h.done
}

func (h *hostHistory) run() {
	defer close(h.done)
	t := time.NewTicker(hostHistoryInterval)
	defer t.Stop()
	// 启动即采一点（若立刻导出也有首点）
	h.sample(time.Now())
	for {
		select {
		case <-h.stop:
			return
		case now := <-t.C:
			h.sample(now)
		}
	}
}

func (h *hostHistory) sample(now time.Time) {
	pt, _ := sampleHostPoint(now)
	// 进程自观测（P-20261126-3 S2，三平台）：CPU% 差分（tracker 共享，host.json
	// process 段同源）+ RSS。darwin 的 ps %cpu 直接透传（tracker 在 darwin 无
	// 累计 CPU 秒原始口）——口径差异由 doc.Note 注明。
	sampleProcessFields(&pt)
	pt.Inflight = int(metrics.GaugeValue(inflightGaugeName))
	lw := LogWriteSnapshot()
	pt.LogWriteMaxMS = lw.MaxWriteMS + lw.MaxWaitMS
	pt.LogWriteSamples = lw.Samples
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.pts) >= hostHistoryCapacity {
		copy(h.pts, h.pts[1:])
		h.pts[len(h.pts)-1] = pt
		return
	}
	h.pts = append(h.pts, pt)
}

// HostHistorySnapshot 快照（未启动 status=skipped；三平台服务进程内均 ok，
// 平台差异走 skippedFields/Note）
func HostHistorySnapshot() HostHistory {
	doc := HostHistory{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Points:      []HostHistoryPoint{},
		Note: "10s sampling, 1h ring; values are guest-side only — host/hypervisor pauses still need host logs. " +
			"Deltas (disk sectors, processCpuPercent) are cumulative-counter differences over the sampling " +
			"interval; the first point is marked baselineWarmup/processCpuWarmup. processCpuPercent is " +
			"single-core normalized (can exceed 100%); on darwin it is ps's DECAYING AVERAGE (not an interval " +
			"delta) and on Windows the OS-level RSS/handles/thread view is in host.json process",
	}
	hostHistoryState.mu.Lock()
	h := hostHistoryState.h
	hostHistoryState.mu.Unlock()
	if h == nil {
		doc.Status = "skipped"
		doc.Reason = "host history sampler is started by the service lifecycle only (offline CLI collection does not start it)"
		return doc
	}
	h.mu.Lock()
	doc.Points = append(doc.Points, h.pts...)
	h.mu.Unlock()
	doc.Status = "ok"
	doc.IntervalMS = hostHistoryInterval.Milliseconds()
	doc.Capacity = hostHistoryCapacity
	doc.Count = len(doc.Points)
	doc.SkippedFields = hostHistorySkippedFields()
	return doc
}

// renderHostHistoryJSON state/host-history.json
func renderHostHistoryJSON() string {
	buf, err := json.MarshalIndent(HostHistorySnapshot(), "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}
