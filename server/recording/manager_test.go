package recording

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ============== 审批窗口联动单测 ==============
// pending 开录 → 输出遮蔽落盘 → resolved 缓冲洗停 / 会话退出即停 /
// Kill 清空 handlers 后 AddOnChange 对账兜底 / 开关关 = 不录。

// fakeSession TapSession 桩：手动注入输出与退出事件
type fakeSession struct {
	mu     sync.Mutex
	onOut  []func([]byte)
	onExit []func(int)
	cols   uint16
	rows   uint16
}

func newFakeSession() *fakeSession { return &fakeSession{cols: 100, rows: 30} }

func (f *fakeSession) OnOutput(h func([]byte)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onOut = append(f.onOut, h)
	id := len(f.onOut) - 1
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if id < len(f.onOut) { // kill() 清空后越界防护
			f.onOut[id] = nil
		}
	}
}

func (f *fakeSession) OnExit(h func(int)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onExit = append(f.onExit, h)
	id := len(f.onExit) - 1
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if id < len(f.onExit) {
			f.onExit[id] = nil
		}
	}
}

func (f *fakeSession) Size() (uint16, uint16) { return f.cols, f.rows }

func (f *fakeSession) emit(data []byte) {
	f.mu.Lock()
	handlers := append([]func([]byte){}, f.onOut...)
	f.mu.Unlock()
	for _, h := range handlers {
		if h != nil {
			h(data)
		}
	}
}

// kill 模拟用户关闭终端：清空 handlers（ Kill 语义）并使 lookup 不再命中
func (f *fakeSession) kill() {
	f.mu.Lock()
	f.onOut = nil
	f.onExit = nil
	f.mu.Unlock()
}

func setupWindowTest(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	enabled := true
	cfg := store.Get().Settings.Get()
	cfg.Server.ApprovalRecording = &enabled

	m := NewManager()
	t.Cleanup(func() { m.StopAll("test cleanup") })
	return m
}

func approvalEvent(typ string, payload any) opschannel.Event {
	return opschannel.Event{Type: typ, Payload: payload, Source: "system", TS: time.Now().UnixMilli()}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func listMeta(t *testing.T) []store.Recording {
	t.Helper()
	list, err := store.Get().Recording.List()
	if err != nil {
		t.Fatalf("list recordings: %v", err)
	}
	return list
}

func readCast(t *testing.T, id string) string {
	t.Helper()
	b, err := os.ReadFile(CastPath(id))
	if err != nil {
		t.Fatalf("read cast %s: %v", id, err)
	}
	return string(b)
}

func TestWindow_PendingStarts_ResolvedStopsAfterGrace(t *testing.T) {
	oldGrace := graceStopDelay
	graceStopDelay = 60 * time.Millisecond
	t.Cleanup(func() { graceStopDelay = oldGrace })

	m := setupWindowTest(t)
	sess := newFakeSession()
	SetSessionLookup(func(string) TapSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{
		ID: "sc_ap_1", SessionID: "term-1", Agent: "claude", Op: "git push", Target: "origin/main",
	}))
	waitFor(t, "recording metadata", func() bool { return len(listMeta(t)) == 1 })
	meta := listMeta(t)[0]
	if meta.Status != store.RecordingStatusRecording || meta.Op != "git push" {
		t.Fatalf("meta = %+v", meta)
	}

	// 高危操作执行中的输出（含敏感值）：录进 cast 且写盘前已遮蔽
	// （sampleToken/masked 与 server/mask/mask_test.go 同款语料：sca_ + hex）
	const sampleToken = "sca_8f3a2b1c4d5e4f6a8b7c9d0e1f2a3b4c"
	const masked = "***"
	sess.emit([]byte("$ export CC_LOCK_TOKEN=" + sampleToken + "\r\n" + "pushing...\r\n"))
	waitFor(t, "cast content", func() bool {
		return strings.Contains(readCast(t, meta.ID), "pushing")
	})
	cast := readCast(t, meta.ID)
	if strings.Contains(cast, sampleToken) {
		t.Fatalf("token persisted: %q", cast)
	}
	if !strings.Contains(cast, masked) {
		t.Fatalf("mask missing: %q", cast)
	}

	// 裁决后缓冲窗口内仍在录；缓冲洗停后 completed + 落止时间
	m.HandleEvent(approvalEvent("approval.resolved", map[string]any{
		"id": "sc_ap_1", "status": "allowed", "sessionId": "term-1",
	}))
	sess.emit([]byte("post-resolve output\r\n"))
	waitFor(t, "completed", func() bool {
		return listMeta(t)[0].Status == store.RecordingStatusCompleted
	})
	if !strings.Contains(readCast(t, meta.ID), "post-resolve output") {
		t.Fatalf("grace window output missing")
	}
	done := listMeta(t)[0]
	if done.StoppedAt == nil || done.SizeBytes == 0 {
		t.Fatalf("finalize meta = %+v", done)
	}
}

