package gitops

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/model"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// gitRefNamePattern 校验 Git 引用名（分支/标签）的基本合法性
// 不允许以 . 或 - 开头，不允许包含空格、~、^、:、\、控制字符等
var gitRefNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_\-\./]*$`)

func validateRefName(name, label string) (string, bool) {
	if name == "" {
		return label + "名称不能为空", false
	}
	if len(name) > 200 {
		return label + "名称过长（最多200字符）", false
	}
	if !gitRefNamePattern.MatchString(name) {
		return label + "名称包含非法字符，只允许字母、数字、_、-、.、/", false
	}
	return "", true
}

// 获取分支列表
func ListBranches(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：分支列表为空而非 500，前端 Git 面板静默降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []model.Branch{}})
		return
	}

	branches, err := git.GetBranches(p.Path)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	// mergePreviewSupported（P-20261005-174 合并预演）：本机 git 是否支持
	// merge-tree 现代模式（≥2.38，SupportsStashStaged 同款进程级缓存探测）。
	// 顺带下发（stagedSupported 先例）供前端隐藏「预演」入口；once 缓存后
	// 逐请求零额外探测开销。data 形状不变，旧前端兼容
	c.JSON(http.StatusOK, gin.H{"data": branches, "mergePreviewSupported": git.MergeTreeSupported()})
}

// 创建分支
func CreateBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CreateBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if errMsg, ok := validateRefName(req.Name, "分支"); !ok {
		shared.Error(c, http.StatusBadRequest, errMsg, nil)
		return
	}

	if err := git.CreateBranch(p.Path, req.Name, req.Checkout); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "branch created"})
}

// 切换分支
func CheckoutBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CheckoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	// 自动暂存链（P-20261003-203）：stash → checkout → stash pop 一次完成。
	// 成功响应附结构化 autoStash 结果——pop 冲突不是错误（切换已成功，stash
	// 条目按 git pop 语义保留、变更不丢），前端按 stashKept 分支提示
	if req.AutoStash {
		res, err := git.CheckoutWithAutoStash(p.Path, req.Branch)
		if err != nil {
			respondGitError(c, "Branch operation failed", err)
			return
		}
		resp := gin.H{
			"message": "branch switched",
			"autoStash": gin.H{
				"stashed":   res.Stashed,
				"restored":  res.Restored,
				"stashKept": res.StashKept,
			},
		}
		attachRecoverableStash(resp, p.Path, req.Branch)
		c.JSON(http.StatusOK, resp)
		return
	}

	if err := git.Checkout(p.Path, req.Branch); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	resp := gin.H{"message": "branch switched"}
	attachRecoverableStash(resp, p.Path, req.Branch)
	c.JSON(http.StatusOK, resp)
}

// attachRecoverableStash 恢复提示字段（P-20261006-48）：检出成功后查 stash 列表
// 是否有属于目标分支的 autoStash 条目（On <branch>: 与 auto: checkout to 双注记
// 匹配、多条取最新），有则附 recoverableStash——P-203 冲突提示「可切回原分支恢复」
// 的闭环最后一环，前端据此出「一键恢复」入口，agent 亦可编程消费（切回→自动 pop
// 的分支例程原语）。checkout 不动 stash 栈，检出成功后查与切前查等价，但只在
// 成功路径附字段（失败响应不携带半截提示）；无命中不带字段（响应增量，旧前端
// 零触及）
func attachRecoverableStash(resp gin.H, repoPath string, branch string) {
	if rec, ok := git.FindRecoverableAutoStash(repoPath, branch); ok {
		resp["recoverableStash"] = rec
	}
}

// CheckoutAndUpdate 切换分支并拉取远程变更
func CheckoutAndUpdateBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CheckoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if err := git.CheckoutAndUpdate(p.Path, req.Branch); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "branch switched and updated"})
}

// 删除分支
func DeleteBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 支持从 URL 参数或查询参数获取分支名（分支名可能包含 /）
	name := c.Param("name")
	if name == "" {
		name = c.Query("name")
	}
	force := c.Query("force") == "true"

	if name == "" {
		shared.Error(c, http.StatusBadRequest, "branch name is required", nil)
		return
	}

	if err := git.DeleteBranch(p.Path, name, force); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "branch deleted"})
}

// RenameBranch 重命名分支
func RenameBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		OldName string `json:"oldName" binding:"required"`
		NewName string `json:"newName" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if errMsg, ok := validateRefName(req.NewName, "分支"); !ok {
		shared.Error(c, http.StatusBadRequest, errMsg, nil)
		return
	}

	if err := git.RenameBranch(p.Path, req.OldName, req.NewName); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "branch renamed"})
}

