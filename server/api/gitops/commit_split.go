package gitops

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"

	"github.com/gin-gonic/gin"
)

// ExecuteCommitSplit POST /api/projects/:id/commit-split-execute
// 拆分建议逐组执行（P-20261003-278）：请求体 {groups:[{name,files,subject}]}——
// 前端确认弹层预览后的结构化分组方案原样下发；逐组 stage+commit 循环与失败
// 中断报告在 git.ExecuteCommitSplit（写队列域，P-78 同域互斥；组间靠 pathspec
// 提交隔离，组外已暂存内容保持原状）。组级失败不映射 HTTP 错误——报告本体是
// 200 data（已执行的组是既成事实，前端据此渲染中断报告）；请求级畸形（空组/
// 超限/主题缺失）仍走错误通道。完成后 status 缓存就地失效（StageFiles 同款
// ——变更树行状态翻转依赖紧随的重拉拿到新状态）
func ExecuteCommitSplit(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Groups []git.CommitSplitGroup `json:"groups" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	report, err := git.ExecuteCommitSplit(p.Path, req.Groups)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Commit operation failed", err)
		return
	}

	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"data": report})
}
