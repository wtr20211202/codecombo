package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Rollback ref 形态闸与检出语义（P-20261008-11 单文件聚合时间线的 git 条目恢复）：
// 缺省/空 = HEAD 既有整文件回滚语义不变；非空 = 检出该提交的文件版本进工作区；
// flag 形态（'-' 前缀）与空白/控制字符的 ref 必须被拒绝（ref 拼在 `--` 之前，
// 形态不闸会被 git 当 flag 解析）。

func newRollbackFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	run("init", "-b", "main")
	run("config", "core.autocrlf", "false") // 三平台行尾语义对齐（e2e 同款口径）
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	write("f.txt", "v1\n")
	run("add", ".")
	run("commit", "-m", "c1")
	// 工作区推进到 v2（已提交 c2）再叠未提交改动 v3：检出 c1 应回 v1 且不吞 c2
	write("f.txt", "v2\n")
	run("add", ".")
	run("commit", "-m", "c2")
	write("f.txt", "v3-uncommitted\n")
	return dir
}

func TestRollbackAtRefChecksOutCommitVersion(t *testing.T) {
	dir := newRollbackFixture(t)
	c1 := strings.TrimSpace(func() string {
		out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD~1").CombinedOutput()
		if err != nil {
			t.Fatalf("rev-parse HEAD~1: %v: %s", err, out)
		}
		return string(out)
	}())

	if err := Rollback(dir, []string{"f.txt"}, c1); err != nil {
		t.Fatalf("Rollback(c1): %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(b) != "v1\n" {
		t.Fatalf("worktree after checkout c1 = %q, want v1", string(b))
	}

	// 缺省 ref = HEAD：既有整文件回滚语义（丢弃未提交改动回当前提交版本）
	if err := Rollback(dir, []string{"f.txt"}, ""); err != nil {
		t.Fatalf("Rollback(empty): %v", err)
	}
	if got := readBack(t, dir, "f.txt"); got != "v2\n" {
		t.Fatalf("worktree after default rollback = %q, want v2 (HEAD)", got)
	}
}

func TestRollbackRejectsFlagShapedAndWhitespaceRef(t *testing.T) {
	dir := newRollbackFixture(t)
	for _, ref := range []string{"-b", "--all", "HEAD extra", "HEAD\t", "bad\nref", "\x7f"} {
		if err := Rollback(dir, []string{"f.txt"}, ref); err == nil {
			t.Fatalf("Rollback(ref=%q) expected error, got nil", ref)
		}
	}
}

func readBack(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}
