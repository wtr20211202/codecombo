package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/model"
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// parseStashRefParam 解析 stash 寻址路径段（P-20261003-264）：
//   - 纯数字 = 列表 index（旧入口，渐进兼容：旧前端/脚本零改动）
//   - 40 位（SHA-1）或 64 位（SHA-256）十六进制 = stash 提交完整 hash（稳定引用）
//
// 其余形态 400。hash 只做形态校验，是否仍在栈内由 git.ResolveStashIndex 裁决
func parseStashRefParam(raw string) (index int, hash string, ok bool) {
	if n, err := strconv.Atoi(raw); err == nil {
		if n < 0 {
			return 0, "", false
		}
		return n, "", true
	}
	if len(raw) == 40 || len(raw) == 64 {
		if _, err := hex.DecodeString(raw); err == nil {
			return -1, raw, true
		}
	}
	return 0, "", false
}

// resolveStashRef 把请求里的 hash 稳定引用解析为当前栈位（index 回退原样）。
// 失败统一 409 + 稳定原文（ErrStashEntryGone，前端 KNOWN_ERROR_I18N 映射）：
// 已 drop/pop 的旧 hash 明确拒绝，绝不按旧 index 落到相邻条目
func resolveStashRef(c *gin.Context, projectPath string, index int, hash string) (int, bool) {
	resolved, err := git.ResolveStashIndex(projectPath, index, hash)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return 0, false
	}
	return resolved, true
}

// 获取Stash列表
func ListStashes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	stashes, err := git.GetStashes(p.Path)
	if err != nil {
		respondGitError(c, "Stash operation failed", err)
		return
	}

	// 每条已由 git.GetStashes 增量下发 hash（P-20261003-264 稳定引用），前端
	// 据此在后续操作中寻址；index 字段保留（列表展示与旧前端兼容）
	//
	// stagedSupported（P-20261003-119 选择性 stash）：本机 git 是否支持
	// `git stash push --staged`（2.35+）——前端创建弹窗据此禁用「仅已暂存」档 +
	// 降级注记。搭 stash 列表响应顺带下发（列表本就是弹窗前置拉取面），零新增
	// 请求；增量字段，旧前端忽略无感
	c.JSON(http.StatusOK, gin.H{"data": stashes, "stagedSupported": git.SupportsStashStaged()})
}

// 创建Stash
func CreateStash(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StashRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Stash operation failed", err)
		return
	}

	output, err := git.Stash(p.Path, req)
	if err != nil {
		respondGitError(c, "Stash operation failed", err)
		return
	}

	// stash 入栈把工作区变更移走，gitops 层 status 3s TTL 缓存就地失效
	//（P-20261004-25 先例）：前端紧随的 status 重拉若命中陈旧缓存会把已入栈
	// 变更继续挂在变更树上，且此后无刷新触发。pop/apply 同
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// Stash Pop
func StashPop(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StashApplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Stash operation failed", err)
		return
	}

	index, ok := resolveStashRef(c, p.Path, req.Index, req.Hash)
	if !ok {
		return
	}

	output, err := git.StashPop(p.Path, index)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	// pop 把变更写回工作区，status 缓存就地失效（P-20261004-25 先例）——
	// 恢复后前端紧随的重拉须见新状态（P-20261007-19 搁置恢复闭环依赖此 immediacy）
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// Stash Apply
func StashApply(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StashApplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Stash operation failed", err)
		return
	}

	index, ok := resolveStashRef(c, p.Path, req.Index, req.Hash)
	if !ok {
		return
	}

	output, err := git.StashApply(p.Path, index)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	// apply 同 pop：变更写回工作区，status 缓存就地失效（P-20261004-25 先例）
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// StashBranch 应用 stash 到新分支（P-20261003-263 实验性应用）：git stash
// branch 原子链（checkout -b 基于 stash 原基线 + apply），成功后新分支被检出、
// stash 条目按 git 语义移除——当前分支不被 stash 内容污染。分支名校验与
// CreateBranch/RenameBranch 同规则（gitops.validateRefName，前端镜像先行校验、
// 服务端裁决为准）；冲突拒绝稳定原文见 git.StashBranch。失败 409 携 output，
// 与同文件 StashPop/StashApply 的冲突路径同形态
func StashBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.StashBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Stash operation failed", err)
		return
	}

	if errMsg, ok := validateRefName(req.Name, "分支"); !ok {
		shared.Error(c, http.StatusBadRequest, errMsg, nil)
		return
	}

	index, ok := resolveStashRef(c, p.Path, req.Index, req.Hash)
	if !ok {
		return
	}

	output, err := git.StashBranch(p.Path, req.Name, index)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// StashDiff 查看指定 stash 的内容 diff（含 untracked 文件；路径段可为列表
// index 或完整 commit hash——hash 稳定引用先解析为当前栈位，语义约束见
// git.StashShow 与 git.ResolveStashIndex 注释）
func StashDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	index, hash, ok := parseStashRefParam(c.Param("index"))
	if !ok {
		shared.Error(c, http.StatusBadRequest, "invalid stash reference", nil)
		return
	}
	index, ok = resolveStashRef(c, p.Path, index, hash)
	if !ok {
		return
	}

	output, err := git.StashShow(p.Path, index)
	if err != nil {
		respondGitError(c, "Stash operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// 删除Stash（路径段可为列表 index 或完整 commit hash；语义同 StashDiff）
func DeleteStash(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	index, hash, ok := parseStashRefParam(c.Param("index"))
	if !ok {
		shared.Error(c, http.StatusBadRequest, "invalid stash reference", nil)
		return
	}
	index, ok = resolveStashRef(c, p.Path, index, hash)
	if !ok {
		return
	}

	if err := git.StashDrop(p.Path, index); err != nil {
		respondGitError(c, "Stash operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "stash dropped"})
}
