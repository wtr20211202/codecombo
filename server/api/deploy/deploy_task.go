package deploy

import (
	"context"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/remote"
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/deploy"
	"codecombo/server/errmarkers"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// hostBusyPrefix 部署互斥句模板的稳定前缀（errmarkers.DeployHostBusyTemplate 首个
// 占位符之前的段，init 期从常量派生、不复刻字面量）：模板由 manager 实例化
// （句中嵌持锁任务 id），TriggerDeploy 据此前缀识别 NoWait 互斥拒绝并附
// deploy.host_busy，免改 server/deploy 的错误返回形态
var hostBusyPrefix = func() string {
	if i := strings.Index(errmarkers.DeployHostBusyTemplate, "%"); i >= 0 {
		return errmarkers.DeployHostBusyTemplate[:i]
	}
	return errmarkers.DeployHostBusyTemplate
}()

// triggerDeployReq 触发部署请求
type triggerDeployReq struct {
	HostID    string                    `json:"hostId" binding:"required"`
	Instances []config.DeployerInstance `json:"instances" binding:"required"`
	// NoWait 不等候（P-20261004-36）：同主机已有在途任务时直接拒绝（P-41 语义
	// 保留，表单「不等候」开关）。缺省 false = 排队模式
	NoWait bool `json:"noWait"`
}

// TriggerDeploy 启动一个部署任务
func TriggerDeploy(c *gin.Context) {
	var req triggerDeployReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "deploy trigger failed", err)
		return
	}
	mgr := deploy.DefaultManager()
	if mgr == nil {
		shared.Error(c, http.StatusInternalServerError, "deploy manager not initialized", nil)
		return
	}
	rh, err := store.Get().RemoteHost.Get(req.HostID)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	// SshKeyID 解析为 PemContent
	if err := remote.ResolveRemoteHostAuth(rh); err != nil {
		shared.Error(c, http.StatusBadRequest, "resolve ssh key failed", err)
		return
	}
	cfg, err := store.Get().DeployConfig.Get()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "load deploy config failed", err)
		return
	}
	// 部署任务生命周期独立于触发它的 HTTP 请求
	// 不能用 c.Request.Context()——HTTP 响应返回后该 ctx 会被 cancel，
	// 会导致后台 goroutine 立刻收到 ctx.Done，任务被错误标记为 cancelled
	taskID, err := mgr.Trigger(context.Background(), deploy.TriggerRequest{
		HostID:    req.HostID,
		Instances: req.Instances,
		NoWait:    req.NoWait,
	}, rh, cfg)
	if err != nil {
		// 同主机互斥拒绝 → deploy.host_busy：agent 自纠=核对在途任务（句中含持锁
		// 任务 id），等它结束或先取消，勿重复触发；其余触发失败保持无 code 旧形态
		if strings.Contains(err.Error(), hostBusyPrefix) {
			shared.ErrorWithCode(c, shared.CodeDeployHostBusy, "deploy trigger failed", err)
			return
		}
		shared.Error(c, http.StatusBadRequest, "deploy trigger failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"taskId": taskID})
}

// deployTaskDetailResp 任务详情响应：内嵌任务全字段，queued 排队态附队列位次
// （P-20261004-36）。位次是动态内存态不入库，读时从 Manager 等待队列现算
type deployTaskDetailResp struct {
	config.DeployTask
	QueuePosition int `json:"queuePosition,omitempty"`
}

// GetDeployTask 查询任务状态
func GetDeployTask(c *gin.Context) {
	id := c.Param("taskId")
	task, err := store.Get().DeployTask.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "task not found", err)
		return
	}
	resp := deployTaskDetailResp{DeployTask: *task}
	// 排队态附位次（P-20261004-36）：仅排队中的任务有动态位次；0（不在队，
	// Manager 未装配等）时 omitempty 省略，不展示误导性的「第 0 位」
	if task.Status == config.TaskStatusQueued && task.WaitingFor != "" {
		if mgr := deploy.DefaultManager(); mgr != nil {
			resp.QueuePosition = mgr.QueuePosition(task.ID)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// CancelDeployTask 取消任务
func CancelDeployTask(c *gin.Context) {
	id := c.Param("taskId")
	mgr := deploy.DefaultManager()
	if mgr == nil {
		shared.Error(c, http.StatusInternalServerError, "deploy manager not initialized", nil)
		return
	}
	if !mgr.Cancel(id) {
		c.JSON(http.StatusOK, gin.H{"ok": false, "reason": "task not running"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ListDeployTasks 列出最近的部署任务
func ListDeployTasks(c *gin.Context) {
	tasks, err := store.Get().DeployTask.ListRecent(20)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "list tasks failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": tasks})
}

// GetDeployTaskLog GET /api/deploy/:taskId/log（P-20261003-142 部署日志下载；
// P-20261007-8 二阶段长期留档落盘读路）双源幂等直出 text/plain 附件：内存窗
// 内（含运行中/终态 1h TTL）优先内存日志环（X-Deploy-Log-Source: memory）；
// 内存 miss 读车道 2 留档快照（<DataDir>/artifacts/deploy-logs/<taskId>.log，
// 终态收尾点落盘、寿命同任务记录 30 天）命中直出（X-Deploy-Log-Source:
// persisted）——30 天内任务三入口（部署详情/历史/通知）全部可下；落盘也无
// （首启前历史任务/cancelled 不入档/落盘写失败）任务记录仍在存库 → 410 携
// 稳定标记 deploy.LogExpiredMarker 明确「不可下载」语义不变；任务不存在 →
// 404 与 GetDeployTask 同语义。下载头经 P-109 统一净化 helper（下载端点禁手拼）
func GetDeployTaskLog(c *gin.Context) {
	id := c.Param("taskId")
	mgr := deploy.DefaultManager()
	if mgr == nil {
		shared.Error(c, http.StatusServiceUnavailable, "deploy manager not initialized", nil)
		return
	}
	entries, inMem := mgr.LogEntries(id)
	task, taskErr := store.Get().DeployTask.Get(id)
	if inMem {
		serveDeployLogText(c, task, id, deploy.RenderLogText(task, entries), deploy.LogSourceMemory)
		return
	}
	if taskErr != nil {
		shared.Error(c, http.StatusNotFound, "task not found", nil)
		return
	}
	// 内存窗外（TTL 过期/进程重启内存清空）：回源落盘快照——升级前终态的任务
	// 无留档文件，ReadPersistedLog 不命中，走既有 410（升级兼容零迁移）
	if body, ok := deploy.ReadPersistedLog(id); ok {
		serveDeployLogText(c, task, id, body, deploy.LogSourcePersisted)
		return
	}
	shared.Error(c, http.StatusGone, deploy.LogExpiredMarker+
		" (task logs are kept in memory for 1h after the task finished)", nil)
}

// serveDeployLogText 留档体直出：附件头（下载名同族净化）+ 来源标注响应头
// （memory=实时窗 / persisted=留档回放，e2e 与 agent 读路断言锚点）
func serveDeployLogText(c *gin.Context, task *config.DeployTask, id string, body []byte, source string) {
	// 内存窗内但存库读异常（trigger 即落库，正常到不了）：降级按 nil task 出
	// 日志体——留档不被元数据读失败挡住，文件名回退任务 id
	name := deploy.LogDownloadName(taskHostLabel(task), id, time.Now())
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.Header(deploy.LogSourceHeader, source)
	c.Data(http.StatusOK, "text/plain; charset=utf-8", body)
}

// taskHostLabel 下载名/日志头用主机标识：存库任务冗余的 Host 地址，缺省回退任务 id
func taskHostLabel(task *config.DeployTask) string {
	if task != nil && task.Host != "" {
		return task.Host
	}
	return ""
}
