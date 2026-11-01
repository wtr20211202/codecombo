package git

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// mergeSquash 压平合并（P-20261007-18）：squash 产单条汇总提交 / 默认路径零
// 回归 / 冲突保留索引冲突态 / 已包含拒绝 / 非法策略拒绝。
// fixture 沿 merge_inprogress_test 同款：initRepo + repo 级 user 配置
//（execGit 的 git commit 需要作者身份）
func initSquashRepo(t *testing.T) string {
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
	// Windows 检出换行转换会干扰文件内容断言——fixture 内固定 LF
	if _, err := execGit(repo, "config", "core.autocrlf", "false"); err != nil {
		t.Fatalf("config autocrlf: %v", err)
	}
	writeRepoFile(t, repo, "base.txt", "base\n")
	if _, err := execGit(repo, "add", "."); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := execGit(repo, "commit", "-q", "-m", "base"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return repo
}

func writeRepoFile(t *testing.T, repo, rel, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, rel), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// newFeatureBranchWithCommits 从当前 HEAD 拉出 feature 分支并落 n 条提交
func newFeatureBranchWithCommits(t *testing.T, repo, branch string, subjects []string) {
	t.Helper()
	if _, err := execGit(repo, "checkout", "-q", "-b", branch); err != nil {
		t.Fatalf("checkout -b: %v", err)
	}
	for i, s := range subjects {
		writeRepoFile(t, repo, "f"+strings.Repeat("x", i+1)+".txt", s+"\n")
		if _, err := execGit(repo, "add", "."); err != nil {
			t.Fatalf("add: %v", err)
		}
		if _, err := execGit(repo, "commit", "-q", "-m", s); err != nil {
			t.Fatalf("commit %q: %v", s, err)
		}
	}
	if _, err := execGit(repo, "checkout", "-q", "master"); err != nil {
		t.Fatalf("checkout master: %v", err)
	}
}

// mustExec / mustExecInt 测试内直跑 git 的小封装：失败即 Fatal，断言读数用
func mustExec(t *testing.T, repo string, args ...string) string {
	t.Helper()
	out, err := execGit(repo, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return out
}

func mustExecInt(t *testing.T, repo string, args ...string) int {
	t.Helper()
	n, err := strconv.Atoi(strings.TrimSpace(mustExec(t, repo, args...)))
	if err != nil {
		t.Fatalf("git %v: parse int: %v", args, err)
	}
	return n
}

func TestMergeSquashSingleCommit(t *testing.T) {
	repo := initSquashRepo(t)
	base := strings.TrimSpace(mustExec(t, repo, "rev-parse", "HEAD"))
	newFeatureBranchWithCommits(t, repo, "feature", []string{"s1 first", "s2 middle", "s3 last"})

	if _, err := Merge(repo, "feature", MergeStrategySquash, ""); err != nil {
		t.Fatalf("squash merge: %v", err)
	}
	// 单新提交：base..HEAD 恰一条（三提交功能分支压平）
	if n := mustExecInt(t, repo, "rev-list", "--count", base+"..HEAD"); n != 1 {
		t.Fatalf("commits since base = %d, want 1", n)
	}
	// 默认消息「(<source>) N commits: 首末提交标题」
	if subj := strings.TrimSpace(mustExec(t, repo, "log", "-1", "--format=%s")); subj != "(feature) 3 commits: s1 first .. s3 last" {
		t.Fatalf("squash subject = %q", subj)
	}
	// 工作树内容到位
	data, err := os.ReadFile(filepath.Join(repo, "fxxx.txt"))
	if err != nil || string(data) != "s3 last\n" {
		t.Fatalf("worktree content = %q, err=%v", string(data), err)
	}
	// 源分支保持现状：不自动删除
	if _, err := execGit(repo, "rev-parse", "--verify", "refs/heads/feature"); err != nil {
		t.Fatalf("source branch should survive squash merge: %v", err)
	}
}

func TestMergeSquashCustomMessage(t *testing.T) {
	repo := initSquashRepo(t)
	newFeatureBranchWithCommits(t, repo, "feature", []string{"s1", "s2"})

	if _, err := Merge(repo, "feature", MergeStrategySquash, "feat: 汇总落一条"); err != nil {
		t.Fatalf("squash merge: %v", err)
	}
	if subj := strings.TrimSpace(mustExec(t, repo, "log", "-1", "--format=%s")); subj != "feat: 汇总落一条" {
		t.Fatalf("squash subject = %q, want custom message", subj)
	}
}

// 默认路径零回归：strategy 空串行为与旧签名一致（本 fixture 为 fast-forward）
func TestMergeDefaultPathUnchanged(t *testing.T) {
	repo := initSquashRepo(t)
	newFeatureBranchWithCommits(t, repo, "feature", []string{"s1", "s2", "s3"})

	out, err := Merge(repo, "feature", MergeStrategyDefault, "")
	if err != nil {
		t.Fatalf("default merge: %v", err)
	}
	_ = out
	// fast-forward：源分支三条提交原样流入，无压平
	if subj := strings.TrimSpace(mustExec(t, repo, "log", "-1", "--format=%s")); subj != "s3" {
		t.Fatalf("HEAD subject = %q, want fast-forward to s3", subj)
	}
	if n := mustExecInt(t, repo, "rev-list", "--count", "HEAD"); n != 4 {
		t.Fatalf("total commits = %d, want 4 (base + 3)", n)
	}
	// 旧调用形态（strategy/message 零值）显式兜底确认
	repo2 := initSquashRepo(t)
	newFeatureBranchWithCommits(t, repo2, "feature", []string{"s1"})
	if _, err := Merge(repo2, "feature", "", ""); err != nil {
		t.Fatalf("empty-strategy merge: %v", err)
	}
	if n := mustExecInt(t, repo2, "rev-list", "--count", "HEAD"); n != 2 {
		t.Fatalf("repo2 total commits = %d, want 2", n)
	}
}

// 冲突：索引冲突态保留供既有冲突解决域处置，不落提交、无 MERGE_HEAD
//（--squash 不写，inProgress 探测为空，解决后经常规提交收尾）
func TestMergeSquashConflictKeepsIndexState(t *testing.T) {
	repo := initSquashRepo(t)
	if _, err := execGit(repo, "checkout", "-q", "-b", "feature"); err != nil {
		t.Fatalf("checkout -b: %v", err)
	}
	writeRepoFile(t, repo, "base.txt", "feature side\n")
	if _, err := execGit(repo, "add", "."); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := execGit(repo, "commit", "-q", "-m", "feature edit"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := execGit(repo, "checkout", "-q", "master"); err != nil {
		t.Fatalf("checkout master: %v", err)
	}
	writeRepoFile(t, repo, "base.txt", "master side\n")
	if _, err := execGit(repo, "add", "."); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := execGit(repo, "commit", "-q", "-m", "master edit"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	head := strings.TrimSpace(mustExec(t, repo, "rev-parse", "HEAD"))

	_, err := Merge(repo, "feature", MergeStrategySquash, "")
	if err == nil {
		t.Fatal("squash merge with conflict should fail")
	}
	// 冲突清单可见（GetConflictFiles 同源 porcelain 口径）
	conflicts, cerr := GetConflictFiles(repo)
	if cerr != nil || len(conflicts) == 0 {
		t.Fatalf("conflict files = %v, err=%v, want non-empty", conflicts, cerr)
	}
	// 不落提交：HEAD 原地
	if now := strings.TrimSpace(mustExec(t, repo, "rev-parse", "HEAD")); now != head {
		t.Fatalf("HEAD moved on conflicted squash merge")
	}
	// 无 MERGE_HEAD：inProgress 探测为空（前端不出「完成合并」条，
	// 解决后走常规提交链）
	if op := OperationInProgress(repo); op != "" {
		t.Fatalf("OperationInProgress = %q, want empty (no MERGE_HEAD for --squash)", op)
	}
}

// 源分支已无领先提交：动索引前如实拒绝（--squash 对 already-up-to-date 是
// 退出 0 的 no-op，硬走到提交步会撞 nothing to commit）
func TestMergeSquashNothingToSquash(t *testing.T) {
	repo := initSquashRepo(t)
	_, err := Merge(repo, "master", MergeStrategySquash, "")
	if err == nil || !strings.Contains(err.Error(), "nothing to squash merge") {
		t.Fatalf("err = %v, want nothing to squash merge", err)
	}
}

func TestMergeInvalidStrategy(t *testing.T) {
	repo := initSquashRepo(t)
	newFeatureBranchWithCommits(t, repo, "feature", []string{"s1"})
	if _, err := Merge(repo, "feature", "rebase", ""); err == nil || !strings.Contains(err.Error(), "invalid merge strategy") {
		t.Fatalf("err = %v, want invalid merge strategy", err)
	}
}