func TestWindow_SessionExitFlushesImmediately(t *testing.T) {
	oldGrace := graceStopDelay
	graceStopDelay = 10 * time.Second // 长缓冲：证明退出路径不等缓冲
	t.Cleanup(func() { graceStopDelay = oldGrace })

	m := setupWindowTest(t)
	sess := newFakeSession()
	SetSessionLookup(func(string) TapSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_2", SessionID: "term-2"}))
	waitFor(t, "recording", func() bool { return len(listMeta(t)) == 1 })
	id := listMeta(t)[0].ID

	// native shell 自退 / tmux attach 退出：OnExit 触发即收尾
	sess.emit([]byte("before exit"))
	waitFor(t, "cast content", func() bool { return strings.Contains(readCast(t, id), "before exit") })
	sess.mu.Lock()
	handlers := append([]func(int){}, sess.onExit...)
	sess.mu.Unlock()
	for _, h := range handlers {
		if h != nil {
			h(0)
		}
	}
	waitFor(t, "completed on exit", func() bool {
		return listMeta(t)[0].Status == store.RecordingStatusCompleted
	})
}

func TestWindow_KilledSessionHealedByOnChange(t *testing.T) {
	// Kill（用户关 tab）清空 onOutput/onExit——handlers 不再触发，
	// terminal.AddOnChange 对账路径负责把已录部分落盘
	oldGrace := graceStopDelay
	graceStopDelay = 10 * time.Second
	t.Cleanup(func() { graceStopDelay = oldGrace })

	m := setupWindowTest(t)
	sess := newFakeSession()
	SetSessionLookup(func(string) TapSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_3", SessionID: "term-3"}))
	waitFor(t, "recording", func() bool { return len(listMeta(t)) == 1 })
	id := listMeta(t)[0].ID
	sess.emit([]byte("partial evidence"))

	// 会话被杀：lookup 不再命中 + handlers 清空 → change 对账收尾
	sess.kill()
	SetSessionLookup(func(string) TapSession { return nil })
	m.sessionChanged()
	waitFor(t, "completed after change", func() bool {
		return listMeta(t)[0].Status == store.RecordingStatusCompleted
	})
	if !strings.Contains(readCast(t, id), "partial evidence") {
		t.Fatalf("partial evidence lost")
	}
}

func TestWindow_DisabledByDefault(t *testing.T) {
	m := setupWindowTest(t)
	enabled := false
	cfg := store.Get().Settings.Get()
	cfg.Server.ApprovalRecording = &enabled
	SetSessionLookup(func(string) TapSession { return newFakeSession() })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_4", SessionID: "term-4"}))
	time.Sleep(50 * time.Millisecond)
	if n := len(listMeta(t)); n != 0 {
		t.Fatalf("recordings = %d, want 0 (default off)", n)
	}
}

func TestWindow_ConcurrentApprovalsJoinOneRecording(t *testing.T) {
	oldGrace := graceStopDelay
	graceStopDelay = 80 * time.Millisecond
	t.Cleanup(func() { graceStopDelay = oldGrace })

	m := setupWindowTest(t)
	sess := newFakeSession()
	SetSessionLookup(func(string) TapSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_5", SessionID: "term-5"}))
	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_6", SessionID: "term-5", Op: "second"}))
	waitFor(t, "one recording", func() bool { return len(listMeta(t)) == 1 })
	if ids := listMeta(t)[0].ApprovalIDs; len(ids) != 2 {
		t.Fatalf("approvalIds = %v, want 2", ids)
	}

	// 第一个裁决：第二个仍 pending → 窗口延续
	m.HandleEvent(approvalEvent("approval.resolved", map[string]any{"id": "sc_ap_5", "sessionId": "term-5"}))
	time.Sleep(graceStopDelay * 2)
	if got := listMeta(t)[0].Status; got != store.RecordingStatusRecording {
		t.Fatalf("window closed while approval pending: %s", got)
	}
	// 最后一个裁决 → 缓冲洗停
	m.HandleEvent(approvalEvent("approval.resolved", map[string]any{"id": "sc_ap_6", "sessionId": "term-5"}))
	waitFor(t, "completed", func() bool {
		return listMeta(t)[0].Status == store.RecordingStatusCompleted
	})
}

func TestWindow_SettingOffMidWindowStopsAll(t *testing.T) {
	m := setupWindowTest(t)
	sess := newFakeSession()
	SetSessionLookup(func(string) TapSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })

	m.HandleEvent(approvalEvent("approval.pending", store.AgentApproval{ID: "sc_ap_7", SessionID: "term-7"}))
	waitFor(t, "recording", func() bool { return len(listMeta(t)) == 1 })

	// 隐私边界即时生效：开关关闭 → settings.changed 立即收尾
	enabled := false
	store.Get().Settings.Get().Server.ApprovalRecording = &enabled
	m.HandleEvent(approvalEvent("settings.changed", nil))
	waitFor(t, "stopped on disable", func() bool {
		return listMeta(t)[0].Status == store.RecordingStatusCompleted
	})
}

func TestHealStaleMarksInterruptedRecording(t *testing.T) {
	m := setupWindowTest(t)
	SetSessionLookup(func(string) TapSession { return nil })
	t.Cleanup(func() { SetSessionLookup(nil) })

	id := store.NewRecordingID()
	if err := os.MkdirAll(ArtifactsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(CastPath(id), []byte("{\"version\":2}\n[0.1,\"o\",\"x\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-time.Hour)
	if err := store.Get().Recording.Save(store.Recording{
		ID: id, SessionID: "term-gone", ApprovalIDs: []string{"sc_ap_9"},
		Status: store.RecordingStatusRecording, StartedAt: started,
	}); err != nil {
		t.Fatal(err)
	}

	m.HealStale()
	rec := listMeta(t)[0]
	if rec.Status != store.RecordingStatusCompleted || rec.StoppedAt == nil || rec.SizeBytes == 0 {
		t.Fatalf("healed meta = %+v", rec)
	}
}

func TestSweepRemovesExpiredAndOrphans(t *testing.T) {
	m := setupWindowTest(t)

	// 过期录制（90 天前）：元数据 + 文件都删
	oldID := store.NewRecordingID()
	keepID := store.NewRecordingID()
	orphanID := store.NewRecordingID()
	if err := os.MkdirAll(ArtifactsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{oldID, keepID, orphanID} {
		if err := os.WriteFile(CastPath(id), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Get().Recording.Save(store.Recording{
		ID: oldID, ApprovalIDs: []string{"a"}, Status: store.RecordingStatusCompleted,
		StartedAt: time.Now().Add(-recordingRetention - time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Get().Recording.Save(store.Recording{
		ID: keepID, ApprovalIDs: []string{"b"}, Status: store.RecordingStatusCompleted,
		StartedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	// orphanID 无元数据：反向孤儿，同样删

	m.Sweep()
	list := listMeta(t)
	if len(list) != 1 || list[0].ID != keepID {
		t.Fatalf("after sweep = %+v", list)
	}
	if _, err := os.Stat(CastPath(oldID)); !os.IsNotExist(err) {
		t.Fatalf("expired cast survived")
	}
	if _, err := os.Stat(CastPath(orphanID)); !os.IsNotExist(err) {
		t.Fatalf("orphan cast survived")
	}
	if _, err := os.Stat(filepath.Join(ArtifactsDir(), keepID+".cast")); err != nil {
		t.Fatalf("kept cast removed: %v", err)
	}
}