// mergeStrategyLabel 审计 Detail 的语言中立策略段：空策略显示 default
// （rebasePlanSummary 英文动词段同取向，审计行不随界面语言漂移）
func mergeStrategyLabel(strategy string) string {
	if strategy == git.MergeStrategyDefault {
		return "default"
	}
	return strategy
}

// 合并分支。strategy 透传合并策略（P-20261007-18）：""=默认（历史语义零回归）、
// "squash"=压平合并（git merge --squash + 单条汇总提交）；白名单枚举校验，
// 非法 400。merge 直接改写当前分支，成败均入审计（git.merge，Detail 带
// strategy= 段）；冲突 409 携 git 输出（既有契约不变，squash 冲突保留索引
// 冲突态走冲突解决域）
func MergeBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.MergeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}
	if req.Strategy != git.MergeStrategyDefault && req.Strategy != git.MergeStrategySquash {
		shared.Error(c, http.StatusBadRequest,
			fmt.Sprintf("invalid merge strategy %q (must be %q or empty)", req.Strategy, git.MergeStrategySquash), nil)
		return
	}

	detail := fmt.Sprintf("%s: merge %s (strategy=%s)", p.Name, req.Source, mergeStrategyLabel(req.Strategy))
	output, err := git.Merge(p.Path, req.Source, req.Strategy, req.Message)
	if err != nil {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditGitMerge,
			Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: detail,
		})
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditGitMerge,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
	c.JSON(http.StatusOK, gin.H{"data": output})
}

// 变基
func RebaseBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.RebaseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	output, err := git.Rebase(p.Path, req.Branch)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// GetRebaseTodo 获取可 rebase 的提交列表。onto 为空 = 根提交区间（全历史），
// 与执行端点的 --root 语义对齐；带 commit 参数时（「整理自此提交起」产品语义）
// 服务端换算基准 = 该提交的父（根提交自动落 root 区间）
func GetRebaseTodo(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	onto := c.Query("onto")
	if commit := c.Query("commit"); commit != "" {
		parent, isRoot, err := git.CommitParent(p.Path, commit)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
			return
		}
		onto = ""
		if !isRoot {
			onto = parent
		}
	}

	actions, err := git.GetRebaseTodo(p.Path, onto)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	// onto 随列表回传（commit 参数换算出的基准）：执行端点要求同一 onto，
	// 前端零二次换算
	c.JSON(http.StatusOK, gin.H{"data": actions, "onto": onto})
}

// rebasePlanSummary 审计 Detail 的语言中立动作摘要：`5 steps (2 pick, 1 squash, 1 drop, 1 reword)`
func rebasePlanSummary(actions []git.RebaseAction) string {
	counts := map[string]int{}
	var order []string
	for _, a := range actions {
		if _, ok := counts[a.Action]; !ok {
			order = append(order, a.Action)
		}
		counts[a.Action]++
	}
	parts := make([]string, 0, len(order))
	for _, act := range order {
		parts = append(parts, strconv.Itoa(counts[act])+" "+act)
	}
	return fmt.Sprintf("%d steps (%s)", len(actions), strings.Join(parts, ", "))
}

