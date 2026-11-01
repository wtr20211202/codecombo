package project

import (
	"context"
	"log/slog"

	"codecombo/server/kernel"
)

// 项目生命周期事件 topic：项目增删后经事件总线发布（载荷 {id, path}），
// watch 模块订阅以自管运行期监听接入——api 层不再反向依赖 watch 包
const (
	TopicProjectAdded   = "project.added"
	TopicProjectRemoved = "project.removed"
)

// Module 项目管理领域模块：清单声明（路由/topics）+ 领域事件的内核总线发布面
type Module struct {
	k kernel.Kernel
}

// NewModule 创建项目管理模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "project" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配领域事件发布面（handler 经 publishLifecycle 使用；模块未启动时静默跳过）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	publisher = k.Events()
	return nil
}

func (m *Module) Start(_ context.Context, _ kernel.Kernel) error { return nil }

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	publisher = nil
	return nil
}

// publisher 领域事件发布面（project 模块 Init 装配、Stop 卸载）
var publisher *kernel.EventBus

// publishLifecycle 发布项目生命周期事件到内核总线（载荷 {id, path}）。
// watch 模块订阅本事件维护运行期监听；前端刷新信号仍走 opschannel
// （projects.changed），两条通道职责不同
func publishLifecycle(topic, id, path string) {
	if publisher == nil {
		return
	}
	publisher.Publish(kernel.Envelope{
		Topic: topic,
		Payload: map[string]string{
			"id":   id,
			"path": path,
		},
	})
	slog.Debug("project: lifecycle event published", "topic", topic, "id", id)
}
