package quickdrop

import (
	"context"
	"log/slog"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// quickdropCleanupInterval 过期清理的巡检周期：对齐 agentask-cleanup 的
// 10 分钟粒度——投递内容是明文敏感面（与 ask 同级），过期滞留压在
// TTL+10min 内；List/Get 惰性把守兜住清理间隙
const quickdropCleanupInterval = 10 * time.Minute

// Module 快投递领域模块：只承载保留策略巡检（端点在 api 注册面、
// 存储在 store——无独立监听面）
type Module struct{}

// NewModule 创建快投递模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "quickdrop" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, _ kernel.Kernel) error { return nil }

// Start 注册过期清理 ticker + 启动即先清一轮（重启不残留已过期投递——
// share/agentask 模块同款收口）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	st := store.Get()
	if st == nil {
		k.Logger().Warn("quickdrop module skipped: store not ready")
		return nil
	}
	cleanup := func() {
		if n, err := st.Quickdrop.CleanupExpired(time.Now()); err != nil {
			k.Logger().Warn("quickdrop cleanup failed", "err", err)
		} else if n > 0 {
			k.Logger().Info("quickdrop cleanup", "removed", n)
		}
	}
	if sch := k.Scheduler(); sch != nil {
		sch.AddTicker("quickdrop-cleanup", quickdropCleanupInterval, func(context.Context) {
			cleanup()
		})
	}
	cleanup()
	slog.Info("quickdrop module started")
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }
