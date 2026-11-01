package store_test

import (
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newGitPathTestStore 构造基于临时目录的独立远端路径记忆仓储（不污染全局 Store）
func newGitPathTestStore(t *testing.T) store.RemoteGitPathStore {
	t.Helper()
	return store.NewRemoteGitPathRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestRemoteGitPath_SetGetMemory 基础读写：Set 后 Get 命中；未写入的键 miss
func TestRemoteGitPath_SetGetMemory(t *testing.T) {
	r := newGitPathTestStore(t)

	if _, ok := r.Get("h1", "p1"); ok {
		t.Fatalf("expected no memory before first Set")
	}
	if err := r.Set("h1", "p1", "/srv/app"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, ok := r.Get("h1", "p1")
	if !ok || got != "/srv/app" {
		t.Fatalf("Get: ok=%v path=%q", ok, got)
	}
	// 同键覆盖（重新 checkout 换目录）
	if err := r.Set("h1", "p1", "/srv/app-v2"); err != nil {
		t.Fatalf("Set overwrite: %v", err)
	}
	if got, _ := r.Get("h1", "p1"); got != "/srv/app-v2" {
		t.Fatalf("expected overwritten path, got %q", got)
	}
	// host+project 隔离
	if _, ok := r.Get("h1", "p2"); ok {
		t.Fatalf("expected miss for other project")
	}
	if _, ok := r.Get("h2", "p1"); ok {
		t.Fatalf("expected miss for other host")
	}
}

// TestRemoteGitPath_SetEmptyClears 空路径 = 清记忆（删除条目而非写空串）
func TestRemoteGitPath_SetEmptyClears(t *testing.T) {
	r := newGitPathTestStore(t)
	if err := r.Set("h1", "p1", "/srv/app"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := r.Set("h1", "p1", ""); err != nil {
		t.Fatalf("Set empty: %v", err)
	}
	if _, ok := r.Get("h1", "p1"); ok {
		t.Fatalf("expected memory cleared after empty Set")
	}
	// 清理后再清一次：幂等不报错
	if err := r.Set("h1", "p1", ""); err != nil {
		t.Fatalf("Set empty again: %v", err)
	}
}

// TestRemoteGitPath_DeleteHostCascade 主机删除级联清理该主机全部条目，
// 其他主机条目不受影响
func TestRemoteGitPath_DeleteHostCascade(t *testing.T) {
	r := newGitPathTestStore(t)
	for _, k := range [][2]string{{"h1", "p1"}, {"h1", "p2"}, {"h2", "p1"}} {
		if err := r.Set(k[0], k[1], "/srv/"+k[0]+"-"+k[1]); err != nil {
			t.Fatalf("Set %v: %v", k, err)
		}
	}
	r.DeleteHost("h1")
	if _, ok := r.Get("h1", "p1"); ok {
		t.Fatalf("expected h1/p1 cleared")
	}
	if _, ok := r.Get("h1", "p2"); ok {
		t.Fatalf("expected h1/p2 cleared")
	}
	if got, ok := r.Get("h2", "p1"); !ok || got != "/srv/h2-p1" {
		t.Fatalf("expected h2 entry untouched, ok=%v got=%q", ok, got)
	}
}

// TestRemoteGitPath_InvalidArgs 空主机/项目 id 拒绝写入（ErrInvalidArg）
func TestRemoteGitPath_InvalidArgs(t *testing.T) {
	r := newGitPathTestStore(t)
	if err := r.Set("", "p1", "/x"); err != store.ErrInvalidArg {
		t.Fatalf("expected ErrInvalidArg for empty host, got %v", err)
	}
	if err := r.Set("h1", "", "/x"); err != store.ErrInvalidArg {
		t.Fatalf("expected ErrInvalidArg for empty project, got %v", err)
	}
}
