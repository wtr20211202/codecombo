package diagnostics

import (
	"encoding/json"
	"runtime/pprof"
	"sync"
	"time"

	"codecombo/server/metrics"
)

// 停顿看门狗（P-20261124-1 S1③）：1s ticker 同时记「墙钟 delta」与「单调钟
// delta」——两者差值 >1s 说明进程被整体暂停（VM suspend / 宿主睡眠：单调钟
// 在 Linux CLOCK_MONOTONIC 与 Windows QPC 上都停走，墙钟继续走），而两侧
// 同时 ≥2s 才是进程内真停顿（GC、调度饥饿、磁盘 IO 阻塞）。
//
// 为什么在进程内而不是只靠日志 gap：gin 的访问日志时间戳取 c.Next() 之后，
// 「144s 没有完成行」既可能是没请求，也可能是请求开始了但没完成——看门狗给出
// 独立的 wall/mono 证据面（proposals P-20261124-1 动因①）。
//
// 证据纪律：
//   - 停顿时不写盘（写盘本身可能是停顿原因，且 stall 期间写盘会放大故障）；
//     环形只在内存，导出时才落 state/stalls.json；
//   - ≥10s 才抓 goroutine 聚合栈（pprof debug=1，天然按调用栈聚合），≤1MiB，
//     内存环 ≤3 份、10 分钟最多 1 次；抓取前不持锁（pprof 会短暂 STW）；
//   - 栈文本过 Redactor.Line（构建路径归一），不声称不含 token——只做已知
//     路径/敏感值遮蔽；
//   - in-flight 取 middleware.Metrics 的既有 gauge（不新造全量计时中间件）。

const (
	// watchdogInterval 采样间隔
	watchdogInterval = time.Second
	// stallThreshold 记一条 stall 的最小墙钟延迟
	stallThreshold = 2 * time.Second
	// goroutineStallThreshold 抓 goroutine 栈的最小延迟
	goroutineStallThreshold = 10 * time.Second
	// stallRingCapacity stalls.json 条目上限
	stallRingCapacity = 32
	// goroutineRingCapacity 内存中 goroutine 栈份数上限
	goroutineRingCapacity = 3
	// goroutineMinInterval 两次抓栈的最小间隔
	goroutineMinInterval = 10 * time.Minute
	// goroutineMaxBytes 单份栈文本上限
	goroutineMaxBytes = 1 << 20
	// inflightGaugeName 复用 middleware.Metrics 的 in-flight gauge
	inflightGaugeName = "sc_http_inflight"
)

// StallRecord 单次停顿（state/stalls.json 条目）
type StallRecord struct {
	// StartedAt 上次采样时刻（停顿窗口起点近似）
	StartedAt string `json:"startedAt"`
	// EndedAt 本次采样时刻
	EndedAt string `json:"endedAt"`
	// DurationMS 墙钟延迟（用户实际感受到的卡顿时长）
	DurationMS int64 `json:"durationMs"`
	// MonoDeltaMS 单调钟延迟（进程实际被调度的时间；与 wall 差值即挂起量）
	MonoDeltaMS int64 `json:"monoDeltaMs"`
	// InflightAtStart/End 停顿窗口两端的在途请求数（Metrics gauge）
	InflightAtStart int `json:"inflightAtStart"`
	InflightAtEnd   int `json:"inflightAtEnd"`
	// Suspect suspend（墙钟远大于单调钟）| stall（两侧同步延迟）
	Suspect string `json:"suspect"`
}

