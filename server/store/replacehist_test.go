package store_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 批量替换历史仓储单测（P-20261004-66）：落档/查询/跨项目隔离/每项目上限裁剪/
// TTL 清账/项目删除级联——保留策略双上界（三车道纪律：append 型 kind 必须
// 同 PR 带保留策略）的锚定用例。

func newReplaceHistStore(t *testing.T) store.ReplaceHistStore {
	t.Helper()
	return store.NewReplaceHistRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

func rec(projectID string, at time.Time, pattern string) store.ReplaceHistRecord {
	return store.ReplaceHistRecord{
		ProjectID:   projectID,
		Time:        at,
		Pattern:     pattern,
		Replacement: "x",
		Files:       1,
		Hits:        2,
		Changed:     []store.ReplaceHistFile{{Path: "a.txt", Hits: 2}},
	}
}

func TestReplaceHist_AppendListOrder(t *testing.T) {
	r := newReplaceHistStore(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		got := r.Append(rec("p1", base.Add(time.Duration(i)*time.Minute), "old"))
		if got.ID == "" {
			t.Fatalf("append %d returned empty record (persist failed)", i)
		}
		if !strings.HasPrefix(got.ID, "p1-") {
			t.Errorf("key should carry project prefix, got %q", got.ID)
		}
	}
	list := r.List("p1", 0)
	if len(list) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(list))
	}
	// 时间倒序（最新在前）
	if list[0].Time.Before(list[2].Time) {
		t.Errorf("expected newest-first order, got %v < %v", list[0].Time, list[2].Time)
	}
}

func TestReplaceHist_ProjectIsolation(t *testing.T) {
	r := newReplaceHistStore(t)
	base := time.Now()
	r.Append(rec("p1", base, "a"))
	r.Append(rec("p2", base, "b"))

	if got := len(r.List("p1", 0)); got != 1 {
		t.Fatalf("p1 should see exactly 1 entry, got %d", got)
	}
	if got := r.List("p1", 0)[0].Pattern; got != "a" {
		t.Errorf("p1 entry pattern = %q, want a", got)
	}
	// 跨项目 ID 不可读（Get 前缀圈定）
	if _, ok := r.Get("p2", r.List("p1", 0)[0].ID); ok {
		t.Error("cross-project Get must be rejected")
	}
	// 伪造的越界 ID 不可读
	if _, ok := r.Get("p1", "../escape"); ok {
		t.Error("path-like id must be rejected")
	}
	// p2 级联删除不动 p1
	r.DeleteProject("p2")
	if got := len(r.List("p1", 0)); got != 1 {
		t.Errorf("p1 entries must survive p2 cleanup, got %d", got)
	}
	if got := len(r.List("p2", 0)); got != 0 {
		t.Errorf("p2 entries must be gone, got %d", got)
	}
}

func TestReplaceHist_TrimPerProjectCap(t *testing.T) {
	r := newReplaceHistStore(t)
	base := time.Now().Add(-2 * time.Hour)
	// 超限 2 条：逐最旧裁到 ReplaceHistMaxPerProject
	for i := 0; i < store.ReplaceHistMaxPerProject+2; i++ {
		if r.Append(rec("p1", base.Add(time.Duration(i)*time.Minute), "n")).ID == "" {
			t.Fatalf("append %d failed", i)
		}
	}
	list := r.List("p1", 0)
	if len(list) != store.ReplaceHistMaxPerProject {
		t.Fatalf("cap not enforced: got %d, want %d", len(list), store.ReplaceHistMaxPerProject)
	}
	// 裁掉的是最旧的两条（时间序前两条）
	for _, e := range list {
		if e.Time.Before(base.Add(2 * time.Minute)) {
			t.Errorf("oldest entry survived trim: %v", e.Time)
		}
	}
}

func TestReplaceHist_PurgeExpired(t *testing.T) {
	r := newReplaceHistStore(t)
	now := time.Now()
	r.Append(rec("p1", now.Add(-store.ReplaceHistRetention-time.Hour), "stale"))
	r.Append(rec("p1", now, "fresh"))
	removed := r.PurgeExpired(now.Add(-store.ReplaceHistRetention))
	if removed != 1 {
		t.Fatalf("expected 1 purged, got %d", removed)
	}
	list := r.List("p1", 0)
	if len(list) != 1 || list[0].Pattern != "fresh" {
		t.Fatalf("expected only fresh entry, got %+v", list)
	}
	// 无过期条目：零清理
	if n := r.PurgeExpired(now.Add(-store.ReplaceHistRetention)); n != 0 {
		t.Errorf("second purge should be no-op, got %d", n)
	}
}

func TestReplaceHist_DeleteSingle(t *testing.T) {
	r := newReplaceHistStore(t)
	saved := r.Append(rec("p1", time.Now(), "a"))
	if !r.Delete("p1", saved.ID) {
		t.Fatal("delete existing entry should return true")
	}
	if r.Delete("p1", saved.ID) {
		t.Error("delete missing entry should return false")
	}
	if got := len(r.List("p1", 0)); got != 0 {
		t.Errorf("entry should be gone, got %d", got)
	}
}

func TestReplaceHist_EmptyProjectGuard(t *testing.T) {
	r := newReplaceHistStore(t)
	if got := r.Append(store.ReplaceHistRecord{}); got.ID != "" {
		t.Error("append without project must be a no-op")
	}
	if got := r.List("", 0); len(got) != 0 {
		t.Error("list without project must be empty")
	}
}
