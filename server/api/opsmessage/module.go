package opsmessage

// 会话收件箱模块（P-20261004-68）：agent 间定向消息的持久化与 TTL 巡检。
// 无观察者消费（投递是 POST 端点直驱广播 terminal.message，拉取是 GET 端点
// 直驱广播 terminal.message.read）；自持一个小时级 ticker 兜底清理窗口外
// 收件箱（含会话已关闭的无主收件箱——不级联挂 CloseTerminal，随 TTL 自然
// 过期，提案修正项）。

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 会话收件箱模块
type Module struct{}

// NewModule 创建模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "opsmessage" }
func (m *Module) DependsOn() []string { return nil }

// Init 校验持久化层可达（装配期暴露配置问题并触发内核启动回滚，agentchain 同）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	if store.Get() == nil {
		return fmt.Errorf("opsmessage: store not assembled")
	}
	return nil
}

// Start 小时级 TTL 巡检：清账「最新消息早于 TTL」的收件箱文档。惰性剪枝
// （Append/Take 时）已保证读面永不见过期条目，巡检只管磁盘回收——TTL+1h
// 的滞后窗口对瞬态语义无感
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	k.Scheduler().AddTicker("inbox-cleanup", time.Hour, func(context.Context) {
		n, err := store.Get().Inbox.CleanupBefore(time.Now().Add(-store.InboxTTL))
		if err != nil {
			slog.Warn("inbox cleanup failed", "err", err)
			return
		}
		if n > 0 {
			slog.Info("inbox cleanup", "removed", n)
		}
	})
	return nil
}

// Stop 无常驻资源（ticker 归内核调度器生命周期）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }
