package system

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 系统领域模块：清单声明（settings/instances/tokens/lock/updates/
// ui-state/snippets 路由 + settings.changed topic）+ 构建信息装配。
// 原 app 组合根的 SetBuildInfo 启动调用迁入本模块 Init
type Module struct {
	version   string
	commit    string
	buildTime string

	// dw 磁盘水位巡检器（P-20261002-12）：武装状态挂在模块实例上，
	// Stop 重置（生命周期与内核一致）
	dw *diskWatchdog
}

// NewModule 创建系统领域模块（构建信息由组合根声明式传入）
func NewModule(version, commit, buildTime string) *Module {
	return &Module{version: version, commit: commit, buildTime: buildTime, dw: newDiskWatchdog(nil, nil)}
}

func (m *Module) Name() string        { return "system" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	SetBuildInfo(m.version, m.commit, m.buildTime)
	// 后台任务清单数据源（P-20261003-276）：调度器引用注入——handler 是
	// 包级函数，经包级原子引用取数（SetBuildInfo 同款注入惯例）；
	// k 为 nil（单测裸调 Init）时跳过，端点侧回落空清单
	if k != nil {
		SetSchedulerSource(k.Scheduler())
	}
	// Agent Token 自动播种：终端 env 注入（CC_LOCK_TOKEN）开箱即用，
	// 失败不阻断启动——设置页 Get/reveal 会再次尝试
	if st := store.Get(); st != nil {
		if err := st.AgentToken.Ensure(); err != nil {
			slog.Warn("agent token auto-provision failed", "err", err)
		}
	}
	return nil
}

// Start 注册磁盘水位巡检（P-20261002-12，deploy/ai 模块同款 ticker 惯例：
// 低频采集放内核调度器专属 goroutine 串行执行，不与请求路径争抢）。
// 启动即先巡检一轮：开屏即知满盘（而不是等 5 分钟），且通知在服务可用前
// 已入账——任何测试/前端清空逻辑都从干净状态开始，套件中途不再有第二次
// 触发（超线持续即保持武装）；以及每日审计保留巡更（P-20261002-13 append 型
// kind 保留策略，同 deploytask-cleanup 模式；P-20261003-277 起过期前先转 CSV
// 归档再清理，见 auditarchive.go）。
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	if !k.Scheduler().AddTicker("disk-watch", diskWatchInterval, func(context.Context) {
		m.dw.patrol()
	}) {
		return errors.New("system: disk-watch ticker already registered")
	}
	m.dw.patrol()
	k.Scheduler().AddTicker("auditlog-cleanup", 24*time.Hour, func(context.Context) {
		// 保留巡更（P-20261003-277 起实体为 RunAuditRetentionPass）：过期前
		// 审计先转 CSV 归档（artifacts/audit-archive/，合规离线留档）→ 时间窗
		// 清理 → 容量第二道闸（P-20261004-80，超量删最旧+audit.prune 摘要）→
		// 归档文件窗口清账。保留期可配（P-20261003-123）：每次执行读当前配置
		// ——调整 settings.auditRetentionDays 次日巡更即生效，无需重启
		RunAuditRetentionPass(time.Now(), "", "")
	})
	// 联邦派发记录 TTL 兜底清理（P-20261004-131，agenttask-cleanup 同款每日
	// ticker：append 型 kind 保留策略——List/Append 已惰性剪枝，这里管
	// 「只读不写」期间的落盘收敛）
	k.Scheduler().AddTicker("dispatch-cleanup", 24*time.Hour, func(context.Context) {
		if n, err := store.Get().DispatchRecord.CleanupBefore(time.Now().Add(-store.DispatchTTL)); err != nil {
			slog.Warn("dispatch record cleanup failed", "err", err)
		} else if n > 0 {
			slog.Info("dispatch record cleanup", "removed", n)
		}
	})
	// 本机体检每日快照（P-20261005-169，selfcheckhist.go）：日报同款「分钟
	// 巡检 + 当日已办判定」调度惯例，标记不落内存——今日与否以已落盘最新
	// 快照的日期为准，重启追赶零额外状态。启动不立即补拍：会话恢复等启动期
	// 工作尚在进行，开机瞬间采样会把「刚开机」误读成「会话全关」，等首个
	// 巡检到点（≈1 分钟后）自然入账
	k.Scheduler().AddTicker("selfcheck-snapshot", time.Minute, func(context.Context) {
		maybeSelfCheckDailySnapshot(time.Now())
	})
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	m.dw.reset()
	return nil
}
