package kernel

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// JobInfo 单个后台任务的注册清单观测形态（P-20261003-276 运维可见面：
// 「后台都在跑什么」可查），Jobs() 快照返回。
type JobInfo struct {
	Name     string        // 注册名（语言中立，如 disk-watch / agentcron-scheduler）
	Interval time.Duration // 触发间隔
	LastRun  time.Time     // 最近触发时刻；零值 = 注册后尚未到点
}

// jobEntry 单任务注册态：interval 注册时定格供清单展示，lastRun 由任务
// goroutine 每次到点盖章（触发时刻而非完成时刻——与 cron 语义一致）
type jobEntry struct {
	interval time.Duration
	lastRun  time.Time
}

// Scheduler 后台定时任务托管：替代散落各处的 `go func(){ ticker … }()`，
// 统一具备三个此前缺失的性质——可停（Stop 取消全部任务）、可等待（退出确定性）、
// 可观测（每个任务有名字，panic 带名字记录且不拖垮调度器）。
type Scheduler struct {
	logger *slog.Logger

	mu     sync.Mutex
	jobs   map[string]*jobEntry // name -> 注册态（防重名 + 清单观测）
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewScheduler 创建调度器
func NewScheduler(logger *slog.Logger) *Scheduler {
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Scheduler{
		logger: logger,
		jobs:   make(map[string]*jobEntry),
		ctx:    ctx,
		cancel: cancel,
	}
}

// AddTicker 注册命名定时任务。interval <= 0 或重名返回 false（不注册）。
// fn 在独立 goroutine 中按周期执行；Stop 后保证不再触发新执行，
// 正在执行中的 fn 结束后 AddTicker 返回的调度器才算完全停止（Stop 阻塞等待）。
func (s *Scheduler) AddTicker(name string, interval time.Duration, fn func(ctx context.Context)) bool {
	if interval <= 0 || fn == nil {
		return false
	}
	s.mu.Lock()
	if s.jobs[name] != nil {
		s.mu.Unlock()
		return false
	}
	if s.jobs == nil {
		s.jobs = make(map[string]*jobEntry)
	}
	s.jobs[name] = &jobEntry{interval: interval}
	s.mu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			if r := recover(); r != nil {
				s.logger.Error("scheduler: job panicked", "job", name, "panic", r)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
				s.stampRun(name)
				func() {
					defer func() {
						if r := recover(); r != nil {
							s.logger.Error("scheduler: job panicked", "job", name, "panic", r)
						}
					}()
					fn(s.ctx)
				}()
			}
		}
	}()
	return true
}

// Stop 取消全部任务并等待正在执行的 fn 退出。幂等：重复调用为 no-op。
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if s.cancel == nil {
		s.mu.Unlock()
		return
	}
	s.cancel()
	s.cancel = nil
	s.mu.Unlock()
	s.wg.Wait()
}

// stampRun 任务到点触发时盖章 lastRun（清单观测面的「上次运行」）。
// 任务条目永不删除（注册表与调度器同生命周期），查无属竞态防御。
func (s *Scheduler) stampRun(name string) {
	s.mu.Lock()
	if e := s.jobs[name]; e != nil {
		e.lastRun = time.Now()
	}
	s.mu.Unlock()
}

// Jobs 返回当前注册任务清单快照（任务名升序）。只读观测面——供运维端点
// GET /api/system/scheduler 与值班大屏健康卡消费（P-20261003-276），
// 刻意不携带启停入口（启停面大，见提案注记）。Stop 后清单保留最后状态
//（含各任务 lastRun），供停机前排查。
func (s *Scheduler) Jobs() []JobInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]JobInfo, 0, len(s.jobs))
	for name, e := range s.jobs {
		out = append(out, JobInfo{Name: name, Interval: e.interval, LastRun: e.lastRun})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
