package project

import (
	"context"
	"log/slog"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
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

// notesTrashCleanupInterval 回收站硬清巡检周期：对齐 quickdrop/agentask 的
// 10 分钟粒度——软删篇滞留压在 30 天+10min 内；List/Get 惰性把守兜住清理
// 间隙（读面过滤软删篇，滞留条目不可见）
const notesTrashCleanupInterval = 10 * time.Minute

// Start 注册多篇笔记回收站硬清 ticker + 启动即先清一轮（quickdrop 模块同款
// 收口——本模块路由承载笔记端点，巡检宿主同域）。agent 通道无硬删的兜底：
// 软删 30 天后由服务端自动清账，真实暴露面收敛在可恢复窗内
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	st := store.Get()
	if st == nil {
		k.Logger().Warn("project module notes cleanup skipped: store not ready")
		return nil
	}
	cleanup := func() {
		if n, err := st.MultiNotes.PurgeDeletedBefore(time.Now().Add(-store.NotesTrashRetention)); err != nil {
			k.Logger().Warn("notes trash cleanup failed", "err", err)
		} else if n > 0 {
			k.Logger().Info("notes trash cleanup", "purged", n)
		}
	}
	if sch := k.Scheduler(); sch != nil {
		sch.AddTicker("notes-trash-cleanup", notesTrashCleanupInterval, func(context.Context) {
			cleanup()
		})
	}
	cleanup()
	return nil
}

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
