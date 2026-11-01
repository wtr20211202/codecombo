package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module AI 原生操作模块：承载 ops-channel 入站端点（opsentry.go）与
// 操作手册文档的启动期安装。
//
// 注：早期的会话式 AI 助手（/api/agent-chat/*，后端直调 Agent CLI 的
// headless 传输层）已随产品定位调整移除——本系统不再自研助手能力，
// 转为管理环境内成熟智能体框架（claude / codex / dsh，经终端 TUI 承接）。
// agentops 包的 Run 运行核心保留为可嵌入框架的公开 API（见 agentops/README.md）。
type Module struct {
	k kernel.Kernel
}

// NewModule 创建 AI 模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "ai" }
func (m *Module) DependsOn() []string { return nil }

// Init 校验持久化层可达（装配期暴露配置问题并触发内核启动回滚，而不是等首个请求 500），
// 并统一安装操作手册文档（claude 技能目录 + codex AGENTS.md）——
// 「启动时把本系统操作 skill 注入底层智能体」：终端里手动拉起的智能体同样无感知可用
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if store.Get() == nil {
		return fmt.Errorf("ai: store not assembled")
	}
	// 安装失败只降级不阻断启动（受限部署下家目录可能不可写）
	if err := agentops.InstallSkillDocs(); err != nil {
		k.Logger().Warn("agent skill docs install failed — local agent CLIs will lack Codecombo knowledge", "err", err)
	}
	// 任务事件落库（B6）：task.progress / approval.* 旁路持久化（保留 7 天）。
	// AddObserver 追加式——多模块并行消费广播（P-20261001-15 录制联动同挂此流），
	// 覆盖式 SetObserver 会把先注册的观察者清掉
	opschannel.AddObserver(TaskEventObserver())
	// task.progress 最近上报缓存的会话关闭即清（P-20261004-120）：挂同一广播流，
	// terminals.changed 快照活名单对账摘除死会话条目（前端 pruneClosedSessions
	// 的服务端权威前置）
	opschannel.AddObserver(PruneLastProgressObserver())
	return nil
}

// TaskEventObserver 任务事件落库观察者（模块 Init 装配）：广播路径旁路持久化。
// 独立成构造器供测试环境复位到同一实现——观察者是包级单点，用例注入自有
// 观察者后须还原，否则同包后续依赖落库路径的用例会静默失配
func TaskEventObserver() func(opschannel.Event) {
	return persistTaskEvent
}

// persistTaskEvent 提取任务相关事件落库；解析失败静默（历史视图非关键路径）
func persistTaskEvent(ev opschannel.Event) {
	switch ev.Type {
	case opschannel.EventTaskProgress, opschannel.EventApprovalPending, opschannel.EventApprovalResolved:
	default:
		return
	}
	task := store.AgentTask{Type: ev.Type, At: time.Now()}
	if b, err := json.Marshal(ev.Payload); err == nil {
		var p struct {
			Task       string `json:"task"`
			Status     string `json:"status"`
			Step       string `json:"step"`
			TerminalID string `json:"terminalId"`
			SessionID  string `json:"sessionId"`
			ID         string `json:"id"`
		}
		if json.Unmarshal(b, &p) == nil {
			task.Task = p.Task
			task.Status = p.Status
			task.Step = p.Step
			task.SessionID = strings.TrimSpace(p.TerminalID + " " + p.SessionID)
			_ = p.ID
		}
	}
	if err := store.Get().AgentTask.Append(task); err != nil {
		slog.Warn("agent task persist failed", "type", ev.Type, "err", err)
	}
}

// agentApprovalRetention 审批记录保留窗口：消费态由中间件即时删除，
// 这里兜底清理 denied 与 stale pending（发起方会话已结束，永不会消费）
const agentApprovalRetention = 30 * 24 * time.Hour

// Start 每日清理保留窗口外的任务事件与审批记录 + 周期清理过期提问（P-20261001-27：
// 问题与答案走明文存储，AskTTL 过窗即删；10 分钟粒度把明文滞留压在 TTL+10min 内）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	k.Scheduler().AddTicker("agenttask-cleanup", 24*time.Hour, func(context.Context) {
		if _, err := store.Get().AgentTask.CleanupBefore(time.Now().AddDate(0, 0, -7)); err != nil {
			slog.Warn("agent task cleanup failed", "err", err)
		}
		if n, err := store.Get().AgentApproval.CleanupBefore(time.Now().Add(-agentApprovalRetention)); err != nil {
			slog.Warn("agent approval cleanup failed", "err", err)
		} else if n > 0 {
			slog.Info("agent approval cleanup", "removed", n)
		}
	})
	k.Scheduler().AddTicker("agentask-cleanup", 10*time.Minute, func(context.Context) {
		if n, err := store.Get().AgentAsk.CleanupBefore(time.Now().Add(-store.AskTTL)); err != nil {
			slog.Warn("agent ask cleanup failed", "err", err)
		} else if n > 0 {
			slog.Info("agent ask cleanup", "removed", n)
		}
	})
	// pending 审批等待超时自动拒绝（P-20261003-45）：同一 10min 粒度——到期
	// 检测延迟上界 TTL+10min。TTL 默认 0=不限，扫描即刻返回（存量行为不变）
	k.Scheduler().AddTicker("approval-timeout-sweep", 10*time.Minute, func(context.Context) {
		if n := sweepExpiredApprovals(time.Now()); n > 0 {
			slog.Info("approval timeout sweep", "denied", n)
		}
		// 放行时限档位巡检（P-20261003-316）：allow-24h 到期物化回 ask +
		// 会话级映射死会话裁剪兜底（判定侧惰性正确，这里管存储与广播）
		SweepApprovalTier(time.Now())
	})
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }
