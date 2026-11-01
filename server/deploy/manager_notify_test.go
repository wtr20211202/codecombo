package deploy

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestFinishTaskNotifiesTerminalState 部署任务终态（P-20261001-31）：
// completed/failed 各推一条通知（类别 task、Title 含主机名与工具名、失败附
// ≤200 字符尾部错误摘要）；cancelled 为用户主动行为不推；store 未装配时
// 不 panic。动作按终态分流（P-20261003-289）：成功 panel:deploy 直达部署
// 分区；失败 agent-fix 交给智能体修复，payload=任务 id（前端动作触发时经
// GET /api/deploy/:taskId 补拉完整配置）
func TestFinishTaskNotifiesTerminalState(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	m := NewManager(&fakeTaskStore{})
	host := &config.RemoteHost{ID: "h1", Name: "WSL", Host: "127.0.0.1"}
	seed := func(id string) {
		m.mu.Lock()
		m.running[id] = &runningTask{
			task: &config.DeployTask{
				ID:     id,
				HostID: host.ID,
				Host:   host.Host,
				Instances: []config.DeployerInstance{
					{DeployerID: "init_ssh_key"},
					{DeployerID: "codecombo"},
					// allowMultiple 工具可重复：标题去重
					{DeployerID: "codecombo"},
				},
			},
			cfg: &config.DeployConfig{},
		}
		m.mu.Unlock()
	}

	seed("t_done")
	m.finishTask("t_done", config.TaskStatusCompleted, "", host)
	seed("t_fail")
	m.finishTask("t_fail", config.TaskStatusFailed, "simple_coding: "+strings.Repeat("boom ", 80), host)
	seed("t_cancel")
	m.finishTask("t_cancel", config.TaskStatusCancelled, "cancelled", host)

	notes := store.Get().Notification.List(0)
	if len(notes) != 2 {
		t.Fatalf("expected 2 notifications (completed+failed, cancelled excluded), got %d", len(notes))
	}
	byType := map[string]notificationKind{}
	for _, n := range notes {
		byType[n.Type] = notificationKind{title: n.Title, body: n.Body, action: n.Action, payload: n.ActionPayload, category: n.Category}
		if n.Category != "task" {
			t.Errorf("category = %q, want task", n.Category)
		}
		if !strings.Contains(n.Title, "WSL") {
			t.Errorf("title %q should contain host name", n.Title)
		}
		if !strings.Contains(n.Title, "codecombo") || !strings.Contains(n.Title, "init_ssh_key") {
			t.Errorf("title %q should contain deduped tool names", n.Title)
		}
	}

	done, ok := byType["success"]
	if !ok {
		t.Fatalf("success notification missing: %+v", notes)
	}
	if !strings.HasPrefix(done.title, "部署完成") {
		t.Errorf("success title = %q, want 部署完成 prefix", done.title)
	}
	if done.body != "" {
		t.Errorf("success body = %q, want empty", done.body)
	}
	if done.action != "panel" || done.payload != "deploy" {
		t.Errorf("success action = %q/%q, want panel/deploy", done.action, done.payload)
	}

	fail, ok := byType["error"]
	if !ok {
		t.Fatalf("error notification missing: %+v", notes)
	}
	if !strings.HasPrefix(fail.title, "部署失败") {
		t.Errorf("failed title = %q, want 部署失败 prefix", fail.title)
	}
	if !strings.HasSuffix(fail.body, "boom ") || !strings.HasPrefix(fail.body, "…") {
		t.Errorf("failed body should be tail summary with ellipsis prefix, got %q", fail.body)
	}
	if n := len([]rune(fail.body)); n > notifyErrSummaryMax {
		t.Errorf("failed body length = %d, want ≤%d", n, notifyErrSummaryMax)
	}
	// 失败分支动作（P-20261003-289）：agent-fix + 任务 id（前端补拉锚点）
	if fail.action != "agent-fix" {
		t.Errorf("failed action = %q, want agent-fix", fail.action)
	}
	if fail.payload != "t_fail" {
		t.Errorf("failed payload = %q, want task id t_fail", fail.payload)
	}
}

// notificationKind 单测断言用的通知字段快照
type notificationKind struct {
	title, body, action, payload, category string
}

// TestFinishTaskWithoutStoreNilSafe store 未装配（历史单测直接 Trigger 不设
// 全局 store）时通知钩子静默跳过，不得 panic
func TestFinishTaskWithoutStoreNilSafe(t *testing.T) {
	if store.Get() != nil {
		t.Skip("global store already set by another test in this package run")
	}
	m := NewManager(&fakeTaskStore{})
	m.mu.Lock()
	m.running["t_nostore"] = &runningTask{task: &config.DeployTask{ID: "t_nostore"}, cfg: &config.DeployConfig{}}
	m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.finishTask("t_nostore", config.TaskStatusFailed, "ssh dial: refused", &config.RemoteHost{})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("finishTask blocked")
	}
}
