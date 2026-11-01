package sync

import (
	"context"
	"net/http"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// cronRunTimeout 立即试跑的执行生命周期
const cronRunTimeout = 30 * time.Minute

// contextWithTimeout 小包装（单测可替换时钟语义时不必改调用点）
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// 定时同步任务 CRUD（方案⑤；调度执行在 cronrun.go，模块分钟巡检驱动）。

// ListSyncCrons GET /api/sync/crons
func ListSyncCrons(c *gin.Context) {
	crons, err := store.Get().SyncCron.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "sync cron list failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": crons})
}

// CreateSyncCron POST /api/sync/crons
func CreateSyncCron(c *gin.Context) {
	input, ok := bindSyncCron(c)
	if !ok {
		return
	}
	created, err := store.Get().SyncCron.Create(input)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "sync cron create failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": created})
}

// UpdateSyncCron PUT /api/sync/crons/:id
func UpdateSyncCron(c *gin.Context) {
	input, ok := bindSyncCron(c)
	if !ok {
		return
	}
	updated, err := store.Get().SyncCron.Update(c.Param("id"), input)
	if err != nil {
		if err == store.ErrSyncCronNotFound {
			shared.Error(c, http.StatusNotFound, "sync cron not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "sync cron update failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": updated})
}

// DeleteSyncCron DELETE /api/sync/crons/:id
func DeleteSyncCron(c *gin.Context) {
	if err := store.Get().SyncCron.Delete(c.Param("id")); err != nil {
		shared.Error(c, http.StatusNotFound, "sync cron not found", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}

// RunSyncCron POST /api/sync/crons/:id/run —— 立即试跑（agentcron 同名端点语义）
func RunSyncCron(c *gin.Context) {
	t, err := store.Get().SyncCron.Get(c.Param("id"))
	if err != nil {
		shared.Error(c, http.StatusNotFound, "sync cron not found", nil)
		return
	}
	if execRunningFlag() {
		shared.Error(c, http.StatusConflict, "another sync is running", nil)
		return
	}
	// 试跑同步执行（任务耗时可能分钟级——调用方前端已按异步进度消费设计；
	// 与 agentcron 试跑同语义）
	go func() {
		setExecRunning(true)
		defer setExecRunning(false)
		ctx, cancel := contextWithTimeout(cronRunTimeout)
		defer cancel()
		note, result := runSyncCronCtx(ctx, *t)
		_ = store.Get().SyncCron.RecordRun(t.ID, time.Now(), result, note)
	}()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"started": true}})
}

// bindSyncCron 请求体校验与规范化（白名单外的方向/策略归一缺省；时刻钳制
// 0-23/0-59；周几值域校验）
func bindSyncCron(c *gin.Context) (store.SyncCron, bool) {
	var req store.SyncCron
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return store.SyncCron{}, false
	}
	req.Direction = strings.TrimSpace(req.Direction)
	if req.Direction != store.SyncCronDirPull && req.Direction != store.SyncCronDirPush {
		shared.Error(c, http.StatusBadRequest, "direction must be pull or push", nil)
		return store.SyncCron{}, false
	}
	if strings.TrimSpace(req.Name) == "" {
		shared.Error(c, http.StatusBadRequest, "name required", nil)
		return store.SyncCron{}, false
	}
	if len(req.PeerIDs) == 0 {
		shared.Error(c, http.StatusBadRequest, "peerIds required", nil)
		return store.SyncCron{}, false
	}
	if req.Hour < 0 || req.Hour > 23 || req.Minute < 0 || req.Minute > 59 {
		shared.Error(c, http.StatusBadRequest, "invalid hour/minute", nil)
		return store.SyncCron{}, false
	}
	for _, w := range req.Weekdays {
		if w < 0 || w > 6 {
			shared.Error(c, http.StatusBadRequest, "invalid weekday", nil)
			return store.SyncCron{}, false
		}
	}
	if req.Timezone != "" {
		if _, err := time.LoadLocation(req.Timezone); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid timezone", nil)
			return store.SyncCron{}, false
		}
	}
	// 上下文 kind 白名单外剔除（旧对端忽略未知 kind 的同款防御）
	var ctxs []string
	for _, k := range req.Contexts {
		if IsContextKind(k) {
			ctxs = append(ctxs, k)
		}
	}
	req.Contexts = ctxs
	return req, true
}
