package git

import (
	"os"
	"path/filepath"
	"testing"
)

// OperationInProgress：冲突接口顺带返回的「进行中有序操作」探测。
// 冲突全解后 rebase-merge/MERGE_HEAD 仍在 → 前端据此显示继续/完成操作条
func TestOperationInProgress(t *testing.T) {
	initRepo := func(t *testing.T) string {
		t.Helper()
		repo := t.TempDir()
		if _, err := execGit(repo, "init", "-q"); err != nil {
			t.Fatalf("init: %v", err)
		}
		if _, err := execGit(repo, "config", "user.email", "t@t"); err != nil {
			t.Fatalf("config: %v", err)
		}
		if _, err := execGit(repo, "config", "user.name", "t"); err != nil {
			t.Fatalf("config: %v", err)
		}
		if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a\n"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := execGit(repo, "add", "."); err != nil {
			t.Fatalf("add: %v", err)
		}
		if _, err := execGit(repo, "commit", "-q", "-m", "base"); err != nil {
			t.Fatalf("commit: %v", err)
		}
		return repo
	}

	t.Run("干净仓库为空", func(t *testing.T) {
		repo := initRepo(t)
		if got := OperationInProgress(repo); got != "" {
			t.Fatalf("expect empty, got %q", got)
		}
	})

	t.Run("merge 进行中", func(t *testing.T) {
		repo := initRepo(t)
		gitDir, ok := resolveGitDir(repo)
		if !ok {
			t.Fatal("resolveGitDir failed")
		}
		if err := os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte("0123456789abcdef\n"), 0o644); err != nil {
			t.Fatalf("write MERGE_HEAD: %v", err)
		}
		if got := OperationInProgress(repo); got != "merge" {
			t.Fatalf("expect merge, got %q", got)
		}
	})

	t.Run("rebase-merge 目录优先", func(t *testing.T) {
		repo := initRepo(t)
		gitDir, ok := resolveGitDir(repo)
		if !ok {
			t.Fatal("resolveGitDir failed")
		}
		if err := os.MkdirAll(filepath.Join(gitDir, "rebase-merge"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte("x\n"), 0o644); err != nil {
			t.Fatalf("write MERGE_HEAD: %v", err)
		}
		if got := OperationInProgress(repo); got != "rebase" {
			t.Fatalf("expect rebase, got %q", got)
		}
		if !IsRebasing(repo) {
			t.Fatal("IsRebasing should be true with rebase-merge dir")
		}
	})

	t.Run("worktree .git 指针文件解析", func(t *testing.T) {
		repo := initRepo(t)
		// 把 .git 改写为 worktree 指针文件，指向的目录里放 rebase-apply
		realDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(realDir, "rebase-apply"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		pointer := "gitdir: " + filepath.ToSlash(realDir) + "\n"
		if err := os.RemoveAll(filepath.Join(repo, ".git")); err != nil {
			t.Fatalf("remove .git: %v", err)
		}
		if err := os.WriteFile(filepath.Join(repo, ".git"), []byte(pointer), 0o644); err != nil {
			t.Fatalf("write .git pointer: %v", err)
		}
		if got := OperationInProgress(repo); got != "rebase" {
			t.Fatalf("expect rebase via worktree gitdir, got %q", got)
		}
	})

	t.Run("非仓库目录为空", func(t *testing.T) {
		if got := OperationInProgress(t.TempDir()); got != "" {
			t.Fatalf("expect empty, got %q", got)
		}
	})
}
