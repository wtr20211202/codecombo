package store_test

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newFSAttrStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newFSAttrStoreForTest(t *testing.T) store.FSAttributionStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).FSAttribution
}

// 文件改动来源归因账单测（P-20261005-170）：环形裁剪 / 同路径紧邻合并 /
// 查询过滤（路径精确 + limit）/ 项目删除级联。账面语义 =「每项目最近 500 条
// 改动及其归因」，含未归因——诚实账无差别记账

func TestFSAttribution_AppendQueryOrder(t *testing.T) {
	repo := newFSAttrStoreForTest(t)
	base := time.Now().Add(-time.Minute)

	mk := func(path, source string, offset time.Duration) store.FSAttributionEvent {
		return store.FSAttributionEvent{At: base.Add(offset), Path: path, Op: "write", Source: source}
	}
	for i, ev := range []store.FSAttributionEvent{
		mk("a.ts", store.FSAttributionUnattributed, 0),
		mk("b.ts", store.FSAttributionEditor, time.Second),
		mk("a.ts", store.FSAttributionCommand, 2*time.Second),
	} {
		if err := repo.Append("p1", ev); err != nil {
			t.Fatalf("append #%d: %v", i, err)
		}
	}

	all, err := repo.Query("p1", "", 10)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	// 追加序 a→b→a（时间升序），查询恒新→旧：[a@+2s, b@+1s, a@0]
	if len(all) != 3 || all[0].Path != "a.ts" || all[0].Source != store.FSAttributionCommand ||
		all[1].Path != "b.ts" || all[2].Path != "a.ts" {
		t.Fatalf("query must be newest-first, got %+v", all)
	}

	only, err := repo.Query("p1", "a.ts", 10)
	if err != nil {
		t.Fatalf("query path: %v", err)
	}
	if len(only) != 2 || only[0].Source != store.FSAttributionCommand {
		t.Fatalf("path filter mismatch: %+v", only)
	}

	limited, _ := repo.Query("p1", "", 1)
	if len(limited) != 1 || limited[0].Path != "a.ts" {
		t.Fatalf("limit mismatch: %+v", limited)
	}
}

func TestFSAttribution_RingTrim(t *testing.T) {
	repo := newFSAttrStoreForTest(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < store.FSAttributionMax+20; i++ {
		ev := store.FSAttributionEvent{
			At:     base.Add(time.Duration(i) * time.Second),
			Path:   "f" + strconv.Itoa(i) + ".ts", // 逐条异路径：不受合并窗影响
			Op:     "write",
			Source: store.FSAttributionUnattributed,
		}
		if err := repo.Append("p1", ev); err != nil {
			t.Fatalf("append #%d: %v", i, err)
		}
	}
	events, err := repo.Query("p1", "", store.FSAttributionMax+10)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != store.FSAttributionMax {
		t.Fatalf("ring must trim to %d, got %d", store.FSAttributionMax, len(events))
	}
}

func TestFSAttribution_MergeAdjacentSamePath(t *testing.T) {
	repo := newFSAttrStoreForTest(t)
	base := time.Now().Add(-time.Minute)

	// 同路径 2s 窗内紧邻事件就地合并（保存链/原子写双事件的爆发不放大账面）
	first := store.FSAttributionEvent{At: base, Path: "a.ts", Op: "create", Source: store.FSAttributionUnattributed}
	second := store.FSAttributionEvent{At: base.Add(time.Second), Path: "a.ts", Op: "write", Source: store.FSAttributionEditor}
	if err := repo.Append("p1", first); err != nil {
		t.Fatalf("append first: %v", err)
	}
	if err := repo.Append("p1", second); err != nil {
		t.Fatalf("append second: %v", err)
	}
	events, _ := repo.Query("p1", "a.ts", 10)
	if len(events) != 1 || events[0].Op != "write" || events[0].Source != store.FSAttributionEditor {
		t.Fatalf("adjacent same-path events must merge to newest, got %+v", events)
	}

	// 跨过合并窗口的同路径事件是两次独立改动，保留两条
	third := store.FSAttributionEvent{At: base.Add(5 * time.Second), Path: "a.ts", Op: "remove", Source: store.FSAttributionUnattributed}
	if err := repo.Append("p1", third); err != nil {
		t.Fatalf("append third: %v", err)
	}
	events, _ = repo.Query("p1", "a.ts", 10)
	if len(events) != 2 {
		t.Fatalf("events beyond merge window must stay separate, got %d", len(events))
	}
}

func TestFSAttribution_DeleteProject(t *testing.T) {
	repo := newFSAttrStoreForTest(t)
	if err := repo.Append("p-gone", store.FSAttributionEvent{At: time.Now(), Path: "x", Source: store.FSAttributionUnattributed}); err != nil {
		t.Fatalf("append: %v", err)
	}
	// 幂等成功（无账面项目清空同为 nil）
	if err := repo.DeleteProject("p-none"); err != nil {
		t.Fatalf("delete empty project must be idempotent, got %v", err)
	}
	if err := repo.DeleteProject("p-gone"); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	events, err := repo.Query("p-gone", "", 10)
	if err != nil || len(events) != 0 {
		t.Fatalf("project ledger must be gone, got %v events err=%v", events, err)
	}
}

func TestFSAttribution_ConcurrentAppend(t *testing.T) {
	// 并发追加不丢条目不互相覆盖（repo 锁护读改写；-race 在 Linux 验证门跑）
	repo := newFSAttrStoreForTest(t)
	base := time.Now().Add(-time.Hour)
	const goroutines, per = 8, 25
	errs := make(chan error, goroutines)
	for g := 0; g < goroutines; g++ {
		go func(g int) {
			for i := 0; i < per; i++ {
				ev := store.FSAttributionEvent{
					At:     base.Add(time.Duration(g*per+i) * time.Second),
					Path:   "g" + strconv.Itoa(g) + "-" + strconv.Itoa(i) + ".ts",
					Source: store.FSAttributionUnattributed,
				}
				if err := repo.Append("p1", ev); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}(g)
	}
	for g := 0; g < goroutines; g++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent append: %v", err)
		}
	}
	events, err := repo.Query("p1", "", 0)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != goroutines*per {
		t.Fatalf("concurrent appends must all land, want %d got %d", goroutines*per, len(events))
	}
}

func TestFSAttribution_InvalidArgs(t *testing.T) {
	repo := newFSAttrStoreForTest(t)
	if err := repo.Append("", store.FSAttributionEvent{At: time.Now(), Path: "x"}); err != store.ErrInvalidArg {
		t.Fatalf("empty projectID must be rejected, got %v", err)
	}
	if _, err := repo.Query("", "", 10); err != store.ErrInvalidArg {
		t.Fatalf("empty projectID query must be rejected, got %v", err)
	}
}
