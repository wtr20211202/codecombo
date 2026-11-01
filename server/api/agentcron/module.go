package agentcron

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"codecombo/server/api/terminal"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// minuteTick 巡检周期
const minuteTick = time.Minute

// timeNow 时钟口（单测注入固定时刻）
var timeNow = time.Now

// defaultRunner 包级装配：HTTP「立即试跑」handler 经此取触发链（模块 Start
// 装配、Stop 摘除，与 deploy 的 defaultManager 同惯例）
var defaultRunner *runner

func setDefault(r *runner) { defaultRunner = r }

// runNow 试跑入口（未装配 = 调度器未启动，如实报错）
func runNow(t store.AgentCron) (*terminal.AgentLaunch, error) {
	r := defaultRunner
	if r == nil {
		return nil, errors.New("agentcron: scheduler not started")
	}
	return r.RunNow(t)
}

// Module 定时智能体任务模块（P-20261002-43）：分钟级巡检 store 中的启停任务，
// 到点经 agent 终端创建通道发起会话。服务本身单进程，调度语义即单实例语义；
// 巡检同时负责完成回执监听（AgentTask 落库流只读复用）
type Module struct {
	k kernel.Kernel
	r *runner
	// stopped 停机闸：内核 StopAll 先停模块后停调度器，两者之间 ticker 仍可能
	// 触发 tick——闸住这段窗口（Stop 后不再发起任何会话），runner 本体保留
	//（在途 trigger 不受影响，避免 nil 解引用）
	stopped atomic.Bool
}

// NewModule 创建模块（launch 生产绑定 terminal.LaunchAgentSession；单测经
// newModuleWithLauncher 注入桩）。WithDisplayNameDedup（P-20261023-3）：定时
// 任务显式任务名与存量会话同名时自动步进「·2」——同任务按周期反复调度，
// 未消化的同名会话在侧栏零差异，与派生名消歧同口径
func NewModule() *Module {
	return newModuleWithLauncher(func(name, runtime, dir, launchArgs string) (*terminal.AgentLaunch, error) {
		return terminal.LaunchAgentSession(name, runtime, dir, launchArgs, "", terminal.WithDisplayNameDedup())
	})
}

func newModuleWithLauncher(launch launcher) *Module {
	return &Module{r: newRunner(launch)}
}

func (m *Module) Name() string        { return "agentcron" }
func (m *Module) DependsOn() []string { return nil }

// Init 记录内核引用并校验持久化层可达（装配期暴露配置问题并触发内核启动回滚）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if store.Get() == nil {
		return fmt.Errorf("agentcron: store not assembled")
	}
	return nil
}

// Start 注册分钟级巡检（内核调度器为间隔制，无 cron 表达能力——以分钟巡检 +
// lastRunAt/进程内槽点标记实现「每日 HH:MM 一次、错过可补」，与日报模块的
// 每日门槛+当日去重同范式）。试跑路径（RunNow）经包级 default 装配供 HTTP
// handler 使用
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	setDefault(m.r)
	if !k.Scheduler().AddTicker("agentcron-scheduler", minuteTick, func(ctx context.Context) {
		m.tick()
	}) {
		return errors.New("agentcron: scheduler ticker already registered")
	}
	return nil
}

// Stop 摘除包级装配并落下停机闸（内核 Stop 后不再触发任何巡检与发起）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	m.stopped.Store(true)
	setDefault(nil)
	return nil
}

// tick 单轮巡检：到期/错过判定触发 + 完成回执监听。任务量小（用户手工维护
// 清单）+ 每轮一次全量读，放调度器专属 goroutine 串行执行，不与请求路径争抢
func (m *Module) tick() {
	if m.stopped.Load() {
		return
	}
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		return
	}
	now := timeNow()
	m.r.runDue(crons, now)
	m.r.pollWatches()
}