// GoroutineDump 一份 goroutine 聚合栈（导出为 state/goroutine-stalls-*.txt）
type GoroutineDump struct {
	CapturedAt string `json:"capturedAt"`
	// TriggerMS 触发抓取的停顿延迟
	TriggerMS int64  `json:"triggerMs"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
	Text      string `json:"-"`
}

// WatchdogState 看门狗内存快照（Plan 渲染用）
type WatchdogState struct {
	Running        bool
	StartedAt      time.Time
	Ticks          int64
	MaxWallDeltaMS int64
	MaxMonoDeltaMS int64
	Stalls         []StallRecord
	Dumps          []GoroutineDump
	LastCaptureAt  time.Time
	SampleErr      string
	interval       time.Duration
}

// watchdog 看门狗实例（只读 /proc 之外没有任何平台依赖，三平台可运行）
type watchdog struct {
	stop chan struct{}
	done chan struct{}
	red  *Redactor

	mu           sync.Mutex
	started      time.Time
	ticks        int64
	maxWallDelta time.Duration
	maxMonoDelta time.Duration
	stalls       []StallRecord
	dumps        []GoroutineDump
	lastCapture  time.Time
	capturing    bool
}

var watchdogState struct {
	mu sync.Mutex
	w  *watchdog
}

// StartWatchdog 启动看门狗（幂等）。dataDir 仅用于栈文本路径归一。
// app 生命周期拉起；CLI 采集进程不启动（导出时 status=skipped）。
func StartWatchdog(dataDir string) {
	watchdogState.mu.Lock()
	defer watchdogState.mu.Unlock()
	if watchdogState.w != nil {
		return
	}
	w := &watchdog{
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		red:     NewRedactor(dataDir, false),
		started: time.Now(),
	}
	watchdogState.w = w
	go w.run()
}

// StopWatchdog 停止看门狗（幂等；测试/进程退出用）
func StopWatchdog() {
	watchdogState.mu.Lock()
	w := watchdogState.w
	watchdogState.w = nil
	watchdogState.mu.Unlock()
	if w == nil {
		return
	}
	close(w.stop)
	<-w.done
}

func stopWatchdogForTesting() { StopWatchdog() }

// run 采样循环：ticker 是唯一时间驱动，ticker 触发延迟本身就是被测对象
func (w *watchdog) run() {
	defer close(w.done)
	t := time.NewTicker(watchdogInterval)
	defer t.Stop()

	lastMono := time.Now()
	lastWall := lastMono.Round(0) // Round(0) 剥掉单调钟读数
	inflightLast := int(metrics.GaugeValue(inflightGaugeName))
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			nowMono := time.Now()
			nowWall := nowMono.Round(0)
			monoDelta := nowMono.Sub(lastMono)
			wallDelta := nowWall.Sub(lastWall)
			inflightNow := int(metrics.GaugeValue(inflightGaugeName))

			w.mu.Lock()
			w.ticks++
			if wallDelta > w.maxWallDelta {
				w.maxWallDelta = wallDelta
			}
			if monoDelta > w.maxMonoDelta {
				w.maxMonoDelta = monoDelta
			}
			// 墙钟落后 >=2s 记一条 stall（挂起也走这里：用户感知是同一个卡顿）
			if wallDelta >= stallThreshold {
				suspect := "stall"
				if wallDelta-monoDelta > time.Second {
					suspect = "suspend"
				}
				rec := StallRecord{
					StartedAt:       lastWall.Format(time.RFC3339Nano),
					EndedAt:         nowWall.Format(time.RFC3339Nano),
					DurationMS:      wallDelta.Milliseconds(),
					MonoDeltaMS:     monoDelta.Milliseconds(),
					InflightAtStart: inflightLast,
					InflightAtEnd:   inflightNow,
					Suspect:         suspect,
				}
				w.pushStallLocked(rec)
			}
			needDump := wallDelta >= goroutineStallThreshold
			trigger := wallDelta
			canDump := false
			if needDump && !w.capturing && nowWall.Sub(w.lastCapture) >= goroutineMinInterval {
				w.capturing = true
				canDump = true
			}
			w.mu.Unlock()

			// 不持锁抓栈：pprof 会短暂 STW，且写缓冲是纯 CPU
			if canDump {
				w.captureGoroutines(trigger, nowWall)
			}

			lastMono = nowMono
			lastWall = nowWall
			inflightLast = inflightNow
		}
	}
}

// pushStallLocked 覆盖式入环（调用方持锁）
func (w *watchdog) pushStallLocked(rec StallRecord) {
	if len(w.stalls) >= stallRingCapacity {
		copy(w.stalls, w.stalls[1:])
		w.stalls[len(w.stalls)-1] = rec
		return
	}
	w.stalls = append(w.stalls, rec)
}

// captureGoroutines 抓 pprof goroutine 聚合栈（debug=1）并做路径归一；
// 内存环 ≤3 份，超限丢最旧
func (w *watchdog) captureGoroutines(trigger time.Duration, at time.Time) {
	buf := &limitedBuffer{limit: goroutineMaxBytes}
	if p := pprof.Lookup("goroutine"); p != nil {
		_ = p.WriteTo(buf, 1) // debug=1：按调用栈聚合（相同栈合并计数）
	}
	text := w.red.Line(buf.String())
	dump := GoroutineDump{
		CapturedAt: at.Format(time.RFC3339),
		TriggerMS:  trigger.Milliseconds(),
		Bytes:      len(text),
		Truncated:  buf.truncated,
		Text:       text,
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.capturing = false
	w.lastCapture = at
	if len(w.dumps) >= goroutineRingCapacity {
		copy(w.dumps, w.dumps[1:])
		w.dumps[len(w.dumps)-1] = dump
		return
	}
	w.dumps = append(w.dumps, dump)
}

// limitedBuffer 只保留前 limit 字节的 io.Writer（pprof 无法设置上限，
// 1MiB 是「聚合栈足够读、又不会把诊断包撑爆」的折中）
type limitedBuffer struct {
	limit     int
	data      []byte
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(b.data) >= b.limit {
		b.truncated = true
		return len(p), nil
	}
	room := b.limit - len(b.data)
	if len(p) > room {
		b.data = append(b.data, p[:room]...)
		b.truncated = true
		return len(p), nil
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *limitedBuffer) String() string { return string(b.data) }

// WatchdogSnapshot 取看门狗快照（未启动 = Running=false）
func WatchdogSnapshot() WatchdogState {
	watchdogState.mu.Lock()
	w := watchdogState.w
	watchdogState.mu.Unlock()
	if w == nil {
		return WatchdogState{}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	snap := WatchdogState{
		Running:        true,
		StartedAt:      w.started,
		Ticks:          w.ticks,
		MaxWallDeltaMS: w.maxWallDelta.Milliseconds(),
		MaxMonoDeltaMS: w.maxMonoDelta.Milliseconds(),
		LastCaptureAt:  w.lastCapture,
		interval:       watchdogInterval,
	}
	snap.Stalls = append(snap.Stalls, w.stalls...)
	snap.Dumps = append(snap.Dumps, w.dumps...)
	return snap
}

// stallsDoc state/stalls.json 顶层结构
type stallsDoc struct {
	GeneratedAt    string        `json:"generatedAt"`
	Status         string        `json:"status"` // ok | skipped
	Reason         string        `json:"reason,omitempty"`
	StartedAt      string        `json:"startedAt,omitempty"`
	IntervalMS     int64         `json:"intervalMs,omitempty"`
	Ticks          int64         `json:"ticks,omitempty"`
	MaxWallDeltaMS int64         `json:"maxWallDeltaMs,omitempty"`
	MaxMonoDeltaMS int64         `json:"maxMonoDeltaMs,omitempty"`
	StallCount     int           `json:"stallCount"`
	GoroutineDumps int           `json:"goroutineDumps"`
	Stalls         []StallRecord `json:"stalls"`
	Note           string        `json:"note"`
}

// renderStallsJSON state/stalls.json 渲染（未启动写 skipped 而不是空对象——
// 读者不用猜「0 次停顿」还是「没采」）
func renderStallsJSON(now time.Time, red *Redactor) string {
	snap := WatchdogSnapshot()
	doc := stallsDoc{
		GeneratedAt: now.Format(time.RFC3339),
		Stalls:      []StallRecord{},
		Note: "watchdog samples wall and monotonic clocks every 1s; suspend=wall clock advanced far more than the monotonic clock (VM/host pause), " +
			"stall=both advanced together (in-process blocking). Goroutine profiles (>=10s stalls) are packed as state/goroutine-stalls-*.txt",
	}
	if !snap.Running {
		doc.Status = "skipped"
		doc.Reason = "in-process watchdog runs only inside the service; offline CLI collection cannot observe the live process"
		buf, _ := json.MarshalIndent(doc, "", "  ")
		return string(buf) + "\n"
	}
	doc.Status = "ok"
	doc.StartedAt = snap.StartedAt.Format(time.RFC3339)
	doc.IntervalMS = snap.interval.Milliseconds()
	doc.Ticks = snap.Ticks
	doc.MaxWallDeltaMS = snap.MaxWallDeltaMS
	doc.MaxMonoDeltaMS = snap.MaxMonoDeltaMS
	doc.StallCount = len(snap.Stalls)
	doc.GoroutineDumps = len(snap.Dumps)
	doc.Stalls = append(doc.Stalls, snap.Stalls...)
	_ = red // 停顿记录本身只有时间/计数/枚举，无自由文本
	buf, _ := json.MarshalIndent(doc, "", "  ")
	return string(buf) + "\n"
}
