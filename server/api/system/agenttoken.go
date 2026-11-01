package system

import (
	"fmt"
	"log/slog"
	"net/http"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// ── Agent Token 管理（sca_ 前缀，供终端内智能体调用本系统 API） ──
// 单例语义：Ensure 自动播种，轮换使旧值立即失效，撤销后可再 Ensure 重建。
// 明文仅在 reveal/rotate 响应中出现一次；服务端持久态为哈希 + 机器密钥加密。

// GetAgentToken GET /api/agent-token —— 元信息（不含秘密值）
func GetAgentToken(c *gin.Context) {
	if err := store.Get().AgentToken.Ensure(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent token operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": store.Get().AgentToken.Meta()})
}

// RevealAgentToken POST /api/agent-token/reveal —— 返回明文（已解锁的管理页可见）
func RevealAgentToken(c *gin.Context) {
	if err := store.Get().AgentToken.Ensure(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent token operation failed", err)
		return
	}
	plain := store.Get().AgentToken.Plain()
	if plain == "" {
		shared.Error(c, http.StatusNotFound, "agent token not provisioned", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"token": plain}})
}

// RotateAgentToken POST /api/agent-token/rotate —— 轮换（旧值立即失效，返回新明文）
func RotateAgentToken(c *gin.Context) {
	plain, err := store.Get().AgentToken.Rotate()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent token operation failed", err)
		return
	}
	// 既有会话的会话级回调环境刷新为新令牌（新开 pane 即生效）；已在运行
	// 的智能体进程环境无法变更——前端需提示重开终端会话
	terminal.RefreshAgentCallbackEnv()
	slog.Info("agent token rotated")
	// 审计入账：只记动作，新明文令牌绝不入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditAgentRotated,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})
	// 通知中心即时回执（P-20261003-54）：轮换令全部既有 sca_ 令牌立即失效，
	// 持旧值的一侧（含在跑智能体）骤然失能——与上方审计点同位旁挂，审计
	// 留证、通知即时感知；类别 warning 使 webhook 默认 important 范围外发，
	// 来源 IP 用审计同源 ClientIP 零新增采集
	store.Get().Notification.Add(notification.Notification{
		Type:      "warning",
		Category:  notification.CategorySystem,
		TitleKey:  "audit.notify.agentTokenRotate.title",
		BodyKey:   "audit.notify.agentTokenRotate.body",
		Title:     "Agent 访问令牌已轮换",
		Body:      fmt.Sprintf("Agent 访问令牌已轮换，旧令牌立即失效，运行中的智能体需重开终端会话（来源 IP %s）", c.ClientIP()),
		MsgParams: map[string]any{"ip": c.ClientIP()},
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"token": plain}})
}

// RevokeAgentToken DELETE /api/agent-token —— 撤销
func RevokeAgentToken(c *gin.Context) {
	if err := store.Get().AgentToken.Revoke(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent token operation failed", err)
		return
	}
	terminal.RefreshAgentCallbackEnv()
	slog.Info("agent token revoked")
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditAgentRevoke,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})
	c.JSON(http.StatusOK, gin.H{"message": "revoked"})
}
