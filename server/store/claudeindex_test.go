package store_test

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 车道 1 新 repo 主路径单测：键派生（prefix 命中/隔离）+ Put/GetBatch/Delete/Count
func TestClaudeIndexStoreRoundtrip(t *testing.T) {
	s := store.New(filestore.New(t.TempDir()))

	k1 := store.ClaudeIndexKey(`C:\root1`, "D--projA", "uuid-1")
	k2 := store.ClaudeIndexKey(`C:\root1`, "D--projB", "uuid-2")
	k3 := store.ClaudeIndexKey(`C:\root2`, "D--projA", "uuid-3")

	now := time.Now()
	entries := []store.ClaudeIndexEntry{
		{Key: k1, ID: "uuid-1", Dir: "D--projA", Title: "t1", MessageCount: 3, LastAt: now, MtimeNs: now.UnixNano()},
		{Key: k2, ID: "uuid-2", Dir: "D--projB", Title: "t2", MessageCount: 1, LastAt: now, MtimeNs: now.UnixNano()},
		{Key: k3, ID: "uuid-3", Dir: "D--projA", Title: "t3", MessageCount: 2, LastAt: now, MtimeNs: now.UnixNano()},
	}
	for _, e := range entries {
		if err := s.ClaudeIndex.Put(e); err != nil {
			t.Fatal(err)
		}
	}

	// root1 全量 = 2 条（root2 隔离）；root1/projA = 1 条
	got, err := s.ClaudeIndex.GetBatch(store.ClaudeIndexPrefix(`C:\root1`, ""))
	if err != nil || len(got) != 2 {
		t.Fatalf("root1 batch: %v %v", got, err)
	}
	gotA, err := s.ClaudeIndex.GetBatch(store.ClaudeIndexPrefix(`C:\root1`, "D--projA"))
	if err != nil || len(gotA) != 1 || gotA[k1].Title != "t1" || gotA[k1].Key != k1 {
		t.Fatalf("dirA batch: %v %v", gotA, err)
	}
	if n, _ := s.ClaudeIndex.Count(); n != 3 {
		t.Fatalf("count = %d, want 3", n)
	}

	if err := s.ClaudeIndex.Delete(k2); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ClaudeIndex.GetBatch(store.ClaudeIndexPrefix(`C:\root1`, "")); len(got) != 1 {
		t.Fatalf("after delete: %v", got)
	}
}
