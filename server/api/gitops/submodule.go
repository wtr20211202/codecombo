package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ListSubmodules 列出 submodule
func ListSubmodules(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	subs, err := git.ListSubmodules(p.Path)
	if err != nil {
		respondGitError(c, "Submodule operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": subs})
}

// AddSubmodule 添加 submodule
func AddSubmodule(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		URL    string `json:"url" binding:"required"`
		Path   string `json:"path"`
		Branch string `json:"branch"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Submodule operation failed", err)
		return
	}

	if err := git.AddSubmodule(p.Path, req.URL, req.Path, req.Branch); err != nil {
		respondGitError(c, "Submodule operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "submodule added"})
}

// UpdateSubmodules 更新 submodule
func UpdateSubmodules(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Init      bool `json:"init"`
		Recursive bool `json:"recursive"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}

	if err := git.UpdateSubmodules(p.Path, req.Init, req.Recursive); err != nil {
		respondGitError(c, "Submodule operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "submodules updated"})
}

// RemoveSubmodule 删除 submodule
func RemoveSubmodule(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path string `json:"path" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Submodule operation failed", err)
		return
	}

	if err := git.RemoveSubmodule(p.Path, req.Path); err != nil {
		respondGitError(c, "Submodule operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "submodule removed"})
}
