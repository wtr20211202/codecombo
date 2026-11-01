package terminal

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 终端模块（roadmap M1.4）：会话恢复 + health check 进内核生命周期。
// DefaultManager 保持包级单例（handler 直接取用）；会话上限归本模块所有
// （边界常量与读取端归一随模块声明，生效值经 MaxSessions() 取）。
//
// 会话上限的内存护栏依据：每个会话固定占用 1.6~16MB 回放缓冲 + 多个
// goroutine，无上限创建在批量脚本/前端 bug 场景下会拖垮整个进程。
// 上限可配化（P-20261006-12）：自托管硬件谱系差异大（128G 服务器跑 80
// 会话从容、16G NAS 30 已吃紧），50 定值两端都不合适——config.json 的
// server.terminalMaxSessions 按内存自算（边界与默认见下）
const (
	// DefaultMaxSessions 缺省上限 = 可配化之前的硬编码现值（存量行为零变化）
	DefaultMaxSessions = 50
	// MinMaxSessions 下限护栏：防误配 1 让系统近乎不可用（tmux 恢复/项目+
	// agent 混用场景至少要留余量），低于 10 一律收敛到 10
	MinMaxSessions = 10
	// MaxSessionsSoftLimit 上限软限：200 会话 ≈ 0.3~3.2GB 回放缓冲，再往上
	// 内存责任自负——超配截断到 200（配置面无 UI 白名单拒绝，读取端收敛）
	MaxSessionsSoftLimit = 200
)

// maxSessionsLimit 进程内生效的会话上限（Init 读配置一次定值，创建路径
// atomic 无锁读；未 Init（部分单测裸装配）时保持缺省 50 = 存量行为）
var maxSessionsLimit atomic.Int64

func init() { maxSessionsLimit.Store(DefaultMaxSessions) }

// MaxSessions 当前生效的单进程终端会话上限（可配化后不再是无参常量；
// 调整 terminalMaxSessions 需重启生效——配额是启动期护栏非热调参数）
func MaxSessions() int { return int(maxSessionsLimit.Load()) }

// EffectiveMaxSessions 读取端边界归一：未配置（<=0）回落缺省 50；1~9 下限
// 护栏收敛 10；>200 软限截断 200；其余原样。与 GetScrollbackLines 同款
// 「读取端归一供多消费方共用」——module Init 与单测边界矩阵同一份判定
func EffectiveMaxSessions(cfg int) int {
	switch {
	case cfg <= 0:
		return DefaultMaxSessions
	case cfg < MinMaxSessions:
		return MinMaxSessions
	case cfg > MaxSessionsSoftLimit:
		return MaxSessionsSoftLimit
	default:
		return cfg
	}
}

// Module 终端内核模块
type Module struct {
	k kernel.Kernel
}

// NewModule 创建终端模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "terminal" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	// 会话上限可配化（P-20261006-12）：启动期读一次设置定值（调整需重启）。
	// 经 Settings doc store 读（CLAUDE.md Terminal「配置同步」纪律：config.Load
	// 仅 legacy fallback，settings 写入不会同步过去）；store 未装配（部分单测
	// 裸构造模块）时保持缺省 50。生效值落启动日志，运维可感知配在哪
	if st := store.Get(); st != nil {
		if cfg := st.Settings.Get(); cfg != nil {
			limit := EffectiveMaxSessions(cfg.Server.TerminalMaxSessions)
			maxSessionsLimit.Store(int64(limit))
			slog.Info("terminal session limit resolved",
				"limit", limit, "configured", cfg.Server.TerminalMaxSessions)
		}
	}
	// TUI git 写活动（P-20261004-81）：嗅探命中经会话 ProjectID 归属发布内核
	// 总线，api 层 busbridge 桥接到项目 WS（git.activity 定向广播面）。无项目
	// 归属的命中在 feed 侧已短路；Init 先于任何会话创建，回调赋值无并发写
	OnGitActivity = func(hit GitActivityHit) {
		if m.k == nil || hit.ProjectID == "" {
			return
		}
		m.k.Events().Publish(kernel.Envelope{
			Topic:     TopicGitActivity,
			ProjectID: hit.ProjectID,
			Payload:   hit,
		})
	}
	return nil
}

// Start 扫描恢复上次运行遗留的 tmux session（依赖 store，Init 后可用），
// 并把 health check 托管到内核调度器（仅 tmux 持久化 session：
// 1 分钟扫一遍，清理底层已不存活的引用）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	recovered := RecoverSessions()
	pruneStaleSessionMeta()
	slog.Info("terminal session recovery done", "summary", recovered)

	k.Scheduler().AddTicker("terminal-health", 60*time.Second, func(context.Context) {
		HealthCheck()
	})
	// 空闲超时巡更（P-192）：1 分钟粒度对小时级阈值绰绰有余。CheckIdleSessions
	// 自读设置，默认关（0）时零开销直返；无人打开会话列表的「彻底遗忘」场景
	// 由本 ticker 兜底（列表消费侧的确定性触发在 api 层 ListTerminals）
	k.Scheduler().AddTicker("terminal-idle", 60*time.Second, func(context.Context) {
		DefaultManager.CheckIdleSessions()
	})
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }

// pruneStaleSessionMeta 清理指向已消亡会话的元数据（agentsessionmeta 文档）。
// 会话正常关闭时 API 层会删元数据；但进程重启未走关闭路径（崩溃/重启杀掉
// 原生 shell）时，元数据永久残留且只增不删。在会话恢复完成后调用：此时
// Manager 中的会话 = 全部可恢复的存活会话，不在其列的元数据即陈旧记录。
// 用户命名记录（Named）豁免：它是新建会话槽位名继承（inheritDisplayName）
// 的唯一来源——native 平台会话随进程消亡，重启后全部不在 live 列表，若一并
// 清掉，用户改名永远无法在重启后的新会话上还原。豁免量级受用户改名次数约束
// （每会话至多一条），无只增不删的泄漏风险
func pruneStaleSessionMeta() {
	live := make(map[string]bool, len(DefaultManager.ListSessions()))
	for _, s := range DefaultManager.ListSessions() {
		live[s.ID] = true
	}
	metas, err := store.Get().AgentSession.List()
	if err != nil {
		return
	}
	removed := 0
	for _, m := range metas {
		if live[m.ID] || m.Named {
			continue
		}
		_ = store.Get().AgentSession.Delete(m.ID)
		removed++
	}
	if removed > 0 {
		slog.Info("terminal: pruned stale session meta", "removed", removed)
	}
}
