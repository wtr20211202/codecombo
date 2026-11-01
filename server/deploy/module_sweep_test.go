package deploy

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// 启动假态清扫测试（P-20261003-326）：服务重启后 running/queued 死任务记录
// 永远停留假态——Init 期统一收尾为 failed（原因=RestartInterruptedMarker），
// 终态记录不动。用真实 filestore 存储驱动（Save/Get/ListRecent 全链路），
// 断言以「重读存库」为准而非内存对象

// seedTask 存一条任务记录（StartedAt 统一此刻，finishedAt/error 仅终态样本给）
func seedTask(t *testing.T, s store.DeployTaskStore, id, status, errMsg string, finishedAt *time.Time) {
	t.Helper()
	now := time.Now()
	task := config.DeployTask{
		ID: id, HostID: "host-" + id, Host: "10.0.0.9:22",
		Instances: []config.DeployerInstance{{DeployerID: "init_user"}},
		Status:    status, Error: errMsg,
		StartedAt: &now, FinishedAt: finishedAt,
	}
	if err := s.Save(task); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// setupSweepStore 独立 filestore 测试存储（module_test 同款装配）
func setupSweepStore(t *testing.T) store.DeployTaskStore {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	return store.Get().DeployTask
}

// initModule 经真实内核生命周期触发 Module.Init（清扫的生产挂载点就是 Init，
// 测试同锚点：挂载点漂移本测试即红）
func initModule(t *testing.T) {
	t.Helper()
	m := NewModule()
	k := kernel.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := m.Init(context.Background(), k); err != nil {
		t.Fatalf("module init: %v", err)
	}
	// Init 装配的 defaultManager 卸载，不污染同包其他测试（module_test 同纪律）
	t.Cleanup(func() { _ = m.Stop(context.Background(), k) })
}

func TestInitSweepsInterruptedStates(t *testing.T) {
	s := setupSweepStore(t)
	// 假态样本：running（含残留 error）与 queued；终态样本三种各一，
	// failed 样本带原 error 与 FinishedAt——「不动」断言要逐字段对
	seedTask(t, s, "sweep-running", config.TaskStatusRunning, "", nil)
	seedTask(t, s, "sweep-queued", config.TaskStatusQueued, "", nil)
	seedTask(t, s, "sweep-completed", config.TaskStatusCompleted, "", nil)
	done := time.Now().Add(-time.Hour)
	seedTask(t, s, "sweep-failed", config.TaskStatusFailed, "ssh dial: boom", &done)
	seedTask(t, s, "sweep-cancelled", config.TaskStatusCancelled, "cancelled", &done)

	initModule(t)

	for _, id := range []string{"sweep-running", "sweep-queued"} {
		task, err := s.Get(id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		if task.Status != config.TaskStatusFailed {
			t.Errorf("%s: status = %q, want failed", id, task.Status)
		}
		if task.Error != RestartInterruptedMarker {
			t.Errorf("%s: error = %q, want marker %q", id, task.Error, RestartInterruptedMarker)
		}
		if task.FinishedAt == nil {
			t.Errorf("%s: FinishedAt not stamped", id)
		}
	}

	// 终态记录逐字段原样（status/error/finishedAt 三处都被改写即测试白过）
	completed, _ := s.Get("sweep-completed")
	if completed.Status != config.TaskStatusCompleted || completed.Error != "" || completed.FinishedAt != nil {
		t.Errorf("completed record mutated: %+v", *completed)
	}
	failed, _ := s.Get("sweep-failed")
	if failed.Status != config.TaskStatusFailed || failed.Error != "ssh dial: boom" ||
		failed.FinishedAt == nil || !failed.FinishedAt.Equal(done) {
		t.Errorf("failed record mutated: %+v", *failed)
	}
	cancelled, _ := s.Get("sweep-cancelled")
	if cancelled.Status != config.TaskStatusCancelled || cancelled.Error != "cancelled" ||
		cancelled.FinishedAt == nil || !cancelled.FinishedAt.Equal(done) {
		t.Errorf("cancelled record mutated: %+v", *cancelled)
	}
}

// 幂等：已收尾的记录二次 Init 不再改写（FinishedAt 不漂移）——重启多次只在
// 第一次见到残留
func TestInitSweepIdempotent(t *testing.T) {
	s := setupSweepStore(t)
	seedTask(t, s, "sweep-idem", config.TaskStatusRunning, "", nil)

	initModule(t)
	first, _ := s.Get("sweep-idem")
	if first.Status != config.TaskStatusFailed {
		t.Fatalf("first init: status = %q, want failed", first.Status)
	}

	initModule(t)
	second, _ := s.Get("sweep-idem")
	if !second.FinishedAt.Equal(*first.FinishedAt) {
		t.Errorf("second init rewrote record: finishedAt %v → %v", first.FinishedAt, second.FinishedAt)
	}
	if swept, err := sweepInterruptedTasks(s); err != nil || swept != 0 {
		t.Errorf("direct re-sweep: swept=%d err=%v, want 0/nil", swept, err)
	}
}

// 全量覆盖：清扫对象是保留窗内全部假态而非「最近 20 条」——21 条 running
// 记录全数收尾（ListRecent 20 截断会让第 21 条永远假态）
func TestSweepCoversBeyondRecentWindow(t *testing.T) {
	s := setupSweepStore(t)
	const total = 25
	for i := 0; i < total; i++ {
		seedTask(t, s, fmt.Sprintf("sweep-bulk-%02d", i), config.TaskStatusRunning, "", nil)
	}
	swept, err := sweepInterruptedTasks(s)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if swept != total {
		t.Errorf("swept = %d, want %d", swept, total)
	}
	tasks, _ := s.ListRecent(0)
	for _, task := range tasks {
		if task.Status != config.TaskStatusFailed || task.Error != RestartInterruptedMarker {
			t.Errorf("%s: not swept: status=%q error=%q", task.ID, task.Status, task.Error)
		}
	}
}
