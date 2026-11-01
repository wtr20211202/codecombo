package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetLfsStatus 获取 LFS 状态
func GetLfsStatus(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	installed := git.LfsIsInstalled(p.Path)
	var tracks []git.LfsTrack
	if installed {
		tracks, _ = git.LfsGetTracks(p.Path)
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"installed": installed,
		"tracks":    tracks,
	}})
}

// LfsInstall 初始化 LFS
func LfsInstall(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.LfsInstall(p.Path); err != nil {
		respondGitError(c, "LFS operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "LFS installed"})
}

// LfsTrack 添加追踪规则
func LfsTrack(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Pattern string `json:"pattern" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "LFS operation failed", err)
		return
	}

	if err := git.LfsAddTrack(p.Path, req.Pattern); err != nil {
		respondGitError(c, "LFS operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "track rule added"})
}

// LfsUntrack 移除追踪规则
func LfsUntrack(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Pattern string `json:"pattern" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "LFS operation failed", err)
		return
	}

	if err := git.LfsUntrack(p.Path, req.Pattern); err != nil {
		respondGitError(c, "LFS operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "track rule removed"})
}

// LfsPull 拉取 LFS 文件
func LfsPull(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.LfsPull(p.Path); err != nil {
		respondGitError(c, "LFS operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "LFS pull completed"})
}

// LfsPush 推送 LFS 文件
func LfsPush(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.LfsPush(p.Path); err != nil {
		respondGitError(c, "LFS operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "LFS push completed"})
}
