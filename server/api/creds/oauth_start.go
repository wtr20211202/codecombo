package creds

import (
	"context"
	"errors"
	"net/http"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/git/auth"

	"github.com/gin-gonic/gin"
)

// oauthStartReq OAuthStart 请求体
// Host 可空——为空时按 platform 推断默认 host（github→github.com / gitea→gitea.com）
type oauthStartReq struct {
	Platform string `json:"platform" binding:"required"`
	Host     string `json:"host"`
}

// oauthStartResp OAuthStart 成功响应
// 前端拿到后展示 user_code + verification_uri，按 Interval 节奏调 Poll
type oauthStartResp struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"` // 秒
	Interval        int    `json:"interval"`   // 秒，UI 轮询节奏
}

// OAuthStart 启动 OAuth Device Flow
//
// 主流程：
//  1. resolveOAuthDeviceContext 完成 host 兜底 / adapter / endpoints / clientCfg / provider 5 步装配
//  2. provider.StartDeviceFlow 调平台 device_code 端点（30s 超时）
//  3. 网络失败返 502 oauth_platform_unreachable；其他错误返 500
func OAuthStart(c *gin.Context) {
	var req oauthStartReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}

	ctx, ok := resolveOAuthDeviceContext(c, req.Platform, req.Host)
	if !ok {
		return
	}

	// 推荐 scope（adapter 实现 ScopeAdvisor 时返回；否则 nil）
	scopes := auth.ScopesOf(ctx.Adapter)

	// 调平台 device_code 端点（30s 超时）
	reqCtx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	df, err := ctx.DeviceProvider.StartDeviceFlow(reqCtx, ctx.ClientCfg.ClientID, ctx.Endpoints, scopes)
	if err != nil {
		// 网络错误（HTTP 失败 / 非预期状态码）返 502
		var ae *auth.AuthError
		if errors.As(err, &ae) && ae.Kind == auth.KindNetwork {
			c.JSON(http.StatusBadGateway, gin.H{
				"error": "oauth_platform_unreachable",
				"msg":   "无法访问 OAuth 平台",
			})
			return
		}
		// 其他错误（含 KindInternal）返 500
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, oauthStartResp{
		DeviceCode:      df.DeviceCode,
		UserCode:        df.UserCode,
		VerificationURI: df.VerificationURI,
		ExpiresIn:       df.ExpiresIn,
		Interval:        df.Interval,
	})
}
