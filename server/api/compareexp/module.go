package compareexp

// 对比实验模块（P-20261003-46）：双 agent 同题竞写的实验包装——双开发起、
// 完成监听（复用完成链观察者）、对比数据面与采用标注。无自持事件主题，
// 消费 opschannel task.progress 广播流（与 ai/recording 同一 AddObserver
// 追加式装配，多模块并行消费互不清除）。

import (
	"context"
	"fmt"

	"codecombo/server/api/opschannel"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 对比实验模块
type Module struct {
	k kernel.Kernel
	// unsub 观察者退订（Stop 语义：模块停机后不再消费广播流）
	unsub func()
}

// NewModule 创建模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "compareexp" }
func (m *Module) DependsOn() []string { return nil }

// Init 校验持久化层可达（装配期暴露配置问题并触发内核启动回滚）并注册
// 完成链观察者
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if store.Get() == nil {
		return fmt.Errorf("compareexp: store not assembled")
	}
	m.unsub = opschannel.AddObserver(taskEventObserver)
	return nil
}

// Start 无周期任务（完成监听是事件驱动观察者，Init 注册即生效）；接口要求
// 的生命周期方法空实现
func (m *Module) Start(_ context.Context, _ kernel.Kernel) error { return nil }

// Stop 退订观察者（幂等：Init 未成功时 unsub 为 nil）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.unsub != nil {
		m.unsub()
		m.unsub = nil
	}
	return nil
}
