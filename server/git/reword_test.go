package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initTestRepo 建一个带两个提交的测试仓库（main 分支：c1 → c2）
func initTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "c1: first commit")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "c2: second commit")
	return dir
}

// headMessage 读当前 HEAD 提交信息
func headMessage(t *testing.T, dir string) string {
	t.Helper()
	out, err := execGit(dir, "log", "-1", "--format=%B")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(out)
}

func commitSubject(t *testing.T, dir, ref string) string {
	t.Helper()
	out, err := execGit(dir, "log", "-1", "--format=%s", ref)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(out)
}

// TestRewordHeadCommit HEAD 提交走 amend --only：信息被改、不卷入已暂存变更
func TestRewordHeadCommit(t *testing.T) {
	dir := initTestRepo(t)

	// 模拟用户已暂存但未提交的变更：裸 --amend 会把它卷进提交（历史缺陷语义）
	if err := os.WriteFile(filepath.Join(dir, "staged.txt"), []byte("staged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := execGit(dir, "add", "staged.txt"); err != nil {
		t.Fatalf("stage: %v (%s)", err, out)
	}

	result, err := RewordCommitMessage(dir, mustRevParse(dir, "HEAD"), "c2: reworded message", false)
	if err != nil {
		t.Fatalf("reword: %v", err)
	}
	if !result.Amended {
		t.Fatal("HEAD reword should take the amend path")
	}
	if got := headMessage(t, dir); got != "c2: reworded message" {
		t.Fatalf("HEAD message = %q", got)
	}
	// --only 语义：已暂存文件不得被卷入提交
	out, err := execGit(dir, "status", "--porcelain")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "A  staged.txt") && !strings.Contains(out, "A  staged.txt\r") {
		t.Fatalf("staged file was folded into the amended commit (status=%q)", out)
	}
}

// TestRewordOlderCommit 历史中段提交走 rebase reword：目标信息被改、其余提交保留
func TestRewordOlderCommit(t *testing.T) {
	dir := initTestRepo(t)

	c1 := strings.TrimSpace(mustRevParse(dir, "HEAD~1"))
	result, err := RewordCommitMessage(dir, c1, "c1: reworded first commit", false)
	if err != nil {
		t.Fatalf("reword: %v", err)
	}
	if result.Amended {
		t.Fatal("non-HEAD reword must not take the amend path")
	}
	if got := commitSubject(t, dir, "main~1"); got != "c1: reworded first commit" {
		t.Fatalf("c1 subject = %q", got)
	}
	if got := commitSubject(t, dir, "main"); got != "c2: second commit" {
		t.Fatalf("HEAD subject = %q (descendant must survive rebase)", got)
	}
	// 文件内容不被改写（autocrlf 检出可能是 CRLF，归一后比较）
	data, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil || strings.TrimSpace(string(data)) != "v2" {
		t.Fatalf("worktree content changed: %q %v", data, err)
	}
}

// TestRewordPushedCommitRequiresConfirm 已推送提交：未确认时拒绝并给全分支列表
func TestRewordPushedCommitRequiresConfirm(t *testing.T) {
	dir := initTestRepo(t)
	// 建一个"远程"裸仓库并推送，制造已推送提交
	bare := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "--bare", bare).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v (%s)", err, out)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("remote", "add", "origin", filepath.ToSlash(bare))
	run("push", "-u", "origin", "main")

	// pushed 探测
	pushed, branches, err := CommitPushedInfo(dir, "main")
	if err != nil || !pushed {
		t.Fatalf("pushed = %v, branches = %v, err = %v", pushed, branches, err)
	}
	if len(branches) == 0 || !strings.Contains(branches[0], "origin/main") {
		t.Fatalf("branches = %v, want origin/main", branches)
	}

	mainHash := strings.TrimSpace(mustRevParse(dir, "main"))
	// 未确认：拒绝（ErrCommitPushed）
	if _, err := RewordCommitMessage(dir, mainHash, "rewritten", false); err == nil || err.Error() != ErrCommitPushed.Error() {
		t.Fatalf("want ErrCommitPushed, got %v", err)
	}
	// 确认后：允许改写
	if _, err := RewordCommitMessage(dir, mainHash, "rewritten after confirm", true); err != nil {
		t.Fatalf("confirmed reword: %v", err)
	}
	if got := commitSubject(t, dir, "main"); got != "rewritten after confirm" {
		t.Fatalf("subject = %q", got)
	}
}

// TestRewordMergeCommitRejected 合并提交拒绝 reword
func TestRewordMergeCommitRejected(t *testing.T) {
	dir := initTestRepo(t)
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "feature work")
	run("checkout", "main")
	if err := os.WriteFile(filepath.Join(dir, "m.txt"), []byte("m\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "main work")
	run("merge", "--no-ff", "feature", "-m", "merge feature")

	head := strings.TrimSpace(mustRevParse(dir, "HEAD"))
	if _, err := RewordCommitMessage(dir, head, "reword merge", true); err == nil {
		t.Fatal("merge commit reword must be rejected")
	} else if !strings.Contains(err.Error(), "merge") {
		t.Fatalf("error = %v, want merge-related", err)
	}
}

// TestRewordValidation 非法入参：空信息 / 非法哈希
func TestRewordValidation(t *testing.T) {
	dir := initTestRepo(t)
	if _, err := RewordCommitMessage(dir, "HEAD", "   ", false); err == nil {
		t.Fatal("empty message must be rejected")
	}
	if _, err := RewordCommitMessage(dir, "abc", "msg", false); err == nil {
		t.Fatal("short hash must be rejected")
	}
	if _, err := RewordCommitMessage(dir, "zzzzzzz-not-hex!!", "msg", false); err == nil {
		t.Fatal("non-hex input must be rejected")
	}
}
