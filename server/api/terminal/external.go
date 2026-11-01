package terminal

import (
	"fmt"
	"net/http"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 外部 tmux 会话接管（P-20261005-189）API 面：
//   - GET  /api/terminals/external-sessions  列举服务器上用户默认 socket 的
//     tmux 会话（自建会话住专属 socket 天然不在列）
//   - POST /api/terminals {"attachTmux"}     接管（attach 模式创建变体）
//   - DELETE /api/terminals/:id[?kill=1]     close 分流：缺省=解除接管（外部
//     会话），kill=1=显式终结（kill-session，UI 二次确认后携带）
//   - PUT  /api/terminals/:id/input-lock     服务端只读闸翻转（P-20261008-17：
//     前端 pane 只读锁的服务端镜像，接管会话默认只读，解锁动作同步翻转）
//
// agent 巡检价值：服务器遗留 tmux 任务（nohup 形态的构建/训练）经列举端点
// 可发现、经接管可围观，ops 手册 terminal 节同册

// ListExternalTmuxSessions GET /api/terminals/external-sessions
// available=false（tmux 未装/非 unix）时 data 恒空——前端据此隐藏接管入口；
// 默认 socket 无运行中 server 属正常情况（空集非错误）
func ListExternalTmuxSessions(c *gin.Context) {
	sessions, err := terminal.ListExternalTmuxSessions() //nolint:staticcheck // SA4023：windows stub 恒返回错误，unix 侧真实判错
	available := err == nil                              //nolint:staticcheck // SA4023：同上——unix 侧 err 可为 nil
	if err != nil {                                      //nolint:staticcheck // SA4023：同上
		sessions = nil
	}
	c.JSON(http.StatusOK, gin.H{
		"data":      sessions,
		"available": available,
	})
}

// createAttachedTerminal 接管模式创建（POST /api/terminals 携 attachTmux）：
// 校验会话名 → Manager.AttachExternalSession（attach 用户默认 socket）→
// 响应携带 origin=external + attached（接管时刻外部客户端数，多端同屏提示面）。
// 不注册「终端异常退出」通知（OnExit 在 tmux 模式下等的是 attach 子进程，
// 页面关闭/空闲分离都会触发——对外部会话属常态而非异常，报警是误报）
func createAttachedTerminal(c *gin.Context, tmuxName, name string) {
	if msg := terminal.ValidateExternalTmuxName(tmuxName); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	session, err := terminal.DefaultManager.AttachExternalSession(strings.TrimSpace(name), tmuxName)
	if err != nil {
		// 会话不存在/已接管/backend 非 tmux 都是用户可行动的失败（400/404 级），
		// 非 500 服务端故障；原文回给前端 toast
		shared.Error(c, http.StatusBadRequest, err.Error(), err)
		return
	}
	auditTakeover(c, session, tmuxName)
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"id":        session.ID,
			"name":      session.Name,
			"projectId": "",
			"path":      session.Path,
			"createdAt": session.CreatedAt,
			"kind":      session.Kind,
			"origin":    session.Origin,
			// attached ≥1 时前端提示「多端同屏回显是 tmux 特性」
			"attached": externalAttachedCount(tmuxName),
			// 创建后权威总数（P-20261003-183 同款）：越软阈值轻提示用
			"totalSessions": len(terminal.DefaultManager.ListSessions()),
		},
	})
	broadcastTerminalsChanged()
}

// externalAttachedCount 外部会话当前的 tmux 客户端附着数（探测失败按 0——
// 提示面宁可不提也不虚构）。列表响应字段 session_attached 同口径
func externalAttachedCount(tmuxName string) int {
	sessions, err := terminal.ListExternalTmuxSessions() //nolint:staticcheck // SA4023：windows stub 恒返回错误，unix 侧真实判错
	if err != nil {                                      //nolint:staticcheck // SA4023：同上
		return 0
	}
	for _, s := range sessions {
		if s.Name == tmuxName {
			return s.Attached
		}
	}
	return 0
}

