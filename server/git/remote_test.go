package git

import (
	"strings"
	"testing"
)

// initRepo 建一个带初始提交的临时仓库（commit 需要 user 配置，用 -c 注入）
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if _, err := execGit(dir, "init", "-b", "main"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	if _, err := execGit(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"); err != nil {
		t.Fatalf("git commit: %v", err)
	}
	return dir
}

// TestResolvePushTarget_UpstreamRemoteFirst remote 缺省时优先用该分支 upstream 的 remote
func TestResolvePushTarget_UpstreamRemoteFirst(t *testing.T) {
	dir := initRepo(t)
	if _, err := execGit(dir, "remote", "add", "gitlab", "https://example.com/x.git"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "remote", "add", "origin", "https://example.com/y.git"); err != nil {
		t.Fatal(err)
	}
	// upstream 指向 gitlab/main：解析必须选中 gitlab 而非优先级更高的 origin
	if _, err := execGit(dir, "branch", "--set-upstream-to=gitlab/main", "main"); err != nil {
		t.Skipf("no local ref gitlab/main, use fetch refspec alternative: %v", err)
	}
	remote, branch, err := resolvePushTarget(dir, "", "")
	if err != nil {
		t.Fatalf("resolvePushTarget: %v", err)
	}
	if remote != "gitlab" {
		t.Fatalf("remote = %q, want gitlab (upstream remote wins)", remote)
	}
	if branch != "main" {
		t.Fatalf("branch = %q, want main", branch)
	}
}

// TestResolvePushTarget_OriginPreferred 无 upstream 时优先 origin
func TestResolvePushTarget_OriginPreferred(t *testing.T) {
	dir := initRepo(t)
	if _, err := execGit(dir, "remote", "add", "gitlab", "https://example.com/x.git"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "remote", "add", "origin", "https://example.com/y.git"); err != nil {
		t.Fatal(err)
	}
	remote, _, err := resolvePushTarget(dir, "", "main")
	if err != nil {
		t.Fatalf("resolvePushTarget: %v", err)
	}
	if remote != "origin" {
		t.Fatalf("remote = %q, want origin", remote)
	}
}

// TestResolvePushTarget_SoleRemote 无 origin 时取唯一 remote
func TestResolvePushTarget_SoleRemote(t *testing.T) {
	dir := initRepo(t)
	if _, err := execGit(dir, "remote", "add", "gitee", "https://example.com/z.git"); err != nil {
		t.Fatal(err)
	}
	remote, _, err := resolvePushTarget(dir, "", "main")
	if err != nil {
		t.Fatalf("resolvePushTarget: %v", err)
	}
	if remote != "gitee" {
		t.Fatalf("remote = %q, want gitee", remote)
	}
}

// TestResolvePushTarget_NoRemote 无任何 remote 时报错（此前裸 push 语义不清）
func TestResolvePushTarget_NoRemote(t *testing.T) {
	dir := initRepo(t)
	_, _, err := resolvePushTarget(dir, "", "main")
	if err == nil || !strings.Contains(err.Error(), "no remote") {
		t.Fatalf("err = %v, want 'no remote configured'", err)
	}
}

// TestResolvePushTarget_BranchDefaulted branch 缺省时取当前分支
func TestResolvePushTarget_BranchDefaulted(t *testing.T) {
	dir := initRepo(t)
	if _, err := execGit(dir, "remote", "add", "origin", "https://example.com/y.git"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "checkout", "-b", "feat-x"); err != nil {
		t.Fatal(err)
	}
	remote, branch, err := resolvePushTarget(dir, "origin", "")
	if err != nil {
		t.Fatalf("resolvePushTarget: %v", err)
	}
	if remote != "origin" || branch != "feat-x" {
		t.Fatalf("got (%q, %q), want (origin, feat-x)", remote, branch)
	}
}
