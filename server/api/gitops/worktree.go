package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ListWorktrees 列出 worktree
func ListWorktrees(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：静默返回空列表而非 500，前端 Git 面板降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []any{}})
		return
	}

	worktrees, err := git.ListWorktrees(p.Path)
	if err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": worktrees})
}

// AddWorktree 创建 worktree
func AddWorktree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path   string `json:"path" binding:"required"`
		Branch string `json:"branch"`
		Ref    string `json:"ref"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Worktree operation failed", err)
		return
	}

	var err error
	if req.Ref != "" {
		err = git.AddWorktreeFromRef(p.Path, req.Path, req.Ref)
	} else {
		err = git.AddWorktree(p.Path, req.Path, req.Branch)
	}

	if err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktree created"})
}

// RemoveWorktree 删除 worktree
func RemoveWorktree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path  string `json:"path" binding:"required"`
		Force bool   `json:"force"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Worktree operation failed", err)
		return
	}

	if err := git.RemoveWorktree(p.Path, req.Path, req.Force); err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktree removed"})
}

// PruneWorktrees 清理无效 worktree
func PruneWorktrees(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.PruneWorktrees(p.Path); err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktrees pruned"})
}

// MoveWorktree 移动 worktree
func MoveWorktree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		OldPath string `json:"oldPath" binding:"required"`
		NewPath string `json:"newPath" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Worktree operation failed", err)
		return
	}

	if err := git.MoveWorktree(p.Path, req.OldPath, req.NewPath); err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktree moved"})
}

// LockWorktree 锁定 worktree
func LockWorktree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path   string `json:"path" binding:"required"`
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Worktree operation failed", err)
		return
	}

	if err := git.LockWorktree(p.Path, req.Path, req.Reason); err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktree locked"})
}

// UnlockWorktree 解锁 worktree
func UnlockWorktree(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path string `json:"path" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Worktree operation failed", err)
		return
	}

	if err := git.UnlockWorktree(p.Path, req.Path); err != nil {
		respondGitError(c, "Worktree operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "worktree unlocked"})
}
