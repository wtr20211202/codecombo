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

// OAuthRefresh 手动触发 token 刷新
// 使用场景：用户在 UI 点「测试连接」/「刷新」按钮，或后台发现 token 即将过期时主动刷新
//
// 失败分类：
//   - KindAuthExpired → refresh_token 已失效：标记 cred.Status=expired 持久化，返 {status:"expired"}
//   - 其他错误        → 502 / 500
func OAuthRefresh(c *gin.Context) {
	credID := c.Param("id")
	if credID == "" {
		shared.Error(c, http.StatusBadRequest, "id required", nil)
		return
	}

	// FindByID 直接按 ID 取单条凭据，避免 List() 全量遍历的 N+1
	cred, err := store.Get().Credential.FindByID(credID)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}
	if cred == nil {
		shared.Error(c, http.StatusNotFound, "credential not found", nil)
		return
	}
	if cred.AuthType != store.AuthTypeOAuthDevice {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "not_oauth_credential",
			"msg":   "仅 oauth-device 类型凭据支持刷新",
		})
		return
	}

	// 平台 / 端点 / client / provider 解析（platform / host 来自 cred 而非 request body）
	ctx, ok := resolveOAuthDeviceContext(c, cred.Platform, cred.Host)
	if !ok {
		return
	}

	// 调平台 refresh 端点（30s 超时）
	reqCtx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	tb, err := ctx.DeviceProvider.RefreshToken(reqCtx, cred, ctx.ClientCfg.ClientID, ctx.Endpoints)
	if err != nil {
		var ae *auth.AuthError
		if errors.As(err, &ae) && ae.Kind == auth.KindAuthExpired {
			// refresh_token 已失效：标记 cred 为 expired 持久化，前端引导用户重新 OAuth
			cred.Status = store.StatusExpired
			if ae.Err != nil {
				cred.LastError = ae.Err.Error()
			}
			_ = store.Get().Credential.Save(cred)
			c.JSON(http.StatusOK, gin.H{"status": "expired"})
			return
		}
		// 网络错误返 502，其他返 500
		if errors.As(err, &ae) && ae.Kind == auth.KindNetwork {
			c.JSON(http.StatusBadGateway, gin.H{
				"error": "oauth_platform_unreachable",
				"msg":   "无法访问 OAuth 平台",
			})
			return
		}
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}

	// 成功：更新 cred 字段
	cred.Secret = config.EncryptIfNeeded(tb.AccessToken)
	if tb.RefreshToken != "" {
		cred.RefreshToken = config.EncryptIfNeeded(tb.RefreshToken)
	}
	if tb.ExpiresIn > 0 {
		cred.ExpiresAt = time.Now().Add(time.Duration(tb.ExpiresIn) * time.Second)
	}
	cred.Status = store.StatusActive
	cred.LastError = ""
	if err := store.Get().Credential.Save(cred); err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// OAuthRevoke 撤销 token
// P0 实现：仅删除本地 cred（不主动调平台 RevokeURL，避免引入额外错误路径）
// 调用方：用户在 UI 删除 OAuth 凭据时
func OAuthRevoke(c *gin.Context) {
	credID := c.Param("id")
	if credID == "" {
		shared.Error(c, http.StatusBadRequest, "id required", nil)
		return
	}
	if err := store.Get().Credential.Delete(credID); err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
