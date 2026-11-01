package deploy

import (
	"context"
	"log/slog"
	"time"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// deployTaskRetention 部署任务保留窗口：任务记录只服务「最近跑过什么」的
// 历史视图（ListRecent 20 条），30 天远超 UI 消费窗口
const deployTaskRetention = 30 * 24 * time.Hour

// RestartInterruptedMarker 服务重启中断的稳定错误标记（对外契约）：启动清扫
// 把 running/queued 假态收尾为 failed 时写入 DeployTask.Error 的原文。任务
// 记录的 Error 是前端原样展示的裸串（同 "cancelled"/"ssh dial: …" 形态），
// 前端如需友好文案按此串映射（同 LogExpiredMarker 契约模式），改措辞两侧同步
const RestartInterruptedMarker = "deploy task interrupted by service restart"

// Module 远程部署模块（roadmap M1.3）：Manager 装配进内核生命周期。
// 任务运行/日志环形缓冲/订阅通道保持原有机制不变
type Module struct {
	k   kernel.Kernel
	mgr *Manager
}

// NewModule 创建部署模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "deploy" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配默认 Manager（依赖 DeployTask 存储；handler 经 DefaultManager 取用）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	m.mgr = NewManager(store.Get().DeployTask)
	defaultManager = m.mgr
	// 启动假态清扫（P-20261003-326）：此时 HTTP 尚未开始服务、无在途任务，
	// 存库里的 running/queued 必是上次进程被掐断的残留。失败不挡启动（同
	// app.go 启动期数据治理的迁移口径：warn 后继续，下次启动再收）
	if n, err := sweepInterruptedTasks(store.Get().DeployTask); err != nil {
		slog.Warn("deploy task interrupted-state sweep failed", "err", err)
	} else if n > 0 {
		slog.Info("deploy task interrupted-state swept", "count", n)
	}
	return nil
}

// sweepInterruptedTasks 重启假态收尾：running/queued 的死任务记录（Manager.running
// 内存态随进程清零，再没有谁把它们推进终态，历史列表会永远显示「进行中」假态）
// 统一收尾为 failed（原因=RestartInterruptedMarker，FinishedAt 补清扫时刻）。
// 只动这两类状态：终态记录原样不动；未知/空状态是数据损坏，标记失败反而掩盖
// 问题，同样不碰。幂等：重启多次只见一次残留，二次清扫空转。全量扫描
// （limit=0）而非 ListRecent 20——清扫对象不限于「最近」窗口；量级受 30 天
// 保留窗约束（deployTaskRetention，每日清理），上限即窗内任务数，无界增长不存在
func sweepInterruptedTasks(s store.DeployTaskStore) (int, error) {
	tasks, err := s.ListRecent(0)
	if err != nil {
		return 0, err
	}
	swept := 0
	for i := range tasks {
		t := tasks[i]
		if t.Status != config.TaskStatusRunning && t.Status != config.TaskStatusQueued {
			continue
		}
		now := time.Now()
		t.Status = config.TaskStatusFailed
		t.Error = RestartInterruptedMarker
		t.FinishedAt = &now
		// 排队标记一并清（P-20261004-36）：failed 记录不残留「等谁」，等待队列
		// 是纯内存态，进程重启后本来就无人接续
		t.WaitingFor = ""
		if err := s.Save(t); err != nil {
			return swept, err
		}
		swept++
	}
	return swept, nil
}

// Start 每日清理保留窗口外的部署任务（append 型 kind 保留策略），并同批对账
// 清理已出窗任务的留档日志（P-20261007-8：日志寿命=任务寿命，不新增独立保留
// 配置——清理失败轮任务记录留存，SweepPersistedLogs 找不到孤儿自然空转）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	k.Scheduler().AddTicker("deploytask-cleanup", 24*time.Hour, func(context.Context) {
		if n, err := store.Get().DeployTask.CleanupBefore(time.Now().Add(-deployTaskRetention)); err != nil {
			slog.Warn("deploy task cleanup failed", "err", err)
		} else if n > 0 {
			slog.Info("deploy task cleanup", "removed", n)
		}
		if n := SweepPersistedLogs(store.Get().DeployTask); n > 0 {
			slog.Info("deploy log archive sweep", "removed", n)
		}
	})
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	m.mgr = nil
	defaultManager = nil
	return nil
}
