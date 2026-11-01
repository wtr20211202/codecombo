package remoteterminal

import (
	"context"

	"codecombo/server/kernel"
)

// Module 远程终端模块（roadmap M2.1）：Manager 装配进内核生命周期。
// Dialer 由组合根在注册清单构造时传入（生产实现依赖 api 层 SSH 凭据解析，
// 本包不能反向 import，故经构造参数声明式注入——非 setter）
type Module struct {
	k   kernel.Kernel
	mgr *Manager
}

// NewModule 创建远程终端模块。dialer 为生产拨号器（SSH 凭据解析 + PTY 连接）
func NewModule(dialer Dialer) *Module {
	return NewModuleWithManager(NewManager(dialer, DefaultSessionLimit))
}

// NewModuleWithManager 以现成 Manager 创建模块（测试注入自定义 GC 窗口等场景）
func NewModuleWithManager(m *Manager) *Module {
	return &Module{mgr: m}
}

func (m *Module) Name() string        { return "remoteterminal" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配包级单例（WS handler 经 GetManager 取用；
// 上限 DefaultSessionLimit=20，WS 断开 60s 重连窗口，超期 GC 回收）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	managerMu.Lock()
	defaultMgr = m.mgr
	managerMu.Unlock()
	return nil
}

func (m *Module) Start(_ context.Context, _ kernel.Kernel) error { return nil }

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	managerMu.Lock()
	defaultMgr = nil
	managerMu.Unlock()
	return nil
}
