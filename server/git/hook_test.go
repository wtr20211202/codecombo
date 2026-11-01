package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initHookTestRepo 造一个真实 git 仓库：GetHooksPath 依赖 rev-parse --git-path
// 的真实输出（相对/绝对路径形态随仓库位置变化），不能 mock 掉
func initHookTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-b", "main")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	return dir
}

// TestGetHooksPathAnchorsToRepo 回归：--git-path 对标准仓库返回相对路径
// （.git/hooks），必须锚定回仓库绝对路径——曾因未锚定，钩子被写到服务进程
// CWD 下的同名目录（e2e 实测误写入服务自身仓库）
func TestGetHooksPathAnchorsToRepo(t *testing.T) {
	repo := initHookTestRepo(t)
	got := GetHooksPath(repo)
	if !filepath.IsAbs(got) {
		t.Fatalf("hooks path 应为绝对路径，got %q", got)
	}
	want := filepath.Join(repo, ".git", "hooks")
	if filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("hooks path = %q, want %q", got, want)
	}
}

// TestUpdateHookRoundTrip 写 → 列表 enabled → 读回内容一致 → 删除：
// 全程以仓库 .git/hooks 内的真实文件为准（写错目录时本测试即红）
func TestUpdateHookRoundTrip(t *testing.T) {
	repo := initHookTestRepo(t)
	content := "#!/bin/sh\necho hook-roundtrip\n"
	if err := UpdateHook(repo, "pre-commit", content, true); err != nil {
		t.Fatalf("UpdateHook: %v", err)
	}
	hookPath := filepath.Join(repo, ".git", "hooks", "pre-commit")
	if _, err := os.Stat(hookPath); err != nil {
		t.Fatalf("pre-commit 应写入仓库 hooks 目录: %v", err)
	}

	hooks, err := ListHooks(repo)
	if err != nil {
		t.Fatalf("ListHooks: %v", err)
	}
	var found *GitHook
	for i := range hooks {
		if hooks[i].Name == "pre-commit" {
			found = &hooks[i]
			break
		}
	}
	if found == nil || !found.Enabled || !strings.Contains(found.Content, "hook-roundtrip") {
		t.Fatalf("ListHooks 未反映已保存的 pre-commit: %+v", found)
	}

	got, err := GetHookContent(repo, "pre-commit")
	if err != nil || !strings.Contains(got, "hook-roundtrip") {
		t.Fatalf("GetHookContent = %q, %v", got, err)
	}

	if err := DeleteHook(repo, "pre-commit"); err != nil {
		t.Fatalf("DeleteHook: %v", err)
	}
	if _, err := os.Stat(hookPath); !os.IsNotExist(err) {
		t.Fatalf("DeleteHook 后 pre-commit 仍存在: %v", err)
	}
}
