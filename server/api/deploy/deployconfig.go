package deploy

import (
	"net/http"

	"codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// GetDeployConfig 返回部署配置（脱敏 token）
func GetDeployConfig(c *gin.Context) {
	cfg, err := store.Get().DeployConfig.Get()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "deploy config operation failed", err)
		return
	}
	// 脱敏 token（仅返回是否设置 + 末 4 位）
	hasToken := cfg.AnthropicToken != ""
	masked := ""
	if hasToken {
		t := cfg.AnthropicToken
		if len(t) > 4 {
			masked = "****" + t[len(t)-4:]
		} else {
			masked = "****"
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"anthropicToken":    masked,
			"hasAnthropicToken": hasToken,
			"anthropicBaseUrl":  cfg.AnthropicBaseURL,
			"model":             cfg.Model,
			"binaryDir":         cfg.BinaryDir,
		},
	})
}

// updateDeployConfigReq 更新请求体
// baseUrl/model/binaryDir 用 *string：nil=未提交（不改），空串=显式清空——
// 否则存量配置里的旧值（如历史默认 IP）在界面上清空后也保存不掉
// token 保持 string：空串或脱敏串（**** 开头）均视为未改动
type updateDeployConfigReq struct {
	AnthropicToken   string  `json:"anthropicToken"`
	AnthropicBaseURL *string `json:"anthropicBaseUrl"`
	Model            *string `json:"model"`
	BinaryDir        *string `json:"binaryDir"`
}

// UpdateDeployConfig 更新部署配置
// 注：anthropicToken 若为脱敏字符串（以 **** 开头）则保留原值，不覆盖
func UpdateDeployConfig(c *gin.Context) {
	var req updateDeployConfigReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "deploy config operation failed", err)
		return
	}
	cfg, err := store.Get().DeployConfig.Get()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "deploy config operation failed", err)
		return
	}

	// token：脱敏字符串（形如 ****xxxx）视为「未改动」
	if req.AnthropicToken != "" && !isMaskedToken(req.AnthropicToken) {
		cfg.AnthropicToken = req.AnthropicToken
	}
	if req.AnthropicBaseURL != nil {
		cfg.AnthropicBaseURL = *req.AnthropicBaseURL
	}
	if req.Model != nil {
		cfg.Model = *req.Model
	}
	if req.BinaryDir != nil {
		cfg.BinaryDir = *req.BinaryDir
	}

	if err := store.Get().DeployConfig.Save(*cfg); err != nil {
		shared.Error(c, http.StatusBadRequest, "deploy config operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// isMaskedToken 判断是否为脱敏后的 token（前端回传时不更新）
func isMaskedToken(s string) bool {
	return len(s) >= 4 && s[:4] == "****"
}
