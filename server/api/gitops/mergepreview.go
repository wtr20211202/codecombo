package gitops

// merge 预演端点（P-20261005-174）：GET /api/projects/:id/merge-preview?branch=X。
// git merge-tree 现代三向模式（--write-tree）在对象库内合成虚拟合并结果，
// 不动工作区不动引用——只读原语：不加 ProjectHardLock（GET 读面先例）、
// 不入审计（真合并 MergeBranch 才入硬锁与冲突链）；agent 合并前自检点
//（预演干净→自动合、冲突→上报不硬闯），ops 手册 git 节同批登记。

import (
	"fmt"
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"

	"github.com/gin-gonic/gin"
)

// MergePreviewBranch 预演把 ?branch= 指定的分支合入当前 HEAD。
// 版本护栏：merge-tree --write-tree 需 git ≥2.38，旧版诚实 501（前端入口已按
// GET /branches 顺带的 mergePreviewSupported 隐藏，此栏是直接调用方——agent、
// 版本漂移后未刷新的前端——的兜底真话）
func MergePreviewBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	source := c.Query("branch")
	if source == "" {
		shared.Error(c, http.StatusBadRequest, "branch parameter required", nil)
		return
	}

	if !git.MergeTreeSupported() {
		shared.Error(c, http.StatusNotImplemented,
			fmt.Sprintf("merge preview requires git >= 2.%d (merge-tree --write-tree)", git.MergeTreeMinMinor), nil)
		return
	}

	res, err := git.MergePreview(p.Path, source)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": res})
}
