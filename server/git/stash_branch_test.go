package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/model"
)

// stashBranchFixture 构造「有 stash 待实验」场景（P-20261003-263 公共底座）：
//
//	base 提交：f.txt="base"（分支 master）
//	工作区：f.txt 追加一行（未暂存修改）
//	已入栈：该修改 stash@{0}，工作区回到干净
func stashBranchFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q", "-b", "master")
	// 本机全局 autocrlf 会污染内容稳定性，仓库级显式关闭
	must("config", "core.autocrlf", "false")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatalf("write f.txt: %v", err)
	}
	must("add", ".")
	must("commit", "-q", "-m", "base")

	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("base\nwip edit\n"), 0o644); err != nil {
		t.Fatalf("write f.txt: %v", err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: "wip: try on branch"}); err != nil {
		t.Fatalf("Stash: %v", err)
	}
	assertStashCount(t, repo, 1)
	return repo
}

// gitCurrentBranch 当前分支名（rev-parse --abbrev-ref HEAD）
func gitCurrentBranch(t *testing.T, repo string) string {
	t.Helper()
	out, err := execGit(repo, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		t.Fatalf("rev-parse --abbrev-ref HEAD: %v", err)
	}
	return strings.TrimSpace(out)
}

// gitRev 解析引用指向的提交（不存在/不可解析时 Fatal）
func gitRev(t *testing.T, repo, ref string) string {
	t.Helper()
	out, err := execGit(repo, "rev-parse", ref)
	if err != nil {
		t.Fatalf("rev-parse %s: %v", ref, err)
	}
	return strings.TrimSpace(out)
}

// TestStashBranchApplyToNewBranch 链路语义（P-20261003-263）：
// 应用到新分支 = checkout -b（基于 stash 原基线）+ apply 原子链——成功后新分支
// 被检出且工作区含 stash 内容（未提交），原分支指针不动，stash 条目按 git
// 语义移除
func TestStashBranchApplyToNewBranch(t *testing.T) {
	repo := stashBranchFixture(t)
	baseSha := gitRev(t, repo, "master")

	if _, err := StashBranch(repo, "trial", 0); err != nil {
		t.Fatalf("StashBranch: %v", err)
	}

	// 新分支被检出，且基于 stash 原基线（= master 原提交）
	if got := gitCurrentBranch(t, repo); got != "trial" {
		t.Fatalf("current branch = %q, want trial", got)
	}
	if got := gitRev(t, repo, "trial"); got != baseSha {
		t.Fatalf("trial points at %s, want stash base %s", got, baseSha)
	}
	// stash 内容落在新分支工作区（未提交，供实验/继续加工）
	got, err := os.ReadFile(filepath.Join(repo, "f.txt"))
	if err != nil || string(got) != "base\nwip edit\n" {
		t.Fatalf("f.txt = %q (err %v), want stashed content applied", got, err)
	}
	st, err := execGit(repo, "status", "--porcelain")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st, " M f.txt") {
		t.Fatalf("status = %q, want unstaged f.txt on trial", st)
	}
	// 原分支不动（「不污染当前工作区」）
	if got := gitRev(t, repo, "master"); got != baseSha {
		t.Fatalf("master moved to %s, want unchanged %s", got, baseSha)
	}
	// stash 条目按 git stash branch 语义移除（内容已在新分支工作区）
	assertStashCount(t, repo, 0)
}

// TestStashBranchConflictRejects 分支名冲突拒绝（提案②）：目标分支已存在时
// 预检拒绝（稳定原文 "already exists" 供前端 KNOWN_ERROR_I18N 映射），零副作用
// ——不切分支、不动 stash、不动工作区
func TestStashBranchConflictRejects(t *testing.T) {
	repo := stashBranchFixture(t)
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("branch", "existing")
	stashCountBefore := func() int {
		stashes, err := GetStashes(repo)
		if err != nil {
			t.Fatalf("GetStashes: %v", err)
		}
		return len(stashes)
	}
	before := stashCountBefore()

	_, err := StashBranch(repo, "existing", 0)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v, want stable 'already exists' marker for KNOWN_ERROR_I18N", err)
	}
	// 拒绝即零副作用：HEAD 未动、stash 原样、工作区干净
	if got := gitCurrentBranch(t, repo); got != "master" {
		t.Fatalf("current branch = %q, want master (reject must not switch)", got)
	}
	if got := stashCountBefore(); got != before {
		t.Fatalf("stash count = %d, want unchanged %d", got, before)
	}
	if st, err := execGit(repo, "status", "--porcelain"); err != nil || st != "" {
		t.Fatalf("status = %q (err %v), want clean worktree preserved", st, err)
	}
}

// TestStashBranchInvalidRef 选项形注入防御：以 "-" 开头的分支名被 refcheck
// 拒绝（与 CreateBranch/Checkout 同一道 validateRef），stash 零副作用
func TestStashBranchInvalidRef(t *testing.T) {
	repo := stashBranchFixture(t)
	if _, err := StashBranch(repo, "-D", 0); err == nil {
		t.Fatal("option-like branch name should be rejected by validateRef")
	}
	assertStashCount(t, repo, 1)
}
