package diagnostics

import (
	"sync"
	"sync/atomic"
	"time"
)

// 日志写盘耗时探针（P-20261124-1 S1④）：所有请求 duration 都不含日志写阻塞
// ——gin 日志行在 c.Next() 之后写，写盘卡住时请求时长看起来正常，日志却整段
// 缺失。2026-11-24 的 144s 间隙很可能就是「请求完成了但日志写盘卡住/被跳过」，
// 这个探针把 waitMs（等 handler 互斥锁）与 writeMs（stderr+文件实际写）分开，
// 导出进 collection-report.logWrite。
//
// 开销纪律：每条日志两次 time.Now（~50ns）+ 原子计数；只有慢样本（wait+write
// ≥10ms）才进环，稳态内存为 0。

const (
	// logWriteRingCapacity 慢写样本环容量
	logWriteRingCapacity = 200
	// logWriteSlowThreshold 入环阈值（低于此值的写盘不可能是故障信号）
	logWriteSlowThreshold = 10 * time.Millisecond
)

// LogWriteSample 一条慢写样本
type LogWriteSample struct {
	At      string `json:"at"`
	WaitMS  int64  `json:"waitMs"`
	WriteMS int64  `json:"writeMs"`
}

var logWriteStats struct {
	mu         sync.Mutex
	seq        int64 // 已执行 Handle/Write 次数（请求 silent 判定用；原子读）
	samples    int64
	slow       []LogWriteSample
	maxWaitMS  int64
	maxWriteMS int64
	totalWait  int64
	totalWrite int64
	bridgeSeq  int64
	bridgeMax  int64
}

// LogWriteSequence 日志写入序列号（请求中间件对比起止值判断「这条请求有没有
// 写出日志行」）
func LogWriteSequence() int64 { return atomic.LoadInt64(&logWriteStats.seq) }

// RecordLogWrite 记一次 handler 写盘（wait = 等锁，write = 实际写）
func RecordLogWrite(wait, write time.Duration) {
	atomic.AddInt64(&logWriteStats.seq, 1)
	logWriteStats.mu.Lock()
	logWriteStats.samples++
	logWriteStats.totalWait += wait.Milliseconds()
	logWriteStats.totalWrite += write.Milliseconds()
	if w := wait.Milliseconds(); w > logWriteStats.maxWaitMS {
		logWriteStats.maxWaitMS = w
	}
	if w := write.Milliseconds(); w > logWriteStats.maxWriteMS {
		logWriteStats.maxWriteMS = w
	}
	if wait+write >= logWriteSlowThreshold {
		s := LogWriteSample{At: time.Now().Format(time.RFC3339Nano), WaitMS: wait.Milliseconds(), WriteMS: write.Milliseconds()}
		if len(logWriteStats.slow) >= logWriteRingCapacity {
			copy(logWriteStats.slow, logWriteStats.slow[1:])
			logWriteStats.slow[len(logWriteStats.slow)-1] = s
		} else {
			logWriteStats.slow = append(logWriteStats.slow, s)
		}
	}
	logWriteStats.mu.Unlock()
}

// RecordLogBridge 记一次 slogWriter 桥接总耗时（含 handler 内 wait+write）。
// 单列口径：桥接 > handler 的差值 = slog 自身分配/调度开销。
func RecordLogBridge(d time.Duration) {
	atomic.AddInt64(&logWriteStats.bridgeSeq, 1)
	ms := d.Milliseconds()
	logWriteStats.mu.Lock()
	if ms > logWriteStats.bridgeMax {
		logWriteStats.bridgeMax = ms
	}
	logWriteStats.mu.Unlock()
}

// LogWriteStats logWrite 段（collection-report 用）
type LogWriteStats struct {
	Samples     int64            `json:"samples"`
	BridgeCall  int64            `json:"bridgeCalls"`
	MaxWaitMS   int64            `json:"maxWaitMs"`
	MaxWriteMS  int64            `json:"maxWriteMs"`
	AvgWaitMS   int64            `json:"avgWaitMs"`
	AvgWriteMS  int64            `json:"avgWriteMs"`
	MaxBridgeMS int64            `json:"maxBridgeMs"`
	RingFull    bool             `json:"ringFull,omitempty"`
	Slow        []LogWriteSample `json:"slowSamples,omitempty"`
	Note        string           `json:"note"`
}

// LogWriteSnapshot 取日志写盘探针快照
func LogWriteSnapshot() LogWriteStats {
	logWriteStats.mu.Lock()
	defer logWriteStats.mu.Unlock()
	snap := LogWriteStats{
		Samples:     logWriteStats.samples,
		BridgeCall:  logWriteStats.bridgeSeq,
		MaxWaitMS:   logWriteStats.maxWaitMS,
		MaxWriteMS:  logWriteStats.maxWriteMS,
		MaxBridgeMS: logWriteStats.bridgeMax,
		RingFull:    len(logWriteStats.slow) >= logWriteRingCapacity,
		Note: "waitMs = time waiting for the log handler mutex; writeMs = stderr+file write. " +
			"Only samples >=10ms are kept. Access-log lines are written AFTER the handler chain, so request durations include this write.",
	}
	if logWriteStats.samples > 0 {
		snap.AvgWaitMS = logWriteStats.totalWait / logWriteStats.samples
		snap.AvgWriteMS = logWriteStats.totalWrite / logWriteStats.samples
	}
	snap.Slow = append(snap.Slow, logWriteStats.slow...)
	return snap
}

func resetLogWriteForTesting() {
	logWriteStats.mu.Lock()
	atomic.StoreInt64(&logWriteStats.seq, 0)
	atomic.StoreInt64(&logWriteStats.bridgeSeq, 0)
	logWriteStats.samples = 0
	logWriteStats.slow = nil
	logWriteStats.maxWaitMS = 0
	logWriteStats.maxWriteMS = 0
	logWriteStats.totalWait = 0
	logWriteStats.totalWrite = 0
	logWriteStats.bridgeMax = 0
	logWriteStats.mu.Unlock()
}
