package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/deploy"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// logTestRouter 部署日志下载端点（P-20261003-142）测试 router：独立 store +
// InitDefault 装配 defaultManager（日志窗判定依赖真实 Manager 内存态）
func logTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/deploy/:taskId/log", GetDeployTaskLog)
	return r
}

// triggerDeadPortTask 触发一个注定失败的部署（回环死端口秒拒连，与 e2e
// deploy-rerun 同款播种形态）：任务记录照常落库，logBuf 留下 start/失败终态
// 两条真实日志行，且任务终态后仍在内存窗内（TTL 1h）。轮询到 failed 返回
func triggerDeadPortTask(t *testing.T, hostID string) string {
	t.Helper()
	mgr := deploy.InitDefault()
	taskID, err := mgr.Trigger(context.Background(), deploy.TriggerRequest{
		HostID:    hostID,
		Instances: []config.DeployerInstance{{DeployerID: "claude_code", Params: map[string]string{}}},
	}, &config.RemoteHost{Host: "127.0.0.1", Port: 1, User: "u", AuthType: "password", Password: "p"},
		&config.DeployConfig{AnthropicToken: "tk", AnthropicBaseURL: "http://gw/", Model: "m"})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if task, err := store.Get().DeployTask.Get(taskID); err == nil && task.Status == config.TaskStatusFailed {
			return taskID
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("dead-port task did not fail in time")
	return ""
}

func doGetLog(r *gin.Engine, taskID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/deploy/"+taskID+"/log", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestGetDeployTaskLog_InMemory 窗内直出：200 + text/plain 附件 + 净化下载头 +
// 来源标注 memory（双源读路之实时窗源），留档体含任务头部与已知步骤行
// （task started / task failed）
func TestGetDeployTaskLog_InMemory(t *testing.T) {
	r := logTestRouter(t)
	taskID := triggerDeadPortTask(t, "host-log-a")

	w := doGetLog(r, taskID)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("content-type = %q, want text/plain", ct)
	}
	if src := w.Header().Get(deploy.LogSourceHeader); src != deploy.LogSourceMemory {
		t.Errorf("log source header = %q, want %q", src, deploy.LogSourceMemory)
	}
	cd := w.Header().Get("Content-Disposition")
	if !strings.Contains(cd, "attachment") || !strings.Contains(cd, "filename") {
		t.Errorf("content-disposition = %q, want attachment with filename", cd)
	}
	// 文件名经 P-109 helper：RFC 5987 双形式；主机地址 127.0.0.1 净化后原样保留
	if !strings.Contains(cd, "deploy-127.0.0.1-") {
		t.Errorf("content-disposition = %q, want deploy-<host>-<date> name", cd)
	}
	body := w.Body.String()
	for _, want := range []string{
		"codecombo deploy log",
		"task:     " + taskID,
		"status:   failed",
		"start: task started",
		"done: task failed",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("log body missing %q:\n%s", want, body)
		}
	}
}

// TestGetDeployTaskLog_Expired 内存窗外且落盘也无（记录在存库、任务不在内存、
// 无留档文件——升级前终态/首启前历史任务/cancelled 不入档/落盘写失败共此形态）：
// 410 + 稳定标记 deploy.LogExpiredMarker——「明确不可下载」语义不变，前端按
// 标记映射过期文案
func TestGetDeployTaskLog_Expired(t *testing.T) {
	r := logTestRouter(t)
	now := time.Now()
	if err := store.Get().DeployTask.Save(config.DeployTask{
		ID: "sc_dt_expired", HostID: "h", Host: "192.0.2.9",
		Status: config.TaskStatusFailed, StartedAt: &now,
	}); err != nil {
		t.Fatalf("save: %v", err)
	}

	w := doGetLog(r, "sc_dt_expired")
	if w.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), deploy.LogExpiredMarker) {
		t.Errorf("body = %q, want stable marker %q", w.Body.String(), deploy.LogExpiredMarker)
	}
}

// TestGetDeployTaskLog_PersistedFallback 内存窗外回源落盘（P-20261007-8）：
// 存库记录 + 留档快照在场（WritePersistedLog 终态收尾点同链落盘）→ 200 + 来源
// 标注 persisted + 快照全文直出——排障回看窗从 1h 到任务记录 30 天寿命
func TestGetDeployTaskLog_PersistedFallback(t *testing.T) {
	r := logTestRouter(t)
	deploy.InitDefault()                 // 端点前置 DefaultManager；本用例不触发任务，显式装配
	t.Setenv("CC_DATA_DIR", t.TempDir()) // 留档落点随测试隔离（deployLogDir 读 env）
	now := time.Now()
	task := config.DeployTask{
		ID: "sc_dt_persisted", HostID: "h", Host: "192.0.2.8",
		Status: config.TaskStatusFailed, Error: "init_user: boom", StartedAt: &now,
	}
	if err := store.Get().DeployTask.Save(task); err != nil {
		t.Fatalf("save: %v", err)
	}
	entries := []deploy.LogEntry{
		{Time: now, Step: "start", Level: "info", Message: "task started, 1 instances"},
		{Time: now, Step: "done", Level: "fail", Message: "task failed: init_user: boom"},
	}
	if err := deploy.WritePersistedLog(task.ID, deploy.RenderLogText(&task, entries)); err != nil {
		t.Fatalf("seed persisted log: %v", err)
	}

	w := doGetLog(r, task.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if src := w.Header().Get(deploy.LogSourceHeader); src != deploy.LogSourcePersisted {
		t.Errorf("log source header = %q, want %q", src, deploy.LogSourcePersisted)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "deploy-192.0.2.8-") {
		t.Errorf("content-disposition = %q, want host-derived name", cd)
	}
	body := w.Body.String()
	for _, want := range []string{
		"codecombo deploy log",
		"task:     " + task.ID,
		"status:   failed",
		"start: task started",
		"done: task failed",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("persisted log body missing %q:\n%s", want, body)
		}
	}
	// 注：文件名不安全 id 的穿越防护在 store validKey（Save 即拒）+ deploy 包
	// persistKeySafe（TestPersistKeySafe）双层把守，端点层无可达注入面，不重复
}

// TestGetDeployTaskLog_NotFound 任务不存在（内存与存库皆无）→ 404，
// 与 GetDeployTask 同语义
func TestGetDeployTaskLog_NotFound(t *testing.T) {
	r := logTestRouter(t)
	w := doGetLog(r, "sc_dt_absent")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}
