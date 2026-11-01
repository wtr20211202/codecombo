package agentchain

// 会话接续链模块（P-20261004-38）：事件触发的会话接力——链源会话完成链终态
// 命中链定义时自动拉起下一棒（多 agent 串行自动化地基件；并行竞写=compareexp、
// 定时轮跑=agentcron，串行接力由此补齐）。无自持事件主题：消费 opschannel
// task.progress 广播流（compareexp/recording 同一 AddObserver 追加式装配），
// 触发成功广播 chain.triggered（events.go 常量表已登记）。

import (
	"context"
	"fmt"

	"codecombo/server/api/opschannel"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 会话接续链模块
type Module struct {
	k kernel.Kernel
	// unsub 观察者退订（Stop 语义：模块停机后不再消费广播流）
	unsub func()
}

// NewModule 创建模块（launch/alive 生产绑定 LaunchAgentSession 与终端管理器
// 在册判定；单测经 newEngineWith 注入桩）
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "agentchain" }
func (m *Module) DependsOn() []string { return nil }

// Init 校验持久化层可达（装配期暴露配置问题并触发内核启动回滚）、装配触发
// 引擎并注册完成链观察者
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if store.Get() == nil {
		return fmt.Errorf("agentchain: store not assembled")
	}
	setDefaultEngine(newEngine(launchByTerminal, defaultAliveFn))
	m.unsub = opschannel.AddObserver(taskEventObserver)
	return nil
}

// Start 无周期任务（触发是事件驱动观察者，Init 注册即生效）；接口要求的
// 生命周期方法空实现（compareexp 同）
func (m *Module) Start(_ context.Context, _ kernel.Kernel) error { return nil }

// Stop 退订观察者并摘除引擎装配（幂等：Init 未成功时 unsub 为 nil）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.unsub != nil {
		m.unsub()
		m.unsub = nil
	}
	setDefaultEngine(nil)
	return nil
}
