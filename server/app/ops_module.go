package app

import (
	"context"
	"log/slog"
	"runtime"
	"time"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/metrics"
	"codecombo/server/store"
)

// runtimeOpsModule 进程级运维模块：锁清理循环 / auto-fetch / 内存水位观测。
// 这些关注点属于组合根自身的运行时维护面，不归属任何业务领域包，
// 因此以模块形式声明在 app 包（roadmap M2.3：装配顺序声明化——
// 组合根不再保留裸 goroutine，全部生命周期经内核驱动）
type runtimeOpsModule struct {
	cfg *config.Config
	k   kernel.Kernel

	lockStop    chan struct{}
	fetchCancel context.CancelFunc
}

func newRuntimeOpsModule(cfg *config.Config) *runtimeOpsModule {
	return &runtimeOpsModule{cfg: cfg}
}

func (m *runtimeOpsModule) Name() string        { return "runtime-ops" }
func (m *runtimeOpsModule) DependsOn() []string { return nil }

// Init 启动引导写操作：本机实例登记（走 Store 统一数据访问）。
// 锁配置不再自动写入默认 admin 密码——首次启动保持无配置状态，
// 由前端引导完成 POST /api/lock/setup（安全 backlog A3）
func (m *runtimeOpsModule) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if _, err := store.Get().Instance.GetLocal(m.cfg.Server.Port); err != nil {
		slog.Warn("failed to init local instance", "err", err)
	}
	return nil
}

// Start 拉起三个进程级后台任务：全局锁过期清理循环、auto-fetch（可选）、
// 内存水位观测（内核调度器托管，Stop 统一取消）
func (m *runtimeOpsModule) Start(_ context.Context, k kernel.Kernel) error {
	// 全局锁定：1 分钟扫一遍过期 unlock token + 关联 WS 连接
	m.lockStop = make(chan struct{})
	go store.Get().Lock.StartCleanupLoop(m.lockStop)

	// Auto-fetch 后台任务
	if m.cfg.Server.AutoFetch {
		interval := m.cfg.Server.FetchInterval
		if interval <= 0 {
			interval = 300
		}
		fetchCtx, cancel := context.WithCancel(context.Background())
		m.fetchCancel = cancel
		go startAutoFetch(fetchCtx, time.Duration(interval)*time.Second)
	}

	// 内存水位观测（决策门 M5.2）：每小时记录一次堆/系统内存——长会话场景
	// 曾观测到 1.58GB 工作集，先建立时间序列再决定是否定向排查
	k.Scheduler().AddTicker("memory-watch", time.Hour, memoryWatch)

	// 总线事件吞吐计数（metrics 出口）：wildcard 订阅，按 topic 计数
	k.Events().Subscribe("*", func(env kernel.Envelope) {
		metrics.IncCounter("sc_bus_events_published_total", "topic", env.Topic)
	})
	return nil
}

// Stop 停止锁清理循环与 auto-fetch（调度器任务由内核 StopAll 统一取消）
func (m *runtimeOpsModule) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.lockStop != nil {
		close(m.lockStop)
		m.lockStop = nil
	}
	if m.fetchCancel != nil {
		m.fetchCancel()
		m.fetchCancel = nil
	}
	return nil
}

// memoryWatch 每小时记录一次进程内存水位与 goroutine 数
func memoryWatch(context.Context) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	slog.Info("memory watermark",
		"heapAllocMB", ms.HeapAlloc/1024/1024,
		"sysMB", ms.Sys/1024/1024,
		"numGC", ms.NumGC,
		"goroutines", runtime.NumGoroutine(),
	)
}
