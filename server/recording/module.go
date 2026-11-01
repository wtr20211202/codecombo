package recording

import (
	"context"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/kernel"
	"codecombo/server/terminal"
)

// Module 审批窗口过程实况录制模块：无路由（消费面经 /api/recordings，由
// api 层注册）；观察者 + 保留 ticker + 停机收尾
type Module struct {
	unsub       func()
	unsubscribe func()
}

// NewModule 创建录制模块（窗口管理器为包级 DefaultManager 单例）
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "recording" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配审批事件观察者与会话集合变更对账（AddObserver/AddOnChange 追加式，
// 与既有 API 层注册并存互不覆盖）
func (m *Module) Init(_ context.Context, _ kernel.Kernel) error {
	m.unsub = opschannel.AddObserver(DefaultManager.HandleEvent)
	m.unsubscribe = terminal.AddOnChange(DefaultManager.sessionChanged)
	return nil
}

// Start 启动期自愈（上次进程中断的活动录制落账）+ 每日保留清理
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	DefaultManager.HealStale()
	k.Scheduler().AddTicker("recording-cleanup", 24*time.Hour, func(context.Context) {
		DefaultManager.Sweep()
	})
	return nil
}

// Stop 收尾全部活动录制并退订（优雅停机不留 recording 态元数据）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	DefaultManager.StopAll("module stop")
	if m.unsub != nil {
		m.unsub()
	}
	if m.unsubscribe != nil {
		m.unsubscribe()
	}
	return nil
}
