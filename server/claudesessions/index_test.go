package claudesessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newIndexForTest 构造挂真实 filestore 的索引（独立数据目录）
func newIndexForTest(t *testing.T, root string) *Index {
	t.Helper()
	s := store.New(filestore.New(t.TempDir()))
	return NewIndex(s.ClaudeIndex, root)
}

func countIndex(t *testing.T, ix *Index) int {
	t.Helper()
	n, err := ix.repo.Count()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// 首次列表建索引、二次列表服务、结果与全量扫描逐字段一致
func TestIndexListMatchesFullScan(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\e2e-demo`), "id-old", fixtureJSONL("旧会话", now.Add(-72*time.Hour)), now.Add(-72*time.Hour))
	write(t, root, EncodePath(`D:\e2e-demo`), "id-new", fixtureJSONL("最新会话", now.Add(-time.Hour)), now.Add(-time.Hour))
	// 活跃窗口内（Active 判定不能沿用索引快照）
	write(t, root, EncodePath(`D:\e2e-other`), "id-live", fixtureJSONLCwd("另一项目", now.Add(-time.Minute), `D:\e2e-other`), now.Add(-time.Minute))

	ix := newIndexForTest(t, root)
	got, err := ix.List("", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n := countIndex(t, ix); n != 3 {
		t.Fatalf("index entries after first list = %d, want 3", n)
	}

	want, err := List(root, "", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Total != want.Total || len(got.Sessions) != len(want.Sessions) {
		t.Fatalf("total mismatch: index=%d scan=%d", got.Total, want.Total)
	}
	for i := range want.Sessions {
		g, w := got.Sessions[i], want.Sessions[i]
		if g.ID != w.ID || g.Title != w.Title || g.Cwd != w.Cwd ||
			g.MessageCount != w.MessageCount || g.Active != w.Active ||
			g.SizeBytes != w.SizeBytes || !g.LastAt.Equal(w.LastAt) ||
			g.TranscriptPath != w.TranscriptPath { // P-20261003-215：索引派生与扫描直存一致
			t.Fatalf("session %d mismatch:\n index: %+v\n scan:  %+v", i, g, w)
		}
	}
	if got.Sessions[0].ID != "id-live" || !got.Sessions[0].Active {
		t.Fatalf("newest/active session first: %+v", got.Sessions[0])
	}

	// 二次列表（全部命中索引路径）结果稳定
	again, err := ix.List("", 10, 0)
	if err != nil || again.Total != 3 {
		t.Fatalf("second list: total=%d err=%v", again.Total, err)
	}
	// 缓存命中行同样带 transcript 路径（entryToSession 同源派生，不依赖重扫）
	if want := filepath.Join(root, EncodePath(`D:\e2e-other`), "id-live.jsonl"); again.Sessions[0].TranscriptPath != want {
		t.Fatalf("cache-hit TranscriptPath = %q, want %q", again.Sessions[0].TranscriptPath, want)
	}
}

// 对账：新文件出现、文件变更（mtime+内容）、文件消失都即时反映且索引条目同步增减
func TestIndexReconcilesChanges(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := EncodePath(`D:\e2e-demo`)
	write(t, root, dir, "id-a", fixtureJSONL("标题A", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))

	ix := newIndexForTest(t, root)
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("first list: %+v %v", res, err)
	}
	if res.Sessions[0].MessageCount != 3 {
		t.Fatalf("fixture line count = %d, want 3", res.Sessions[0].MessageCount)
	}

	// 变更：追加一行 + 推进 mtime → 计数变化反映到列表
	path := filepath.Join(root, dir, "id-a.jsonl")
	fixture := fixtureJSONL("标题A", now.Add(-2*time.Hour), `{"type":"summary","summary":"extra"}`)
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	mtime := now.Add(-time.Hour)
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	// 新文件
	write(t, root, dir, "id-b", fixtureJSONL("标题B", now.Add(-30*time.Minute)), now.Add(-30*time.Minute))

	res, err = ix.List("", 10, 0)
	if err != nil || res.Total != 2 {
		t.Fatalf("after add+change: total=%d err=%v", res.Total, err)
	}
	if res.Sessions[0].ID != "id-b" {
		t.Fatalf("newest first: %+v", res.Sessions[0])
	}
	for _, s := range res.Sessions {
		if s.ID == "id-a" && s.MessageCount != 4 {
			t.Fatalf("changed file must be rescanned: count=%d", s.MessageCount)
		}
	}

	// 删除：条目消失，索引同步清除
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	res, err = ix.List("", 10, 0)
	if err != nil || res.Total != 1 || res.Sessions[0].ID != "id-b" {
		t.Fatalf("after delete: %+v %v", res, err)
	}
	if n := countIndex(t, ix); n != 1 {
		t.Fatalf("index entries after delete = %d, want 1", n)
	}
}

// 项目级列表只碰自己目录；整个项目目录被删后，全局列表兜底清残留
func TestIndexProjectScopeAndRemovedDirCleanup(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dirA := EncodePath(`D:\projA`)
	dirB := EncodePath(`D:\projB`)
	write(t, root, dirA, "a1", fixtureJSONLCwd("A会话", now.Add(-time.Hour), `D:\projA`), now.Add(-time.Hour))
	write(t, root, dirB, "b1", fixtureJSONLCwd("B会话", now.Add(-2*time.Hour), `D:\projB`), now.Add(-2*time.Hour))

	ix := newIndexForTest(t, root)
	res, err := ix.List(`D:\projA`, 10, 0)
	if err != nil || res.Total != 1 || res.Sessions[0].ID != "a1" {
		t.Fatalf("project scope: %+v %v", res, err)
	}
	// 先全局列表一次，让 dirB 也进入索引（项目级列表只对账自己的目录）
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	if n := countIndex(t, ix); n != 2 {
		t.Fatalf("entries after global list = %d, want 2", n)
	}

	// 整目录删除：项目级列表返回空并清掉自己目录的条目
	if err := os.RemoveAll(filepath.Join(root, dirA)); err != nil {
		t.Fatal(err)
	}
	res, err = ix.List(`D:\projA`, 10, 0)
	if err != nil || res.Total != 0 {
		t.Fatalf("removed dir project list: %+v %v", res, err)
	}
	if n := countIndex(t, ix); n != 1 {
		t.Fatalf("entries after dir removed = %d, want 1 (dirB only)", n)
	}

	// dirB 整目录删除后的残留由全局列表兜底清除
	if err := os.RemoveAll(filepath.Join(root, dirB)); err != nil {
		t.Fatal(err)
	}
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	if n := countIndex(t, ix); n != 0 {
		t.Fatalf("global list must sweep stale entries of removed dirs, got %d", n)
	}
}

// 索引损坏/清空（模拟删除 data/claudeindex 目录）后，下一次列表即全量重建
func TestIndexRebuildAfterWipe(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\e2e-demo`), "id-1", fixtureJSONL("标题", now.Add(-time.Hour)), now.Add(-time.Hour))

	tmp := t.TempDir()
	doc := filestore.New(tmp)
	s := store.New(doc)
	ix := NewIndex(s.ClaudeIndex, root)

	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	// 清空索引（等价删除 kind 目录）
	if err := doc.Clear("claudeindex"); err != nil {
		t.Fatal(err)
	}
	if n := countIndex(t, ix); n != 0 {
		t.Fatalf("wipe failed: %d", n)
	}
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 || res.Sessions[0].Title != "标题" {
		t.Fatalf("rebuild after wipe: %+v %v", res, err)
	}
	if n := countIndex(t, ix); n != 1 {
		t.Fatalf("rebuild must repopulate index, got %d", n)
	}
}
