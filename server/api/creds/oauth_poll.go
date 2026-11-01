package creds

import (
	"context"
	"errors"
	"net/http"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// oauthPollReq OAuthPoll 查询参数（GET 表单）
type oauthPollReq struct {
	Platform   string `form:"platform" binding:"required"`
	Host       string `form:"host" binding:"required"`
	DeviceCode string `form:"device_code" binding:"required"`
}

// oauthPollResp 非阻塞响应——立即返回当前 status，前端按 interval 重试
type oauthPollResp struct {
	Status       string `json:"status"`                  // "pending" / "ok" / "expired" / "denied"
	CredentialID string `json:"credential_id,omitempty"` // 仅 status=ok 时有值
	Interval     int    `json:"interval,omitempty"`      // 推荐下次轮询间隔（秒）
}

// OAuthPoll 非阻塞轮询 Device Flow 状态
// 关键设计：handler 立即返回当前 status，不 long-poll；前端按 interval 重试
//
// 错误分类：
//   - KindAuthPending → status=pending，interval=5（slow_down 时 interval=10）
//   - KindAuthExpired → status=expired（device_code 过期，需重新 Start）
//   - KindAuthDenied  → status=denied（用户拒绝授权）
//   - KindNetwork     → 502 oauth_platform_unreachable
//   - 成功            → 写入 cred + status=ok + credential_id
func OAuthPoll(c *gin.Context) {
	var req oauthPollReq
	if err := c.ShouldBindQuery(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}

	// 平台 / 端点 / client / provider 解析复用 resolveOAuthDeviceContext
	ctx, ok := resolveOAuthDeviceContext(c, req.Platform, req.Host)
	if !ok {
		return
	}

	// 调平台 token 端点（10s 超时；handler 本身不重试，前端按 interval 重试）
	reqCtx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	tb, err := ctx.DeviceProvider.PollDeviceFlow(reqCtx, ctx.ClientCfg.ClientID, req.DeviceCode, ctx.Endpoints)
	if err != nil {
		handlePollError(c, err)
		return
	}

	// 成功：构造 cred 持久化
	username := ""
	if tun, ok := ctx.DeviceProvider.(auth.TokenUsernameProvider); ok {
		username = tun.TokenUsername(nil)
	}

	cred := &store.Credential{
		Host:          ctx.Host,
		Platform:      ctx.Platform,
		AuthType:      store.AuthTypeOAuthDevice,
		Username:      username,
		Secret:        config.EncryptIfNeeded(tb.AccessToken),
		RefreshToken:  config.EncryptIfNeeded(tb.RefreshToken),
		ExpiresAt:     time.Now().Add(time.Duration(tb.ExpiresIn) * time.Second),
		Scope:         tb.Scope,
		OAuthClientID: ctx.ClientCfg.ClientID,
		Status:        store.StatusActive,
		CreatedAt:     time.Now(),
	}
	if err := store.Get().Credential.Save(cred); err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, oauthPollResp{Status: "ok", CredentialID: cred.ID})
}

// handlePollError 按 AuthError.Kind 分类返回响应
// 提取到独立函数便于阅读；不导出
func handlePollError(c *gin.Context, err error) {
	var ae *auth.AuthError
	if !errors.As(err, &ae) {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}
	switch ae.Kind {
	case auth.KindAuthPending:
		// 用户尚未完成授权，按平台约定 interval 继续轮询
		c.JSON(http.StatusOK, oauthPollResp{Status: "pending", Interval: 5})
	case auth.KindAuthSlowDown:
		// RFC 8628 §3.5：客户端轮询过快，必须增大 interval 至少 5 秒
		// 这里翻倍到 10s（默认 5s 的两倍），保证下次不再触发 slow_down
		c.JSON(http.StatusOK, oauthPollResp{Status: "pending", Interval: 10})
	case auth.KindAuthExpired:
		c.JSON(http.StatusOK, oauthPollResp{Status: "expired"})
	case auth.KindAuthDenied:
		c.JSON(http.StatusOK, oauthPollResp{Status: "denied"})
	case auth.KindNetwork:
		c.JSON(http.StatusBadGateway, gin.H{
			"error": "oauth_platform_unreachable",
			"msg":   "无法访问 OAuth 平台",
		})
	default:
		// KindInternal / KindConfig / 未知
		shared.Error(c, http.StatusInternalServerError, ae.Error(), nil)
	}
}
