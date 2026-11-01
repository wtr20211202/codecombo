package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// index.lock 遗留锁一键清理（P-20261002-150）：写命令失败检出遗留锁后，
// 前端修复条的恢复入口。误删保护（mtime 双重校验）在 git.CleanStaleIndexLock
// 内实施——未达阈值 409 拒绝，锁不存在幂等成功（removed=false）

// CleanIndexLock POST /projects/:id/index-lock/cleanup
func CleanIndexLock(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	removed, ageSec, err := git.CleanStaleIndexLock(p.Path)
	if err != nil {
		// 活锁拒绝 → git.index_lock_fresh：agent 收到即「等几秒重试清理」（写命令
		// 失败携 git.index_lock_stale → 本端点清理 → 重试原命令，自纠闭环）
		if errors.Is(err, git.ErrIndexLockFresh) {
			shared.ErrorWithCode(c, shared.CodeGitIndexLockFresh, "Git index lock cleanup refused", err)
			return
		}
		shared.Error(c, http.StatusConflict, "Git index lock cleanup refused", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"removed": removed, "ageSec": ageSec})
}