// SetTerminalInputLock PUT /api/terminals/:id/input-lock {"locked":bool}
// 服务端只读闸翻转（P-20261008-17）：接管会话（origin=external）默认只读是
// 前端 pane 锁的 UI 语义，agent 令牌直调 WS 写链可绕过——本端点把同一锁语义
// 落到服务端（Session.serverReadOnly，WS 写链入口按它拒绝）。设计分层：
//   - 只对接管会话生效：自建会话的 pane 锁是纯防误触 UI（锁者即会话主人，
//     agent 写本会话与会话本身同信任级），服务端闸对它无意义——400 拒绝，
//     前端只在 external 会话上调用本端点
//   - 解锁 = 放开对用户 tmux 会话（可能正跑 deploy/生产脚本）的写入，是安全
//     敏感方向：agent 令牌经 AgentGuard 审批（middleware/agentguard.go 同表
//     登记，locked=true 加固方向 body 感知直放行）；同值幂等设置不入账（连点
//     不刷台账），状态实际变化才记 terminal.input_lock 审计
//   - 后写者胜：多端同时操作同一接管会话时服务端标记收敛到最后一次翻转，
//     前端各自 pane 锁是本地瞬态、不互相同步（P-91 transient 语义不变）
func SetTerminalInputLock(c *gin.Context) {
	id := c.Param("id")
	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	if session.Origin != terminal.OriginExternal {
		shared.Error(c, http.StatusBadRequest, "input lock applies only to taken-over (external) sessions", nil)
		return
	}
	var req struct {
		Locked *bool `json:"locked"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	if req.Locked == nil {
		shared.ErrorWithCode(c, shared.CodeTerminalPayloadInvalid, "invalid request body", nil)
		return
	}
	locked := *req.Locked
	prev := session.ServerReadOnly()
	session.SetServerReadOnly(locked)
	if prev != locked {
		auditInputLock(c, session, locked)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"locked": locked}})
}

// auditInputLock 只读闸翻转入账（P-20261008-17，terminal.input_lock）：解锁
// 方向把对用户接管会话的写入权放开，与接管审计同族的安全动作底账——谁在
// 何时把哪个会话的只读闸开/关了，事后可追认。只记会话 id/名称/翻转后状态
// 元数据，无内容面。审计旁路惯例：store 未装配（单测）静默跳过（
// auditBroadcast 同款）
func auditInputLock(c *gin.Context, session *terminal.Session, locked bool) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTerminalInputLock,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("session=%s name=%q origin=external locked=%t", session.ID, session.Name, locked),
	})
}

// auditTakeover 接管成功路径入账（P-20261008-16，terminal.external.takeover）：
// 接管=拿走一个用户自起 tmux 会话的全部 IO 视野，多用户共用服务器形态下
// 「谁在何时接管了那个 tmux」是真实审计问题（P-473 强操作留痕纪律）。只记
// 元数据：显示名 + tmux 会话名（接管目标在用户默认 socket 的身份，与显示名
// 分记——接管可重命名，tmux 名才是跨接管的稳定锚点）+ origin=external；
// 操作者 IP 走 AuditEvent.IP 惯例字段。审计旁路惯例：store 未装配（单测）静默
// 跳过，Append 尽力而为不阻断接管主流程（auditBroadcast 同款）
func auditTakeover(c *gin.Context, session *terminal.Session, tmuxName string) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTerminalExternalTakeover,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("name=%s tmux=%s origin=external", session.Name, tmuxName),
	})
}

// auditExternalKill 外部会话显式终结入账（P-20261008-16，terminal.external.kill）：
// ?kill=1 是 kill-session 落在用户默认 socket 的不可逆强操作（Manager.KillSession
// 语义注记），会话内进程随之结束——「谁在何时终结了那个外部 tmux」必须有底账。
// 只记元数据：显示名 + tmux 会话名（外部会话 id 即 tmux 会话名，AttachExternalSession
// 以 tmuxName 为会话 id 落账）。自建会话的 kill=1 与普通 close 等价（例行操作
// 不入账，CloseTerminal 分流只在 origin=external 时传入会话）；close 普通分流=
// 解除接管是非破坏性语义（tmux 会话与进程原样存活），不入账。s 为 nil（自建
// 会话/会话已不存在）零入账。审计旁路惯例：store 未装配（单测）静默跳过，
// Append 尽力而为不阻断关闭主流程（auditBroadcast 同款）
func auditExternalKill(c *gin.Context, s *terminal.Session) {
	if s == nil || store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTerminalExternalKill,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("name=%s tmux=%s", s.Name, s.ID),
	})
}
