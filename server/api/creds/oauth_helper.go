package creds

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/git/auth/platforms"
	"codecombo/server/git/auth/providers"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// oauthDeviceCtx 是 OAuthStart / OAuthPoll / OAuthRefresh 共用的 Device Flow 解析结果
//
// 三 handler 此前各自重复 5 步装配（host 兜底 → adapter → endpoints → clientCfg → provider），
// 任一缺失返 400；本结构把"已校验通过"的上下文打包，让 handler 只关心业务调用（Start/Poll/Refresh）
type oauthDeviceCtx struct {
	// Adapter 平台适配器（已通过非 generic 校验）
	// 由 platforms.Match(ctx, host) 返回，调用方用于 ScopesOf / CreatePRURLOf 等能力查询
	Adapter auth.PlatformAdapter

	// Endpoints 平台 OAuth 端点（已确认非 nil，表示 adapter 实现了 OAuthCapable）
	Endpoints *auth.OAuthEndpoints

	// ClientCfg 平台对应的 OAuth Client 配置（已确认非 nil，调用方无需再判空）
	ClientCfg *config.OAuthClientConfig

	// DeviceProvider 平台对应的 Device Flow Provider（已 type assert 成功）
	DeviceProvider auth.OAuthDeviceFlowProvider

	// Platform / Host 解析后的最终值（host 兜底后非空，platform 原样回传）
	// 用途：构造 cred 时写入 cred.Host / cred.Platform 字段
	Platform string
	Host     string
}

// resolveOAuthDeviceContext 解析 OAuth Device Flow 共用上下文
//
// 主流程：
//  1. host 兜底：github→github.com / gitea→gitea.com，否则返 400 platform_no_oauth
//  2. platforms.Match → adapter；generic 表示未识别，返 400
//  3. OAuthEndpointsOf → endpoints；未实现 OAuthCapable 返 nil，返 400
//  4. config.FindOAuthClient → clientCfg；未配返 400 oauth_client_not_configured
//  5. providers.FindByPlatform → provider；非 OAuthDeviceFlowProvider 返 400
//
// 返回值：
//   - 成功：返 (*oauthDeviceCtx, true)，caller 继续业务调用
//   - 失败：返 (nil, false)，已写 HTTP 响应，caller 应直接 return
//
// 调用方：OAuthStart / OAuthPoll / OAuthRefresh（Refresh 从 cred 取 platform/host 后调用）
func resolveOAuthDeviceContext(c *gin.Context, platform, host string) (*oauthDeviceCtx, bool) {
	// 1. host 兜底：仅 github / gitea 在 P0 支持 Device Flow
	if host == "" {
		switch platform {
		case auth.PlatformGitHub:
			host = "github.com"
		case auth.PlatformGitea:
			host = "gitea.com"
		default:
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "platform_no_oauth",
				"msg":   "P0 仅支持 github / gitea Device Flow",
			})
			return nil, false
		}
	}

	// 2. 平台识别（generic 表示 host 未命中任何已知平台）
	adapter := platforms.Match(c.Request.Context(), host)
	if adapter.ID() == auth.PlatformGeneric {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "platform_no_oauth",
			"msg":   "未识别的平台 host",
		})
		return nil, false
	}

	// 3. OAuth 端点（adapter 未实现 OAuthCapable 时返 nil）
	baseURL := "https://" + host
	endpoints := auth.OAuthEndpointsOf(adapter, baseURL)
	if endpoints == nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "platform_no_oauth",
			"msg":   "该平台未实现 OAuth Device Flow",
		})
		return nil, false
	}

	// 4. OAuth Client 配置
	cfg := config.Load()
	clientCfg := cfg.FindOAuthClient(platform, host)
	if clientCfg == nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "oauth_client_not_configured",
			"hint":  "请先在 设置 → 安全 → OAuth 应用 配置 client_id",
		})
		return nil, false
	}

	// 5. Device Flow Provider（type assert 兜底）
	provider := providers.FindByPlatform(store.AuthTypeOAuthDevice, platform)
	if provider == nil {
		shared.Error(c, http.StatusBadRequest, "platform_no_oauth", nil)
		return nil, false
	}
	deviceProvider, ok := provider.(auth.OAuthDeviceFlowProvider)
	if !ok {
		shared.Error(c, http.StatusBadRequest, "platform_no_oauth", nil)
		return nil, false
	}

	return &oauthDeviceCtx{
		Adapter:        adapter,
		Endpoints:      endpoints,
		ClientCfg:      clientCfg,
		DeviceProvider: deviceProvider,
		Platform:       platform,
		Host:           host,
	}, true
}
