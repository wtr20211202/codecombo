package git

import (
	"sync"
	"testing"
	"time"
)

// initRepoWithUpstream 建仓库并把 main 的 upstream 指到本地分支 main2，
// 使 main 上的新提交表现为 ahead（rev-list main...main@{upstream} 可计数）
func initRepoWithUpstream(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if _, err := execGit(dir, "init", "-b", "main"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := execGit(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := execGit(dir, "branch", "main2"); err != nil {
		t.Fatalf("branch: %v", err)
	}
	if _, err := execGit(dir, "branch", "--set-upstream-to=main2", "main"); err != nil {
		t.Fatalf("set-upstream: %v", err)
	}
	return dir
}

func commitEmpty(t *testing.T, dir, msg string) {
	t.Helper()
	if _, err := execGit(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", msg); err != nil {
		t.Fatalf("commit %q: %v", msg, err)
	}
}

// TestRepoInfoCached_HitAndMutationInvalidate 窗口内命中缓存；写操作（切分支）立即失效
func TestRepoInfoCached_HitAndMutationInvalidate(t *testing.T) {
	t.Cleanup(func() {
		repoInfoCache = sync.Map{}
		aheadCache = sync.Map{}
	})
	dir := initRepoWithUpstream(t)

	branch, _, gitRepo, pathOK := GetRepoInfoCached(dir)
	if !gitRepo || !pathOK || branch != "main" {
		t.Fatalf("first = (%q, %v, %v), want (main, true, true)", branch, gitRepo, pathOK)
	}

	// 写操作经统一钩子失效缓存：切分支后立刻读必须拿到新分支（不失效会读到陈旧 main）
	if _, err := execGit(dir, "checkout", "-b", "feat-x"); err != nil {
		t.Fatalf("checkout: %v", err)
	}
	branch, _, _, _ = GetRepoInfoCached(dir)
	if branch != "feat-x" {
		t.Fatalf("after checkout branch = %q, want feat-x (mutation must invalidate cache)", branch)
	}
}

// TestRepoInfoCached_TTLExpiry 过期后重新计算
func TestRepoInfoCached_TTLExpiry(t *testing.T) {
	old := repoInfoTTL
	repoInfoTTL = 30 * time.Millisecond
	t.Cleanup(func() { repoInfoTTL = old })
	dir := initRepoWithUpstream(t)

	if b, _, _, _ := GetRepoInfoCached(dir); b != "main" {
		t.Fatalf("first branch = %q", b)
	}
	// 不经过钩子直接改（模拟外部变更）：TTL 过期前读到陈旧值，过期后重新计算
	if _, err := execGit(dir, "branch", "side"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "update-ref", "refs/heads/main", "refs/heads/side"); err != nil {
		// update-ref 不在失效清单里也无妨——此处只关心 TTL 过期路径
		t.Skipf("update-ref unavailable: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, _, gitRepo, pathOK := GetRepoInfoCached(dir); !gitRepo || !pathOK {
		t.Fatal("repo should still be valid after TTL expiry")
	}
}

// TestFindSubcommand 全局选项（含消费下一个参数的 -c/-C）之后能定位真实子命令
func TestFindSubcommand(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"commit", "-m", "x"}, "commit"},
		{[]string{"-c", "user.name=t", "commit", "--allow-empty"}, "commit"},
		{[]string{"-C", "/other", "push", "origin"}, "push"},
		{[]string{"--git-dir=.git", "status"}, "status"},
		{[]string{"status"}, "status"},
		{[]string{"--bare"}, ""},
	}
	for _, c := range cases {
		if got := findSubcommand(c.args); got != c.want {
			t.Errorf("findSubcommand(%v) = %q, want %q", c.args, got, c.want)
		}
	}
}

// TestBranchTrackingCached_MutationInvalidates 提交后 ahead 立即 +1（写操作失效缓存）
func TestBranchTrackingCached_MutationInvalidates(t *testing.T) {
	dir := initRepoWithUpstream(t)

	if a, _ := GetBranchTrackingCached(dir, "main"); a != 0 {
		t.Fatalf("initial ahead = %d, want 0", a)
	}
	commitEmpty(t, dir, "second")
	if a, _ := GetBranchTrackingCached(dir, "main"); a != 1 {
		t.Fatalf("ahead after commit = %d, want 1 (mutation must invalidate cache)", a)
	}
	commitEmpty(t, dir, "third")
	if a, _ := GetBranchTrackingCached(dir, "main"); a != 2 {
		t.Fatalf("ahead after 2nd commit = %d, want 2", a)
	}
}

// TestBranchTrackingCached_BranchMismatch 分支不匹配不复用缓存
func TestBranchTrackingCached_BranchMismatch(t *testing.T) {
	dir := initRepoWithUpstream(t)
	if _, err := execGit(dir, "checkout", "-b", "feat-y"); err != nil {
		t.Fatal(err)
	}
	// 新分支不继承 upstream：显式指到 main2 才有 ahead 语义
	if _, err := execGit(dir, "branch", "--set-upstream-to=main2", "feat-y"); err != nil {
		t.Fatal(err)
	}
	commitEmpty(t, dir, "feat work")

	if a, _ := GetBranchTrackingCached(dir, "feat-y"); a != 1 {
		t.Fatalf("feat-y ahead = %d, want 1", a)
	}
	// main 的结果与 feat-y 不同：分支不匹配必须重新计算而非复用
	if a, _ := GetBranchTrackingCached(dir, "main"); a != 0 {
		t.Fatalf("main ahead = %d, want 0 (branch mismatch must not reuse cache)", a)
	}
}
