package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/model"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// 获取提交日志
func GetLog(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：提交历史为空而非 500，前端 Git 面板静默降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []model.Commit{}})
		return
	}

	branch := c.Query("branch")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	// 钳制上限：limit 直通 `git log -n`，异常大值（10^9）等于让 git 全量遍历
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}

	// range=ahead：推送前预览——当前分支领先 upstream 的提交清单（P-20261003-151）。
	// range 语义自持 revset（@{upstream}..HEAD），branch/author/since/until 等过滤
	// 参数不参与；上游缺失/未 tracking 返回空列表 + noUpstream 标志（前端跳过
	// 预览只留计数注记）而非 500。响应只增量加 noUpstream 字段，既有 branch 模式
	// 响应形态不变
	if c.Query("range") == "ahead" {
		aheadLimit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
		if aheadLimit <= 0 || aheadLimit > 100 {
			aheadLimit = 20
		}
		commits, noUpstream, err := git.GetAheadLog(p.Path, aheadLimit)
		if err != nil {
			respondGitError(c, "Log operation failed", err)
			return
		}
		resp := gin.H{"data": commits}
		if noUpstream {
			resp["noUpstream"] = true
		}
		c.JSON(http.StatusOK, resp)
		return
	}

	// range=compare：分支比较弹层的提交区间（P-20261003-233）。from=基线（弹层
	// 合入目标侧：当前分支/HEAD），to=参照（分支/Tag/hash）；unique=1 → from..to
	// 单向（仅参照独有 = 待合入审阅聚焦），缺省 → from...to 对称差（双向全量）。
	// 基线缺失（from 不可解析）降级返回 to 全量历史 + noBase 标志——响应形态沿
	// P-151 noUpstream 先例只增量加标志字段，既有 branch/range=ahead 模式不变
	if c.Query("range") == "compare" {
		to := c.Query("to")
		if to == "" {
			shared.Error(c, http.StatusBadRequest, "to parameter required", nil)
			return
		}
		compareLimit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
		if compareLimit <= 0 {
			compareLimit = 100
		}
		if compareLimit > 200 {
			compareLimit = 200
		}
		commits, noBase, err := git.GetCompareLog(p.Path, c.Query("from"), to, c.Query("unique") == "1", compareLimit)
		if err == nil {
			resp := gin.H{"data": commits}
			if noBase {
				resp["noBase"] = true
			}
			c.JSON(http.StatusOK, resp)
			return
		}
		if git.IsNoCommitsError(p.Path, err) {
			c.JSON(http.StatusOK, gin.H{"data": []model.Commit{}, "emptyRepo": true})
			return
		}
		respondGitError(c, "Log operation failed", err)
		return
	}

	skip, _ := strconv.Atoi(c.DefaultQuery("skip", "0"))
	author := c.Query("author")
	since := c.Query("since")
	until := c.Query("until")

	commits, err := git.GetLog(p.Path, branch, limit, skip, author, since, until)
	respondCommits(c, p.Path, commits, err, "Log operation failed")
}

// respondCommits 提交历史类端点（GetLog/SearchLog/GetFileLog/GetDirectoryLog）
// 的统一响应出口：零提交仓库（git init 后未提交）的 git log 以 fatal 128 失败，
// 属「还没有提交」的正常状态而非错误——命中 IsNoCommitsError 时 200 返回空列表
// 并携 emptyRepo 标志（前端据此渲染引导空态而非红色报错），其余错误照常 500。
func respondCommits(c *gin.Context, repoPath string, commits []model.Commit, err error, errMsg string) {
	if err == nil {
		c.JSON(http.StatusOK, gin.H{"data": commits})
		return
	}
	if git.IsNoCommitsError(repoPath, err) {
		c.JSON(http.StatusOK, gin.H{"data": []model.Commit{}, "emptyRepo": true})
		return
	}
	respondGitError(c, errMsg, err)
}

// 获取提交变更文件列表
func GetCommitFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	commit := c.Param("commit")
	if commit == "" {
		shared.Error(c, http.StatusBadRequest, "commit parameter required", nil)
		return
	}

	files, err := git.GetCommitFiles(p.Path, commit)
	if err != nil {
		respondGitError(c, "Log operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": files})
}

// 搜索提交
func SearchLog(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	query := c.Query("query")
	if query == "" {
		shared.Error(c, http.StatusBadRequest, "query parameter required", nil)
		return
	}

	// limit 可选（服务端默认 200 上限）
	limit, _ := strconv.Atoi(c.Query("limit"))
	commits, err := git.SearchLog(p.Path, query, limit)
	respondCommits(c, p.Path, commits, err, "Log operation failed")
}

// 获取文件提交历史
func GetFileLog(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	file := c.Query("file")
	if file == "" {
		shared.Error(c, http.StatusBadRequest, "file parameter required", nil)
		return
	}

	// limit 可选（服务端默认 500 上限）
	limit, _ := strconv.Atoi(c.Query("limit"))
	commits, err := git.GetFileLog(p.Path, file, limit)
	respondCommits(c, p.Path, commits, err, "Log operation failed")
}

// 获取最近提交消息（用于提交消息历史下拉）
func GetRecentMessages(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	messages, err := git.GetRecentMessages(p.Path, 20)
	if err != nil {
		respondGitError(c, "Log operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": messages})
}
