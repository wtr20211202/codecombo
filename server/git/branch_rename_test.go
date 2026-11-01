package git

import (
	"strings"
	"testing"
)

// TestRenameBranch_PreservesUpstream 重命名保留 upstream 跟踪（P-20261003-221
// 的核心语义验证）：`git branch -m` 会把 branch.<old> 配置段整体迁移为
// branch.<new>（remote/merge 原样保留），跟踪关系与 ahead/behind 不丢——
// 这正是「重命名」相对「删除重建」（丢 upstream 配置）的语义优势
func TestRenameBranch_PreservesUpstream(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	runGit(t, work, "checkout", "-b", "feat/x")
	runGit(t, work, "branch", "--set-upstream-to=origin/main", "feat/x")

	if err := RenameBranch(work, "feat/x", "feat/y"); err != nil {
		t.Fatalf("RenameBranch: %v", err)
	}

	branches, err := GetBranches(work)
	if err != nil {
		t.Fatalf("GetBranches: %v", err)
	}
	var renamed *struct {
		name     string
		upstream string
		ahead    int
	}
	for i := range branches {
		b := branches[i]
		if b.Name == "feat/x" {
			t.Fatalf("old branch %q still listed after rename", b.Name)
		}
		if b.Name == "feat/y" {
			renamed = &struct {
				name     string
				upstream string
				ahead    int
			}{b.Name, b.Upstream, b.Ahead}
		}
	}
	if renamed == nil {
		t.Fatalf("renamed branch feat/y not in list: %+v", branches)
	}
	if renamed.upstream != "origin/main" {
		t.Fatalf("upstream after rename = %q, want origin/main (tracking must be preserved)", renamed.upstream)
	}
	// 跟踪信息可用（ahead/behind 照常解析）：main 领先 feat/y 0 个本地提交、
	// 双方同源——ahead 为 0 即表示 upstream 读取链路完好
	if renamed.ahead != 0 {
		t.Fatalf("ahead after rename = %d, want 0", renamed.ahead)
	}
	// 旧配置段确已迁移（git branch -m 的语义：move 而非残留）
	if _, err := execGit(work, "config", "--get", "branch.feat/x.remote"); err == nil {
		t.Fatalf("branch.feat/x config section should have been moved away")
	}
}

// TestRenameBranch_CurrentBranchFollowsHEAD 重命名当前分支：HEAD 符号引用随
// git branch -m 更新，分支列表中当前标记落到新名（detached 不会出现）
func TestRenameBranch_CurrentBranchFollowsHEAD(t *testing.T) {
	work, _ := setupUpstreamRepo(t) // setupUpstreamRepo 留 HEAD 在 main

	if err := RenameBranch(work, "main", "trunk"); err != nil {
		t.Fatalf("RenameBranch current: %v", err)
	}

	branches, err := GetBranches(work)
	if err != nil {
		t.Fatalf("GetBranches: %v", err)
	}
	var current string
	for _, b := range branches {
		if b.Name == "main" {
			t.Fatalf("old branch %q still listed after rename", b.Name)
		}
		if b.IsCurrent {
			current = b.Name
		}
	}
	if current != "trunk" {
		t.Fatalf("current branch after rename = %q, want trunk", current)
	}
}

// TestRenameBranch_RejectsOptionLikeNames 引用名校验兜底（A6）：old/new 以
// "-" 开头一律拒绝，不落为 git 选项注入
func TestRenameBranch_RejectsOptionLikeNames(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	if err := RenameBranch(work, "main", "-evil"); err == nil || !strings.Contains(err.Error(), "must not start with '-'") {
		t.Fatalf("RenameBranch(main, -evil) err = %v, want option-injection rejection", err)
	}
	if err := RenameBranch(work, "--exec", "ok"); err == nil || !strings.Contains(err.Error(), "must not start with '-'") {
		t.Fatalf("RenameBranch(--exec, ok) err = %v, want option-injection rejection", err)
	}
}
