package gitops

import (
	shared "codecombo/server/api/shared"
	"net/http"

	"codecombo/server/git"
	"github.com/gin-gonic/gin"
)

// ListTasks 返回项目所有可用任务（npm/Make/Maven/Gradle/Go/Cargo/Python/Just/Taskfile/VSCode/Scripts）
// 一次请求扫描所有 manifest，避免前端多次 readFile 触发 404
func ListTasks(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	tasks, err := git.DetectTasks(p.Path)
	if err != nil {
		respondGitError(c, "Task operation failed", err)
		return
	}
	if tasks == nil {
		tasks = []git.TaskItem{}
	}
	// 沿用项目其他 API 约定：{data: [...]} 便于前端 axios 拦截器统一处理
	c.JSON(http.StatusOK, gin.H{"data": tasks})
}
