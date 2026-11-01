package project

import (
	shared "codecombo/server/api/shared"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
)

// 获取 .gitignore 文件内容
func GetGitignore(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	gitignorePath := filepath.Join(p.Path, ".gitignore")
	data, err := os.ReadFile(gitignorePath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{"data": ""})
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Gitignore operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": string(data)})
}

// 更新 .gitignore 文件内容
func UpdateGitignore(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Gitignore operation failed", err)
		return
	}

	gitignorePath := filepath.Join(p.Path, ".gitignore")
	if err := os.WriteFile(gitignorePath, []byte(req.Content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitignore operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

// 添加 .gitignore 规则
func AddGitignoreRule(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Rule string `json:"rule"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Rule == "" {
		shared.Error(c, http.StatusBadRequest, "rule is required", nil)
		return
	}

	gitignorePath := filepath.Join(p.Path, ".gitignore")
	data, err := os.ReadFile(gitignorePath)
	content := ""
	if err == nil {
		content = string(data)
	}

	// 确保末尾有换行
	if content != "" && !endsWithNewline(content) {
		content += "\n"
	}
	content += req.Rule + "\n"

	if err := os.WriteFile(gitignorePath, []byte(content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitignore operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

func endsWithNewline(s string) bool {
	return len(s) > 0 && s[len(s)-1] == '\n'
}

// 添加 git exclude 规则（本地排除，不修改 .gitignore）
func AddGitExcludeRule(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Rule string `json:"rule"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Rule == "" {
		shared.Error(c, http.StatusBadRequest, "rule is required", nil)
		return
	}

	excludePath := filepath.Join(p.Path, ".git", "info", "exclude")
	// 确保 info 目录存在
	infoDir := filepath.Join(p.Path, ".git", "info")
	if err := os.MkdirAll(infoDir, 0755); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitignore operation failed", err)
		return
	}

	data, err := os.ReadFile(excludePath)
	content := ""
	if err == nil {
		content = string(data)
	}

	if content != "" && !endsWithNewline(content) {
		content += "\n"
	}
	content += req.Rule + "\n"

	if err := os.WriteFile(excludePath, []byte(content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Gitignore operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}
