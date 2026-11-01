package terminal

// 终端空闲超时自动分离（P-20261003-192）
//
// 动机：忘记关闭的终端会话永久挂机——native 后端 shell 进程 + PTY + 回放环
// 常驻，tmux 后端 attach 子进程 + PTY 常驻（底层 tmux session 是有意的持久
// 化设计，不在回收面）。空闲超时是资源与安全的双向边界，默认关、自托管
// 用户自选档位。
//
// 判定（四重门，宁漏分不误分）：
//  1. 阈值开启：settings.terminalIdleTimeoutMin > 0（默认 0 = 关，存量零变化）
//  2. 无人附着：交互 WS 客户端计数 == 0——有端连着的会话是在用的（前端断线
//     自动重连，对着在用会话做分离只会得到「分离→重连」的无谓抖动）；浏览器
//     一关客户端计数归零，被遗忘的会话才暴露出来
//  3. 真空闲：PTY 无输入且无输出超过阈值（LastActivity 服务端口径，不依赖
//     前端 activityMap——浏览器内存态，恰恰在被遗忘场景缺席）
//  4. 非已知运行中：前台探测 known && running（有任务在跑）的会话豁免——
//     静默长任务（无输出的构建/安装）不算空闲。Windows ConPTY 不可判定
//    （known=false）：按可分离处理，这是该平台用户开启本功能的隐含取舍
//    （tmux/native-unix 探测可靠，不受影响）。
//
// 分离语义按后端分叉（Session.Detach 注记同此，CLAUDE.md Terminal 节同记）：
//   - tmux：关 attach 连接，底层 session 存活可重连——「分离非杀进程」成立；
//   - native：PTY 释放即 shell 终结，会话自移除——无持久化层可保活，此处
//     诚实降级为「空闲回收 = 会话结束」，不冒充可重连。

import (
	"log/slog"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// IdleDetachEntry 一次空闲分离的回执（通知/审计消费方按此渲染）
type IdleDetachEntry struct {
	SessionID  string        `json:"sessionId"`
	Name       string        `json:"name"`
	ProjectID  string        `json:"projectId,omitempty"`
	Backend    BackendKind   `json:"backend"`
	Persistent bool          `json:"persistent"` // tmux=true（可重连）/ native=false（会话终结）
	IdleFor    time.Duration `json:"idleFor"`
}

// OnIdleDetach 空闲分离回调（api 层装配通知中心入账；nil = 只分离不通知）。
// 与 OnDevPortDetected / OnPortConflict / OnSentinelHit 同款扩展点手法：
// terminal 包不反向依赖通知面，装配收口在 api 层 init
var OnIdleDetach func(entries []IdleDetachEntry)

// IdleTimeoutThreshold 从设置读空闲阈值时长（0 = 关闭）。读取侧防御：负值/
// 越界脏值一律当关闭处理（与 RetentionDays 读取侧「未知值收敛默认而非报错」
// 同款——判定路径不做白名单拒绝，写入口已拦）
func IdleTimeoutThreshold() time.Duration {
	st := store.Get()
	if st == nil {
		return 0
	}
	cfg := st.Settings.Get()
	if cfg == nil {
		return 0
	}
	mins := cfg.Server.TerminalIdleTimeoutMin
	if !config.TerminalIdleTimeoutMinValid(mins) || mins == 0 {
		return 0
	}
	return time.Duration(mins) * time.Minute
}

// CheckIdleSessions 扫描全部会话并分离命中空闲超时者，返回本次分离回执。
// 无副作用原则下的量级考量：会话上限 MaxSessions()（可配，缺省 50），每会话
// 一次 atomic 读 +
// 缓存态运行标志读，调用频度 1 分钟一次 + 列表消费时顺带，开销可忽略。
// 不持 Manager 锁调用 Detach（锁序纪律：先 ListSessions 快照释放 RLock，
// 再逐会话取 s.mu），与 HealthCheck 同款两段式
func (m *Manager) CheckIdleSessions() []IdleDetachEntry {
	threshold := IdleTimeoutThreshold()
	if threshold == 0 {
		return nil
	}

	var detached []IdleDetachEntry
	for _, s := range m.ListSessions() {
		entry, ok := m.detachIfIdle(s, threshold, time.Now())
		if ok {
			detached = append(detached, entry)
		}
	}

	if len(detached) > 0 {
		slog.Info("terminal: idle sessions detached", "count", len(detached))
		if OnIdleDetach != nil {
			OnIdleDetach(detached)
		}
	}
	return detached
}

// detachIfIdle 对单会话执行四重门判定，命中则分离并返回回执。
// 单独成函数：时间源 time.Now 注入，单测免 sleep
func (m *Manager) detachIfIdle(s *Session, threshold time.Duration, now time.Time) (IdleDetachEntry, bool) {
	noop := IdleDetachEntry{}

	s.mu.Lock()
	if s.closed || s.attachExited || s.clients > 0 {
		// 已关闭（用户/shell 退出路径）或已分离过（上一轮扫描）的会话跳过——
		// 分离不可逆也不重复通知
		s.mu.Unlock()
		return noop, false
	}
	last := time.Unix(0, s.lastActivity.Load())
	backend := s.backend
	s.mu.Unlock()

	idleFor := now.Sub(last)
	if idleFor < threshold {
		return noop, false
	}
	// 已知前台在跑（构建/安装等静默长任务）不算空闲；known=false（Windows
	// ConPTY）不可判定 → 不豁免，取舍见文件头注记。读缓存态（RunningState）
	// 不重复探测：probeRunningLoop 4s 周期已维护新鲜度
	if running, known := s.RunningState(); known && running {
		return noop, false
	}

	if !s.Detach() {
		// Detach 锁内复查失败（恰好有客户端附上/并发关闭）：让位，不分离
		return noop, false
	}

	persistent := backend != nil && backend.IsPersistent()
	kind := BackendNative
	if persistent {
		kind = BackendTmux
	}
	slog.Info("terminal: session idle timeout, detaching",
		"id", s.ID, "name", s.Name, "backend", kind,
		"persistent", persistent, "idleFor", idleFor.Round(time.Second))
	return IdleDetachEntry{
		SessionID:  s.ID,
		Name:       s.Name,
		ProjectID:  s.ProjectID,
		Backend:    kind,
		Persistent: persistent,
		IdleFor:    idleFor,
	}, true
}
