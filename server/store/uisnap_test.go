package store_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 用户 UI 现场（P-20261004-52）存储单测：单文档覆写（last-write-wins）+
// UpdatedAt 服务端盖戳 + TTL 过期查无（now 注入时间旅行）。
func newUISnapTestStore(t *testing.T) store.UISnapStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).UISnap
}

func sampleSnapshot(path string, line int) store.UISnapshot {
	return store.UISnapshot{
		ActiveProjectID: "proj-1",
		ActiveFile:      &store.UIActiveFile{Path: path, Line: line, Column: 3},
		VisiblePanels:   store.UIVisiblePanels{Side: "files", SideOpen: true, Bottom: "terminal", BottomOpen: false},
	}
}

func TestUISnap_PutGetAlive(t *testing.T) {
	s := newUISnapTestStore(t)

	// 空库即查无（从未上报）
	if _, err := s.GetAlive(time.Now()); !errors.Is(err, store.ErrNoLiveSnapshot) {
		t.Fatalf("empty store GetAlive err = %v, want ErrNoLiveSnapshot", err)
	}

	if err := s.Put(sampleSnapshot("web/src/main.ts", 42)); err != nil {
		t.Fatal(err)
	}
	snap, err := s.GetAlive(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snap.ActiveFile == nil || snap.ActiveFile.Path != "web/src/main.ts" || snap.ActiveFile.Line != 42 {
		t.Fatalf("roundtrip mismatch: %+v", snap)
	}
	if snap.UpdatedAt.IsZero() {
		t.Fatal("UpdatedAt must be stamped server-side")
	}

	// 整体覆写：单文档 last-write-wins（多标签页竞争语义），无历史堆积
	if err := s.Put(store.UISnapshot{
		ActiveProjectID:         "proj-2",
		VisiblePanels:           store.UIVisiblePanels{Side: "changes", SideOpen: false, Bottom: "git", BottomOpen: true},
		ActiveTerminalSessionID: "term-9",
	}); err != nil {
		t.Fatal(err)
	}
	snap, err = s.GetAlive(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snap.ActiveProjectID != "proj-2" || snap.ActiveFile != nil || snap.ActiveTerminalSessionID != "term-9" {
		t.Fatalf("overwrite mismatch: %+v", snap)
	}
}

// TestUISnap_TTLExpiry 10 分钟无心跳即查无：调用方传入越界时刻应收敛
// ErrNoLiveSnapshot，陈旧现场宁缺勿错（文档仍保留，新心跳写入即复活）
func TestUISnap_TTLExpiry(t *testing.T) {
	s := newUISnapTestStore(t)
	if err := s.Put(sampleSnapshot("a.go", 1)); err != nil {
		t.Fatal(err)
	}
	base := time.Now()

	// 边界内（TTL - 1s）仍可读
	if _, err := s.GetAlive(base.Add(store.UISnapshotTTL - time.Second)); err != nil {
		t.Fatalf("within TTL err = %v, want nil", err)
	}
	// 越界（TTL + 1s）查无
	if _, err := s.GetAlive(base.Add(store.UISnapshotTTL + time.Second)); !errors.Is(err, store.ErrNoLiveSnapshot) {
		t.Fatalf("expired err = %v, want ErrNoLiveSnapshot", err)
	}
	// 过期后新心跳写入复活
	if err := s.Put(sampleSnapshot("b.go", 2)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetAlive(time.Now()); err != nil {
		t.Fatalf("revived after fresh put err = %v", err)
	}
}
