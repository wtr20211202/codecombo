package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/filepolicy"
	"codecombo/server/git"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// 获取差异
func GetDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	staged := c.Query("staged") == "true"
	diff, err := git.GetDiff(p.Path, staged)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": filepolicy.DecodeDisplay(diff)})
}

// 获取指定文件差异
func GetFileDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	staged := c.Query("staged") == "true"
	diff, err := git.GetFileDiff(p.Path, file, staged)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": filepolicy.DecodeDisplay(diff)})
}

// 获取某次提交的差异（支持 file 参数获取单文件差异，避免传输整个 commit 的 diff）
func GetCommitDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	commit := c.Param("commit")
	if commit == "" {
		shared.Error(c, http.StatusBadRequest, "commit parameter required", nil)
		return
	}

	file := c.Query("file")
	var diff string
	var err error
	if file != "" {
		diff, err = git.GetCommitFileDiff(p.Path, commit, file)
	} else {
		diff, err = git.GetCommitDiff(p.Path, commit)
	}
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": filepolicy.DecodeDisplay(diff)})
}

// 获取文件Blame
func GetBlame(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	// 可选 ref：按该提交/引用 blame（blame 上一版导航 P-20261002-65），
	// 缺省为空 = 工作树当前态，行为不变
	ref := c.Query("ref")

	blame, err := git.GetBlame(p.Path, file, ref)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}
	// 内容行是磁盘原始字节（GBK 等非 UTF-8 文件会乱码）：逐行解码展示，
	// 不回写无损坏风险
	for i := range blame {
		blame[i].Content = filepolicy.DecodeDisplay(blame[i].Content)
	}

	c.JSON(http.StatusOK, gin.H{"data": blame})
}

// 获取文件的hunk列表
func GetFileHunks(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	staged := c.Query("staged") == "true"
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	hunks, err := git.GetFileHunks(p.Path, file, staged)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}
	// hunk 内容行按磁盘原编码逐行解码展示；StageHunk/UnstageHunk 走 git 层
	// 内部原始 diff 重新派生，不经过本 handler，解码不会污染暂存 patch
	for i := range hunks {
		hunks[i].Content = filepolicy.DecodeDisplay(hunks[i].Content)
	}

	c.JSON(http.StatusOK, gin.H{"data": hunks})
}

// 暂存单个hunk
func StageHunk(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		File      string `json:"file" binding:"required"`
		HunkIndex int    `json:"hunkIndex"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Diff operation failed", err)
		return
	}

	if err := git.StageHunk(p.Path, req.File, req.HunkIndex); err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	// apply --cached 走 execGitWithStdin，不经 execGitWithEnv 的统一失效钩子，
	// gitops 层 status 3s TTL 缓存须就地失效——否则 hunk 动作后前端紧随的
	// status 重拉拿到陈旧状态且无后续刷新触发（P-20261004-25 内嵌 diff 点亮
	// 链：行状态翻转依赖这次重拉）。unstage/discard 同
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "hunk staged"})
}

// 取消暂存单个hunk
func UnstageHunk(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		File      string `json:"file" binding:"required"`
		HunkIndex int    `json:"hunkIndex"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Diff operation failed", err)
		return
	}

	if err := git.UnstageHunk(p.Path, req.File, req.HunkIndex); err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "hunk unstaged"})
}

// 回滚工作区单个hunk（P-20261003-49）。块已被再改（apply -R 上下文失配）时
// 回 409——dev 模式响应体带稳定标记 hunk no longer applies，前端
// KNOWN_ERROR_I18N 映射「此变更块已变化，无法直接回滚」；其余错误同
// stage/unstage 走 500
func DiscardHunk(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		File      string `json:"file" binding:"required"`
		HunkIndex int    `json:"hunkIndex"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Diff operation failed", err)
		return
	}

	if err := git.DiscardHunk(p.Path, req.File, req.HunkIndex); err != nil {
		if errors.Is(err, git.ErrHunkDiscardConflict) {
			// 409 + git.hunk_conflict：agent 自纠=重拉 diff 按新内容重新决策
			//（marker 仍在 dev 模式错误文本中，前端 KNOWN_ERROR_I18N 映射不受影响）
			shared.ErrorWithCode(c, shared.CodeGitHunkConflict, "change block has changed, cannot discard directly", err)
			return
		}
		respondGitError(c, "Diff operation failed", err)
		return
	}

	// 同 StageHunk/UnstageHunk：apply -R 改了工作区，status 缓存就地失效
	InvalidateGitStatusCache(p.Path)

	c.JSON(http.StatusOK, gin.H{"message": "hunk discarded"})
}

// 分支对比：获取两个分支之间的文件差异列表
func GetBranchDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		shared.Error(c, http.StatusBadRequest, "from and to parameters required", nil)
		return
	}

	diffs, err := git.GetBranchDiff(p.Path, from, to)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": diffs})
}

// 分支对比：获取两个分支之间某个文件的详细 diff
func GetBranchFileDiff(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	from := c.Query("from")
	to := c.Query("to")
	file := c.Query("file")
	if from == "" || to == "" || file == "" {
		shared.Error(c, http.StatusBadRequest, "from, to and file parameters required", nil)
		return
	}

	diff, err := git.GetBranchFileDiff(p.Path, from, to, file)
	if err != nil {
		respondGitError(c, "Diff operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": filepolicy.DecodeDisplay(diff)})
}

// 工作区逐文件行数统计（P-20261003-219 变更树「复制变更摘要」数据面）：
// GET /api/projects/:id/numstat——工作区相对 HEAD 的 numstat（含已暂存）+
// 未跟踪新文件行数补计，前端按需取数（点击「复制变更摘要」时一次 GET），
// 不并入 status 列表返回——status 是 boot/WS 事件/自动刷新反复打的热路径，
// numstat 的第二次 git 子进程调用会平白翻倍其开销。只读面，不入项目硬锁写族
func GetNumstat(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// GetWorktreeNumstat 尽力而为不返回错误（空仓库等降级为部分数据，见其注）
	files := git.GetWorktreeNumstat(p.Path)
	c.JSON(http.StatusOK, gin.H{"data": files})
}