// InteractiveRebase 执行交互式 rebase 计划（重排/squash/drop/reword 可视化
// 编辑器与 agent 程序化整理共用）。步数上限约束误操作半径；区间含已推送
// 提交须 confirmPushed（409 + 受影响远程分支，前端确认后重试，对齐 reword
// 两段式）；失败服务端已 abort 回原状；成败均入审计（历史改写面留痕）
func InteractiveRebase(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Onto          string             `json:"onto"`
		Actions       []git.RebaseAction `json:"actions" binding:"required"`
		ConfirmPushed bool               `json:"confirmPushed"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}
	if len(req.Actions) > git.MaxRebasePlanSteps {
		shared.Error(c, http.StatusBadRequest, fmt.Sprintf("too many steps in rebase plan (max %d)", git.MaxRebasePlanSteps), nil)
		return
	}

	detail := fmt.Sprintf("%s: %s", p.Name, rebasePlanSummary(req.Actions))
	result, err := git.InteractiveRebase(p.Path, req.Onto, req.Actions, req.ConfirmPushed)
	if errors.Is(err, git.ErrRebaseRangePushed) {
		// 409 + 影响面明细：前端弹强警告（列出包含区间提交的远程分支，
		// 改写后须 force-with-lease 推送）后携带确认重试
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditGitRebase,
			Result: store.AuditResultDenied,
			IP:     c.ClientIP(),
			Detail: detail + " — pushed commits need confirm",
		})
		c.JSON(http.StatusConflict, gin.H{
			"error":          err.Error(),
			"remoteBranches": result.RemoteBranches,
		})
		return
	}
	if err != nil {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditGitRebase,
			Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: detail,
		})
		respondGitError(c, "Branch operation failed", err)
		return
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditGitRebase,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
	c.JSON(http.StatusOK, gin.H{"message": "rebase completed"})
}

// AbortRebase 中止 rebase
func AbortRebase(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.AbortRebase(p.Path); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "rebase aborted"})
}

// ContinueRebase 继续 rebase
func ContinueRebase(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := git.ContinueRebase(p.Path); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "rebase continued"})
}

// 获取标签列表

// GetConflictFiles 获取冲突文件列表
func GetConflictFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：静默返回空列表而非 500，前端 Git 面板降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []any{}})
		return
	}

	conflicts, err := git.GetConflictFiles(p.Path)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	// inProgress：顺带返回进行中的有序操作（rebase/merge/cherry-pick/""），
	// 前端在冲突全解后据此显示「继续变基/完成合并」操作条（data 形状不变，旧前端兼容）
	c.JSON(http.StatusOK, gin.H{"data": conflicts, "inProgress": git.OperationInProgress(p.Path)})
}

// ResolveConflict 解决冲突
func ResolveConflict(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		File     string `json:"file" binding:"required"`
		Strategy string `json:"strategy"` // ours, theirs, manual
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if err := git.ResolveConflict(p.Path, req.File, req.Strategy); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "conflict resolved"})
}

// ResolveConflictWithContent 使用自定义内容解决冲突。
// baseHash（P-20261004-27）可选：调用方载入解析时的磁盘内容 hash（冲突内容
// 读取端点回传），非空时写回前与磁盘当前内容比对，失配 409 携 currentContent
// （契约对齐 files.WriteFile 的陈旧写防护；resolve 标记仅在写回成功路径触达）；
// 空 = 旧调用方兼容直写
func ResolveConflictWithContent(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		File     string `json:"file" binding:"required"`
		Content  string `json:"content" binding:"required"`
		Encoding string `json:"encoding,omitempty"` // 读取时探测的原编码：按原编码落盘
		BaseHash string `json:"baseHash,omitempty"` // 载入解析时的磁盘 hash：非空即乐观锁比对
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	err := git.ResolveConflictWithContent(p.Path, req.File, req.Content, req.Encoding, req.BaseHash)
	var stale *git.ConflictStaleError
	if errors.As(err, &stale) {
		// 409 + git.conflict_stale 携 currentContent（files.WriteFile 陈旧写防护
		// 同形）：agent 自纠=重读现状再决策；JSONWithCode 附加 code、status 仍由
		// 注册表派生（与迁移前手拼 409 一致）
		shared.JSONWithCode(c, shared.CodeGitConflictStale, gin.H{
			"error":          err.Error(),
			"currentContent": stale.CurrentContent,
		})
		return
	}
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	// 标记为已解决（仅写回成功路径触达：409 拒绝时不得 git add，防把他人
	// 窗口期改动以「已解决」状态暂存）
	_ = git.ResolveConflict(p.Path, req.File, "manual")

	c.JSON(http.StatusOK, gin.H{"message": "conflict resolved"})
}

// GetConflictContent 获取冲突文件内容。
// P-20261004-27 扩展：响应新增 hash（磁盘当前内容 sha256 hex，files 域
// ReadFile 的 hash 字段同款）——前端以此为 baseHash 随 resolve-content 回传，
// 服务端写回前比对，冲突解决从盲写覆盖变失配可感知重解析
func GetConflictContent(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	cc, err := git.GetConflictContent(p.Path, file)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": cc.Content, "encoding": cc.Encoding, "hash": cc.Hash})
}

// GetConflictParsed 获取解析后的冲突内容（ours/theirs）
// P-20261003-59 扩展：响应新增 hunks（逐块分段）与 complex（复杂形态降级旗标），
// 既有 data（整文件 ours/theirs）原样保留——旧前端不受影响
// P-20261004-27 扩展：响应新增 hash（同 GetConflictContent，逐块合成的写回
// 乐观锁基线）
func GetConflictParsed(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	cc, err := git.GetConflictContent(p.Path, file)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	content := cc.Content
	sections := git.ParseConflictContent(content)
	// complex=true（diff3/嵌套/未闭合标记）：前端降级整文件模式，不消费 hunks；
	// nil 归一为空数组——ok 时 hunks 恒为数组，前端免 null 分支
	hunks, ok := git.ParseConflictHunks(content)
	if hunks == nil {
		hunks = []git.ConflictHunk{}
	}
	c.JSON(http.StatusOK, gin.H{"data": sections, "hunks": hunks, "complex": !ok, "hash": cc.Hash})
}

// 获取标签列表（实际）
func ListTags(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：静默返回空列表而非 500，前端 Git 面板降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []any{}})
		return
	}

	tags, err := git.GetTags(p.Path)
	if err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": tags})
}

// 创建标签
func CreateTag(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CreateTagRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if errMsg, ok := validateRefName(req.Name, "标签"); !ok {
		shared.Error(c, http.StatusBadRequest, errMsg, nil)
		return
	}

	if err := git.CreateTag(p.Path, req); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "tag created"})
}

// 删除标签
func DeleteTag(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 支持从 URL 参数或查询参数获取标签名（标签名可能包含 /）
	name := c.Param("name")
	if name == "" {
		name = c.Query("name")
	}
	if name == "" {
		shared.Error(c, http.StatusBadRequest, "tag name is required", nil)
		return
	}

	if err := git.DeleteTag(p.Path, name); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "tag deleted"})
}

// Cherry-pick
func CherryPick(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.CherryPickRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	output, err := git.CherryPick(p.Path, req.Commit)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// Revert
func RevertCommit(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.RevertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	output, err := git.Revert(p.Path, req.Commit)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "output": output})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// Reset
func ResetRepo(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.ResetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if err := git.Reset(p.Path, req.Mode, req.Commit); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "reset completed"})
}

// 远程操作函数（需导入strconv用于ParseInt）
var _ = strconv.Itoa

// SetUpstream 设置本地分支跟踪远程分支
func SetUpstream(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Branch       string `json:"branch" binding:"required"`
		Remote       string `json:"remote" binding:"required"`
		RemoteBranch string `json:"remoteBranch" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Branch operation failed", err)
		return
	}

	if err := git.SetBranchUpstream(p.Path, req.Branch, req.Remote, req.RemoteBranch); err != nil {
		respondGitError(c, "Branch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "upstream set"})
}

var _ = strconv.Itoa
