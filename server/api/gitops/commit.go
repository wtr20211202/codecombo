package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/model"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// 暂存文件
func StageFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	if len(req.Files) == 0 {
		shared.Error(c, http.StatusBadRequest, "File list cannot be empty", nil)
		return
	}

	if err := git.Stage(p.Path, req.Files); err != nil {
		respondGitError(c, "Commit operation failed", err)
		return
	}

	// gitops 层 status 3s TTL 缓存须就地失效（P-20261004-25 hunk 三键同款）：
	// 否则动作后前端紧随的 status 重拉拿到陈旧状态且无后续刷新触发——变更树
	// 行状态翻转（○→✓ / 行摘除）依赖这次重拉，批量菜单动作同链
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "files staged"})
}

// 取消暂存文件
func UnstageFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	if len(req.Files) == 0 {
		shared.Error(c, http.StatusBadRequest, "File list cannot be empty", nil)
		return
	}

	if err := git.Unstage(p.Path, req.Files); err != nil {
		respondGitError(c, "Commit operation failed", err)
		return
	}

	// gitops 层 status 3s TTL 缓存须就地失效（P-20261004-25 hunk 三键同款）：
	// 否则动作后前端紧随的 status 重拉拿到陈旧状态且无后续刷新触发——变更树
	// 行状态翻转（○→✓ / 行摘除）依赖这次重拉，批量菜单动作同链
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "files unstaged"})
}

// 提交
func CreateCommit(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CommitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	output, err := git.Commit(p.Path, req)
	if err != nil {
		respondGitError(c, "Commit operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// GetCommitTemplate GET /api/projects/:id/commit-template
// 读取 git config commit.template 指向的模板文件内容（P-20261003-172），
// 提交框初始化空态预填用。未配置/读取失败统一 200 + 空串，前端静默跳过——
// 模板缺失是常态而非错误，不进错误面；读不到的细节在服务端 slog 留排障线索
func GetCommitTemplate(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"template": git.GetCommitTemplate(p.Path)}})
}

// 修改最近一次提交的信息
func AmendCommitMessage(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Message string `json:"message" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	if err := git.AmendMessage(p.Path, req.Message); err != nil {
		respondGitError(c, "Commit operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "commit message amended"})
}

// GetCommitPushed GET /api/projects/:id/commit/:commit/pushed
// 检测提交是否已推送到远程（reword 前端据此展示影响面警告）
func GetCommitPushed(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	hash := c.Param("commit")
	pushed, branches, err := git.CommitPushedInfo(p.Path, hash)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"pushed":         pushed,
		"remoteBranches": branches,
	}})
}

// RewordCommitMessage POST /api/projects/:id/commit/:commit/reword
// 修改任意提交的信息（不改内容）：HEAD 走 amend --only；更早提交走非交互
// rebase reword。已推送提交须 confirmPushed=true（改写公开历史需 force 推送，
// 前端先展示影响面警告；权威指引见 git-rebase(1)/ProGit"改写公开历史"警告）
func RewordCommitMessage(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Message       string `json:"message" binding:"required"`
		ConfirmPushed bool   `json:"confirmPushed"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	result, err := git.RewordCommitMessage(p.Path, c.Param("commit"), strings.TrimSpace(req.Message), req.ConfirmPushed)
	if errors.Is(err, git.ErrCommitPushed) {
		// 409 + 影响面明细：前端弹强警告（列出包含该提交的远程分支）后携带确认重试
		c.JSON(http.StatusConflict, gin.H{
			"error":          err.Error(),
			"remoteBranches": result.RemoteBranches,
		})
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "not supported") || strings.Contains(err.Error(), "not be empty") || strings.Contains(err.Error(), "invalid commit hash") || strings.Contains(err.Error(), "commit not found") {
			shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
			return
		}
		respondGitError(c, "Commit operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// 回滚文件
func RollbackFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	if len(req.Files) == 0 {
		shared.Error(c, http.StatusBadRequest, "File list cannot be empty", nil)
		return
	}

	// Ref 缺省 = HEAD（既有整文件回滚语义）；非空 = 检出该提交的文件版本
	// 进工作区（P-20261008-11 文件历史时间线 git 条目的恢复动作）。改写工作区
	// 的高危写在 handler 层不分支——语义/缓存失效/错误出口与 HEAD 路径完全一致
	if err := git.Rollback(p.Path, req.Files, req.Ref); err != nil {
		respondGitError(c, "Commit operation failed", err)
		return
	}

	// gitops 层 status 3s TTL 缓存须就地失效（P-20261004-25 hunk 三键同款）：
	// 否则动作后前端紧随的 status 重拉拿到陈旧状态且无后续刷新触发——变更树
	// 行状态翻转（○→✓ / 行摘除）依赖这次重拉，批量菜单动作同链
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "files rolled back"})
}
