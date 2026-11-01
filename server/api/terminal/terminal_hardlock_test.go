package terminal

import (
	"path/filepath"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 项目硬锁（P-20261004-3）agent 会话目录守卫的纯函数单测：
// 包含判定（项目根/子目录命中）与边界（前缀重叠非包含、锁外项目、空 dir）。
// 不经 HTTP——建会话方向会真起 PTY/agent 运行时，不在单测射程内。

func setupDirGuardStore(t *testing.T) (lockedRoot, openRoot string) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	lockedRoot = t.TempDir()
	openRoot = t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-lock", Name: "locked", Path: lockedRoot, Locked: true}); err != nil {
		t.Fatalf("create locked: %v", err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-open", Name: "open", Path: openRoot}); err != nil {
		t.Fatalf("create open: %v", err)
	}
	return lockedRoot, openRoot
}

func TestLockedProjectForDirHits(t *testing.T) {
	lockedRoot, _ := setupDirGuardStore(t)

	// 项目根本身
	if p := lockedProjectForDir(lockedRoot); p == nil || p.ID != "p-lock" {
		t.Fatalf("project root must hit locked project, got %+v", p)
	}
	// 子目录
	sub := filepath.Join(lockedRoot, "a", "b")
	if p := lockedProjectForDir(sub); p == nil || p.ID != "p-lock" {
		t.Fatalf("subdir must hit locked project, got %+v", p)
	}
}

func TestLockedProjectForDirMisses(t *testing.T) {
	lockedRoot, openRoot := setupDirGuardStore(t)

	// 空 dir（= 用户主目录语义）不命中
	if p := lockedProjectForDir(""); p != nil {
		t.Fatalf("empty dir must miss, got %+v", p)
	}
	// 锁外项目目录不命中
	if p := lockedProjectForDir(openRoot); p != nil {
		t.Fatalf("outside project dir must miss, got %+v", p)
	}
	// 前缀重叠但非包含（/root vs /root2）不命中
	sibling := lockedRoot + "2"
	if p := lockedProjectForDir(sibling); p != nil {
		t.Fatalf("prefix-overlapping sibling must miss, got %+v", p)
	}
	// 大小写变体命中（Windows/macOS 不敏感盘语义，锁定宁可误拒）
	if p := lockedProjectForDir(filepath.Join(upperASCII(lockedRoot), "x")); p == nil || p.ID != "p-lock" {
		t.Fatalf("case-variant path must still hit locked project, got %+v", p)
	}
}

// upperASCII 把路径中的 ASCII 字母翻成大写（大小写折叠判定的测试辅助）
func upperASCII(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'a' && r <= 'z' {
			out[i] = r - 32
		}
	}
	return string(out)
}
