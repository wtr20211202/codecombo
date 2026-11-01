package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/model"
	"net/http"

	"github.com/gin-gonic/gin"
)

// 获取远程仓库列表
func ListRemotes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 非 git 工作区（合法项目类型）：静默返回空列表而非 500，前端 Git 面板降级
	if !git.IsRepo(p.Path) {
		c.JSON(http.StatusOK, gin.H{"data": []any{}})
		return
	}

	remotes, err := git.GetRemotes(p.Path)
	if err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": remotes})
}

// Fetch
func FetchRemote(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.FetchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Remote operation failed", err)
		return
	}

	output, err := git.Fetch(p.Path, req.Remote)
	if err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": output})
}

// Pull
func PullRemote(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.PullRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Remote operation failed", err)
		return
	}

	res, err := git.Pull(p.Path, req.Remote, req.Branch)
	if err != nil {
		body := gin.H{"error": err.Error(), "output": res.Output}
		// 失败恢复 hint（P-20261005-194）：先按错误文本分类（auth/network/lock
		// 等特征在 stderr）；未命中再查仓库冲突态兜底——pull 冲突的 CONFLICT 行
		// 写 stdout、exec 层失败即弃（res.Output 实测为空），stderr 只有 fetch
		// 进度（git 2.45 实测），文本特征判不中，「pull 失败且工作区存在未合并
		// 条目」即冲突类别的事实源（一次 status 读命令，仅失败路径付出）
		if hint, ok := git.ClassifyFailHint(err, res.Output); ok {
			body["hint"] = hint
		} else if conflicts, cerr := git.GetConflictFiles(p.Path); cerr == nil && len(conflicts) > 0 {
			body["hint"] = git.FailHint{Kind: git.FailConflict}
		}
		c.JSON(http.StatusConflict, body)
		return
	}

	// newCommits 增量附带（P-20261003-202）：pull 结果摘要（本次拉进来的新提交数，
	// -1=无法计量）。data 仍为原始输出字符串，旧前端零感知
	c.JSON(http.StatusOK, gin.H{"data": res.Output, "newCommits": res.NewCommits})
}

// 添加远程仓库
func AddRemote(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" || req.URL == "" {
		shared.Error(c, http.StatusBadRequest, "name and url are required", nil)
		return
	}

	if err := git.AddRemote(p.Path, req.Name, req.URL); err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

// 删除远程仓库
func RemoveRemote(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	name := c.Param("name")
	if name == "" {
		shared.Error(c, http.StatusBadRequest, "remote name required", nil)
		return
	}

	if err := git.RemoveRemote(p.Path, name); err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

// Push
func PushRemote(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req model.PushRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Remote operation failed", err)
		return
	}

	res, err := git.Push(p.Path, req)
	if err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	// 增量字段 newBranch（P-20261005-215 首推判定）：data 仍为原始输出，旧前端
	// 零感知——pull 回执增量 newCommits（P-20261003-202）同款惯例。前端仅在
	// 首推（本次推送新建远端分支）时于成功 toast 附「创建 PR」外链入口
	c.JSON(http.StatusOK, gin.H{"data": res.Output, "newBranch": res.NewBranch})
}

// CheckRemoteBranch 检查远程分支是否存在
func CheckRemoteBranch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	remote := c.Query("remote")
	branch := c.Query("branch")
	if remote == "" || branch == "" {
		shared.Error(c, http.StatusBadRequest, "remote and branch are required", nil)
		return
	}

	exists, err := git.BranchExistsOnRemote(p.Path, remote, branch)
	if err != nil {
		respondGitError(c, "Remote operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": exists})
}
