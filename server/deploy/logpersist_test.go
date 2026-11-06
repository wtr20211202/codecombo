package deploy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 部署日志长期留档落盘测试（P-20261007-8，P-142 二阶段）：终态快照落盘（车道
// 2）/读回/双源幂等/寿命同源清理/字节护栏。真实 filestore 驱动（module_sweep
// 同款装配），断言以「重读落盘文件与存库」为准而非内存对象

// setupPersistEnv 独立数据目录（CC_DATA_DIR 隔离留档落点）+ 独立 filestore 存储。
// 单一 TempDir 共享：此前两次 t.TempDir() 产生 001/002 两个目录，CC_DATA_DIR 与
// store 数据根分裂（deployLogDir 写 001、audit/filestore 用 002），runner 短名
// TMP 环境下曾致留档 mkdir PATH_NOT_FOUND（实锚）——对齐后同一根
func setupPersistEnv(t *testing.T) store.DeployTaskStore {
	t.Helper()
	dataRoot := t.TempDir()
	t.Setenv("CC_DATA_DIR", dataRoot)
	store.SetDefault(store.New(filestore.New(filepath.Join(dataRoot, "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })
	return store.Get().DeployTask
}

// triggerDeadPortTask 回环死端口部署（deploy_log_test.go 同款播种形态）：拒连
// 秒失败，logBuf 留下 start/失败终态两条真实日志行，落盘链随 finishTask 真跑
func triggerDeadPortTask(t *testing.T, m *Manager, hostID string) string {
	t.Helper()
	taskID, err := m.Trigger(context.Background(), TriggerRequest{
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

// waitForPersistedLog 终态先行、快照后补（finishTask 设计语义）：库态 Failed
// 可先于 persistLogSnapshot 完成被观察到——CI 慢 FS 下一次性 ReadFile 是对
// 设计的误读（windows runner 实锚：50ms 轮询先于异步收尾落盘即 ENOENT，
// 本地 NTFS 快从未复现）。等待落盘文件在位再断言，与生产异步收尾对齐
func waitForPersistedLog(t *testing.T, taskID string) []byte {
	t.Helper()
	file := filepath.Join(deployLogDir(), taskID+persistedLogExt)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(file)
		if err == nil {
			return data
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("persisted log read failed: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("persisted log missing after 10s: %s", file)
	return nil
}

// waitForArchiveAudit 审计事件是落盘动作的再后一步（auditLogPersist 在
// WritePersistedLog 之后）：同款等待在位
func waitForArchiveAudit(t *testing.T, taskID string) store.AuditEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, ev := range auditEvents(t) {
			if ev.Action == store.AuditDeployLogArchive && strings.Contains(ev.Detail, "task="+taskID) {
				return ev
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no deploy.log.archive audit event for %s within 5s", taskID)
	return store.AuditEvent{}
}

// auditEvents 取审计事件（deploy.log.archive 断言用）
func auditEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	evs, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	return evs
}

// TestFinishTaskPersistsSnapshot 终态落盘主链：真实失败部署 → 快照文件在车道
// 2 落点、内容含任务头与终态行；与内存环渲染逐字节一致（双源幂等）；落盘动作
// 入审计摘要（task/lines 元数据，success）
func TestFinishTaskPersistsSnapshot(t *testing.T) {
	s := setupPersistEnv(t)
	m := NewManager(s)
	taskID := triggerDeadPortTask(t, m, "host-persist-a")

	// 落盘文件在位且即读回原料（同一渲染终形）——终态先行、快照后补：等待而非
	// 一次性读（CI 慢 FS 实锚，见 waitForPersistedLog 注）
	data := waitForPersistedLog(t, taskID)
	for _, want := range []string{
		"codecombo deploy log",
		"task:     " + taskID,
		"status:   failed",
		"start: task started",
		"done: task failed",
	} {
		if !strings.Contains(string(data), want) {
			t.Errorf("persisted log missing %q:\n%s", want, data)
		}
	}
	if bytes.ContainsRune(data, '\r') {
		t.Error("persisted log must be LF-only (cross-platform line ending discipline)")
	}

	// 双源幂等：内存窗内读到的渲染终形 == 落盘字节（终态后 logBuf 不再变化）
	entries, ok := m.LogEntries(taskID)
	if !ok {
		t.Fatal("task left memory window before comparison")
	}
	task, err := store.Get().DeployTask.Get(taskID)
	if err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if !bytes.Equal(capSnapshot(RenderLogText(task, entries)), data) {
		t.Error("memory render and persisted bytes diverge")
	}
	if got, ok := ReadPersistedLog(taskID); !ok || !bytes.Equal(got, data) {
		t.Error("ReadPersistedLog round-trip mismatch")
	}

	// 审计摘要：落盘动作入账，Detail 记 task/lines 元数据（快照后补的再后一步，
	// 同款等待）
	ev := waitForArchiveAudit(t, taskID)
	if ev.Result != store.AuditResultSuccess {
		t.Errorf("audit result = %q, want success", ev.Result)
	}
	if !strings.Contains(ev.Detail, "task="+taskID) || !strings.Contains(ev.Detail, "lines=") {
		t.Errorf("audit detail = %q, want task/lines metadata", ev.Detail)
	}
}

// TestFinishTaskSkipsCancelledAndGuardsFailures cancelled 不入档（内存窗内照常
// 可下）；落盘写失败（落点被文件占位）→ 任务终态照常落库 + 审计 failure，收尾
// 不被留档阻塞
func TestFinishTaskSkipsCancelledAndGuardsFailures(t *testing.T) {
	s := setupPersistEnv(t)
	m := NewManager(s)
	host := &config.RemoteHost{Host: "192.0.2.9"}

	seed := func(id string) {
		t.Helper()
		m.mu.Lock()
		m.running[id] = &runningTask{
			task: &config.DeployTask{ID: id, HostID: "h", Host: "192.0.2.9", Status: config.TaskStatusRunning},
			logBuf: []LogEntry{
				{Time: time.Now(), Step: "start", Level: LevelInfo, Message: "task started, 1 instances"},
			},
		}
		m.mu.Unlock()
	}

	// cancelled：不落盘
	seed("t-cancel")
	m.finishTask("t-cancel", config.TaskStatusCancelled, "cancelled", host)
	if _, err := os.Stat(filepath.Join(deployLogDir(), "t-cancel"+persistedLogExt)); !os.IsNotExist(err) {
		t.Errorf("cancelled task must not persist a snapshot, stat err = %v", err)
	}

	// 写失败：落点父目录被同名文件占位 → MkdirAll 必败。终态照常落库 + 审计 failure
	if err := os.MkdirAll(filepath.Dir(deployLogDir()), 0o700); err != nil {
		t.Fatalf("mkdir artifacts: %v", err)
	}
	if err := os.WriteFile(deployLogDir(), []byte("not a dir"), 0o600); err != nil {
		t.Fatalf("plant file at log dir path: %v", err)
	}
	seed("t-failwrite")
	m.finishTask("t-failwrite", config.TaskStatusFailed, "ssh dial: boom", host)
	stored, err := s.Get("t-failwrite")
	if err != nil || stored.Status != config.TaskStatusFailed {
		t.Fatalf("terminal state must persist regardless of snapshot failure: %v %+v", err, stored)
	}
	found := false
	for _, ev := range auditEvents(t) {
		if ev.Action == store.AuditDeployLogArchive && ev.Result == store.AuditResultFailure &&
			strings.Contains(ev.Detail, "task=t-failwrite") {
			found = true
		}
	}
	if !found {
		t.Error("snapshot write failure not audited as failure")
	}
}

// TestCapSnapshot 字节护栏：小快照原样返回（零拷贝）；超限保尾截头（错误尾行
// 保留、最早日志行被截）、头部任务元数据原样、标注行在位、总长不超封顶
func TestCapSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	task := &config.DeployTask{ID: "sc_dt_cap", Host: "192.0.2.10", Status: config.TaskStatusFailed}
	small := RenderLogText(task, []LogEntry{
		{Time: now, Step: "start", Level: LevelInfo, Message: "task started, 1 instances"},
	})
	if got := capSnapshot(small); !bytes.Equal(got, small) {
		t.Error("small snapshot must pass through unchanged")
	}

	// 超限：400 条 × 4KB 行 ≈ 1.6MB > 1MiB 封顶
	entries := make([]LogEntry, 0, 400)
	for i := range 400 {
		entries = append(entries, LogEntry{
			Time: now, Step: "run", Level: LevelInfo,
			Message: fmt.Sprintf("line-%04d %s", i, strings.Repeat("x", 4096)),
		})
	}
	entries = append(entries, LogEntry{Time: now, Step: "done", Level: LevelFail, Message: "task failed: boom"})
	capped := capSnapshot(RenderLogText(task, entries))

	if len(capped) > deployLogSnapshotCap {
		t.Errorf("capped size = %d, exceeds cap %d", len(capped), deployLogSnapshotCap)
	}
	if !strings.HasPrefix(string(capped), "codecombo deploy log\ntask:     sc_dt_cap") {
		t.Error("capped snapshot lost header metadata block")
	}
	if !strings.Contains(string(capped), snapshotTruncAnnot) {
		t.Error("capped snapshot missing truncation annotation")
	}
	if !strings.Contains(string(capped), "done: task failed: boom") {
		t.Error("capped snapshot lost tail error line (keep-tail rationale)")
	}
	if strings.Contains(string(capped), "line-0000 ") {
		t.Error("capped snapshot kept the head it should have truncated")
	}
	if bytes.ContainsRune(capped, '\r') {
		t.Error("capped snapshot must stay LF-only")
	}
	// 截断对齐整行：除头段与标注外，每行都以 RFC3339 时间戳起（不存在被劈开
	// 的残行/残字节）
	for _, line := range strings.Split(string(capped), "\n") {
		if line == "" ||
			strings.HasPrefix(line, "log truncated:") ||
			strings.HasPrefix(line, "codecombo deploy log") ||
			strings.HasPrefix(line, "task:") ||
			strings.HasPrefix(line, "host:") ||
			strings.HasPrefix(line, "status:") {
			continue
		}
		if line[0] >= '0' && line[0] <= '9' {
			continue
		}
		t.Errorf("split line in capped snapshot: %q", line[:min(40, len(line))])
	}
}

// TestPersistKeySafe 文件名安全校验（filestore validKey 同款黑名单）：路径穿越
// 形态全拒，真实任务 id 恒过；ReadPersistedLog 对不安全 id 如实无留档
func TestPersistKeySafe(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	for _, bad := range []string{"", "..", "../x", `..\x`, "a/b", `a\b`, "a:b", ".x", "a..b", strings.Repeat("x", 257)} {
		if persistKeySafe(bad) {
			t.Errorf("persistKeySafe(%q) = true, want false", bad)
		}
		if _, ok := ReadPersistedLog(bad); ok {
			t.Errorf("ReadPersistedLog(%q) ok = true, want false", bad)
		}
	}
	for _, good := range []string{"sc_dt_abc-123", "t1"} {
		if !persistKeySafe(good) {
			t.Errorf("persistKeySafe(%q) = false, want true", good)
		}
	}
}

// TestSweepPersistedLogs 寿命同源：任务在库 → 留档保留；任务出窗（查无）→
// 孤儿留档删除；非本功能命名形态的文件不借机波及；目录不存在零成本空转
func TestSweepPersistedLogs(t *testing.T) {
	s := setupPersistEnv(t)
	now := time.Now()
	// t-gone 出窗（31 天前 StartedAt，越 30 天保留线）、t-live 窗内——经真实
	// CleanupBefore 语义删除（StartedAt 晚于 cutoff 保留，其余删除）
	for _, tc := range []struct {
		id        string
		startedAt time.Time
	}{{"t-live", now}, {"t-gone", now.Add(-31 * 24 * time.Hour)}} {
		started := tc.startedAt
		if err := s.Save(config.DeployTask{ID: tc.id, HostID: "h", Host: "192.0.2.9",
			Status: config.TaskStatusFailed, StartedAt: &started}); err != nil {
			t.Fatalf("seed %s: %v", tc.id, err)
		}
		if err := WritePersistedLog(tc.id, []byte("snapshot of "+tc.id)); err != nil {
			t.Fatalf("write %s: %v", tc.id, err)
		}
	}
	if _, err := store.Get().DeployTask.CleanupBefore(now.Add(-30 * 24 * time.Hour)); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if _, err := s.Get("t-gone"); err == nil {
		t.Fatal("precondition failed: t-gone should have been cleaned by retention")
	}
	// 投放非本功能文件与子目录：对账不得波及
	foreign := filepath.Join(deployLogDir(), "operator-notes.txt")
	if err := os.WriteFile(foreign, []byte("keep me"), 0o600); err != nil {
		t.Fatalf("plant foreign file: %v", err)
	}
	if err := os.Mkdir(filepath.Join(deployLogDir(), "t-gone.log.dir"), 0o700); err != nil {
		t.Fatalf("plant subdir: %v", err)
	}

	if removed := SweepPersistedLogs(s); removed != 1 {
		t.Fatalf("sweep removed = %d, want 1 (only the orphaned t-gone)", removed)
	}
	if _, err := os.Stat(filepath.Join(deployLogDir(), "t-live"+persistedLogExt)); err != nil {
		t.Errorf("live task log must survive sweep: %v", err)
	}
	if _, err := os.Stat(filepath.Join(deployLogDir(), "t-gone"+persistedLogExt)); !os.IsNotExist(err) {
		t.Errorf("orphaned log must be removed, stat err = %v", err)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Errorf("foreign file must not be touched: %v", err)
	}
	// 幂等：二次巡更空转
	if n := SweepPersistedLogs(s); n != 0 {
		t.Errorf("second sweep removed = %d, want 0", n)
	}
}
