package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ListHooks 列出 hooks
func ListHooks(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	hooks, err := git.ListHooks(p.Path)
	if err != nil {
		respondGitError(c, "Hook operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": hooks})
}

// GetHookContent 获取 hook 内容
func GetHookContent(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	name := c.Param("name")
	content, err := git.GetHookContent(p.Path, name)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "Hook operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": content})
}

// UpdateHook 更新 hook
func UpdateHook(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	name := c.Param("name")
	var req struct {
		Content string `json:"content"`
		Enabled bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Hook operation failed", err)
		return
	}

	if err := git.UpdateHook(p.Path, name, req.Content, req.Enabled); err != nil {
		respondGitError(c, "Hook operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "hook updated"})
}
