package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// GetGpgStatus 获取 GPG 签名状态
func GetGpgStatus(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 检查当前 commit.gpgsign 配置
	output, err := git.ExecGitConfig(p.Path, "commit.gpgsign")
	enabled := false
	if err == nil && strings.TrimSpace(output) == "true" {
		enabled = true
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{"enabled": enabled}})
}

// ToggleGpgSign 切换 GPG 签名
func ToggleGpgSign(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Enable bool `json:"enable"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "GPG operation failed", err)
		return
	}

	if err := git.SetCommitGpgSign(p.Path, req.Enable); err != nil {
		respondGitError(c, "GPG operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "gpg sign setting updated"})
}
