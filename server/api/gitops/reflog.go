package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// GetReflog 获取 reflog 记录
func GetReflog(c *gin.Context) {
	project := shared.GetProjectFromContext(c)
	if project == nil {
		return
	}

	ref := c.Query("ref")
	limitStr := c.DefaultQuery("limit", "100")
	limit, _ := strconv.Atoi(limitStr)

	entries, err := git.GetReflog(project.Path, ref, limit)
	if err != nil {
		respondGitError(c, "Reflog operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// GetReflogDiff 获取 reflog 某条记录的 diff
func GetReflogDiff(c *gin.Context) {
	project := shared.GetProjectFromContext(c)
	if project == nil {
		return
	}

	hash := c.Param("hash")
	diff, err := git.GetReflogCommitDiff(project.Path, hash)
	if err != nil {
		respondGitError(c, "Reflog operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": diff})
}

// ResetToReflog 重置到 reflog 指定记录
func ResetToReflog(c *gin.Context) {
	project := shared.GetProjectFromContext(c)
	if project == nil {
		return
	}

	var req struct {
		Hash string `json:"hash" binding:"required"`
		Mode string `json:"mode"` // soft, mixed, hard
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Reflog operation failed", err)
		return
	}

	if req.Mode == "" {
		req.Mode = "mixed"
	}

	if err := git.ResetToReflogEntry(project.Path, req.Hash, req.Mode); err != nil {
		respondGitError(c, "Reflog operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "reset successful"})
}
