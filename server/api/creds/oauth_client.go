package creds

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git/auth"

	"github.com/gin-gonic/gin"
)

// saveOAuthClientReq OAuth Client 新增/更新请求体
// ClientSecret 可空——Device Flow 的 Public Client 通常不需要 secret
type saveOAuthClientReq struct {
	Platform     string `json:"platform" binding:"required"`
	Host         string `json:"host" binding:"required"`
	ClientID     string `json:"client_id" binding:"required"`
	ClientSecret string `json:"client_secret"`
}

// oauthClientItem 是 ListOAuthClients 的响应元素
// 永不返回 client_secret 字段（即便加密也不返回），只暴露 has_secret 布尔
type oauthClientItem struct {
	Platform  string `json:"platform"`
	Host      string `json:"host"`
	ClientID  string `json:"client_id"`
	HasSecret bool   `json:"has_secret"`
}

// ListOAuthClients 列出所有已配置的 OAuth 应用
// 安全约束：响应中永不包含 client_secret（无论明文 / 加密）
func ListOAuthClients(c *gin.Context) {
	cfg := config.Load()
	items := make([]oauthClientItem, 0, len(cfg.OAuthClients))
	for i := range cfg.OAuthClients {
		oc := &cfg.OAuthClients[i]
		items = append(items, oauthClientItem{
			Platform:  oc.Platform,
			Host:      oc.Host,
			ClientID:  oc.ClientID,
			HasSecret: oc.ClientSecret != "",
		})
	}
	c.JSON(http.StatusOK, gin.H{"clients": items})
}

// SaveOAuthClient 新增 / 更新 OAuth Client 配置
// 校验：platform 必须是 P0 支持的 github / gitea
// 行为：按 platform + host 唯一去重；ClientSecret 为空时保留原值（更新场景）
func SaveOAuthClient(c *gin.Context) {
	var req saveOAuthClientReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	// P0 仅支持 github / gitea 的 OAuth Device Flow
	if req.Platform != auth.PlatformGitHub && req.Platform != auth.PlatformGitea {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "platform_not_supported",
			"msg":   "P0 仅支持 github / gitea 的 OAuth Device Flow",
		})
		return
	}
	if req.Host == "" {
		shared.Error(c, http.StatusBadRequest, "host required", nil)
		return
	}

	cfg := config.Load()
	cfg.SaveOAuthClient(config.OAuthClientConfig{
		Platform:     req.Platform,
		Host:         req.Host,
		ClientID:     req.ClientID,
		ClientSecret: req.ClientSecret,
	})
	if err := config.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// DeleteOAuthClient 按 platform + host 删除 OAuth Client 配置
// 路由参数：DELETE /api/oauth-clients/:platform/:host
func DeleteOAuthClient(c *gin.Context) {
	platform := c.Param("platform")
	host := c.Param("host")
	if platform == "" || host == "" {
		shared.Error(c, http.StatusBadRequest, "platform and host required", nil)
		return
	}

	cfg := config.Load()
	if !cfg.DeleteOAuthClient(platform, host) {
		shared.Error(c, http.StatusNotFound, "oauth_client_not_found", nil)
		return
	}
	if err := config.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
