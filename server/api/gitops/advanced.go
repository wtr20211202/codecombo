package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/filepolicy"
	"codecombo/server/git"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// gitBadInputErr 判定 git 错误是否源于调用方输入（未知 revision / 不存在的
// 路径）：这类错误映射 400 而非 500——非法 ref/path 是普通客户端输入，
// 返回 5xx 会误导监控与调用方重试（snapshot-api e2e 的 4xx 断言即守护此语义）
func gitBadInputErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, marker := range []string{
		"invalid object name",     // git show/ls-tree: fatal: invalid object name 'xxx'
		"not a valid object name", // git ls-tree: fatal: Not a valid object name xxx
		"unknown revision or path not in the working tree",
		"does not exist in",                      // git show: path 'x' does not exist in '<ref>'
		"did not match any file(s) known to git", // pathspec 未命中
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

// SquashCommits 合并多个提交
func SquashCommits(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Commits []string `json:"commits" binding:"required"`
		Message string   `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Git operation failed", err)
		return
	}

	if len(req.Commits) < 2 {
		shared.Error(c, http.StatusBadRequest, "At least 2 commits required", nil)
		return
	}

	if err := git.SquashCommits(p.Path, req.Commits, req.Message); err != nil {
		respondGitError(c, "Git operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "commits squashed"})
}

// DropCommit 删除指定提交
func DropCommit(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Commit string `json:"commit" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Git operation failed", err)
		return
	}

	if err := git.DropCommit(p.Path, req.Commit); err != nil {
		respondGitError(c, "Git operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "commit dropped"})
}

// GetDirectoryLog 获取目录的提交历史
func GetDirectoryLog(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	dirPath := c.Query("path")
	if dirPath == "" {
		shared.Error(c, http.StatusBadRequest, "path parameter required", nil)
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	skip, _ := strconv.Atoi(c.DefaultQuery("skip", "0"))

	commits, err := git.GetDirectoryLog(p.Path, dirPath, limit, skip)
	// 空仓语义与 GetLog 同源（respondCommits：零提交仓库 200 + emptyRepo 标志）
	respondCommits(c, p.Path, commits, err, "Git operation failed")
}

// ListTreeAtRef 浏览指定版本下的文件树
func ListTreeAtRef(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	ref := c.Query("ref")
	if ref == "" {
		shared.Error(c, http.StatusBadRequest, "ref parameter required", nil)
		return
	}

	path := c.Query("path")

	entries, err := git.ListTreeAtRef(p.Path, ref, path)
	if err != nil {
		if gitBadInputErr(err) {
			shared.Error(c, http.StatusBadRequest, "Invalid ref or path", err)
			return
		}
		respondGitError(c, "Git operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// ShowFileAtRef 获取指定版本下的文件内容
func ShowFileAtRef(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	ref := c.Query("ref")
	filePath := c.Query("path")
	if ref == "" || filePath == "" {
		shared.Error(c, http.StatusBadRequest, "ref and path parameters required", nil)
		return
	}

	content, err := git.ShowFileAtRef(p.Path, ref, filePath)
	if err != nil {
		if gitBadInputErr(err) {
			shared.Error(c, http.StatusBadRequest, "Invalid ref or path", err)
			return
		}
		respondGitError(c, "Git operation failed", err)
		return
	}
	// 历史版本内容是 git 原始字节：按探测编码解码展示（diff 视图对比基线、
	// 文件历史等只读场景，无写回链路）
	content, _ = filepolicy.DecodeText([]byte(content))

	c.JSON(http.StatusOK, gin.H{"data": content})
}

// ExtractChanges 从提交中提取指定文件为独立新提交
func ExtractChanges(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Commit  string   `json:"commit" binding:"required"`
		Files   []string `json:"files" binding:"required"`
		Message string   `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Git operation failed", err)
		return
	}

	if err := git.ExtractChanges(p.Path, req.Commit, req.Files, req.Message); err != nil {
		respondGitError(c, "Git operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "changes extracted"})
}
