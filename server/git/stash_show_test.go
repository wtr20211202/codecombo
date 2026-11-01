package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/model"
)

// stashShowFixture 构造带两条 stash 的仓库（分支名跟随 init 默认，不预设 main/master）：
//
//	base 提交 tracked.txt=v0 后：
//	  stash①（先入栈，旧）：tracked.txt → "older"
//	  stash②（后入栈，新）：tracked.txt → "newer" + untracked.txt 未跟踪新文件
func stashShowFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q")
	// 本机全局 autocrlf 会污染 diff 内容稳定性，仓库级显式关闭
	must("config", "core.autocrlf", "false")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	write("tracked.txt", "v0\n")
	must("add", ".")
	must("commit", "-q", "-m", "base")

	write("tracked.txt", "older\n")
	if _, err := Stash(repo, model.StashRequest{Message: "older stash"}); err != nil {
		t.Fatalf("stash older: %v", err)
	}

	write("tracked.txt", "newer\n")
	write("untracked.txt", "brand new\n")
	if _, err := Stash(repo, model.StashRequest{Message: "newer stash", IncludeUntracked: true}); err != nil {
		t.Fatalf("stash newer: %v", err)
	}
	return repo
}

// TestStashShow_IndexMatchesListOrder：index 与 GetStashes 列表顺序一一对应——
// stash@{0} 恒为最新入栈条目（P-20261002-89 index 语义核实：列表第 i 行的 index
// 查出来的必须是该行自己的内容，而非栈里任意一条）
func TestStashShow_IndexMatchesListOrder(t *testing.T) {
	repo := stashShowFixture(t)

	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	if len(stashes) != 2 {
		t.Fatalf("len(stashes) = %d, want 2", len(stashes))
	}
	if stashes[0].Index != 0 || stashes[1].Index != 1 {
		t.Fatalf("indices = %d,%d, want 0,1", stashes[0].Index, stashes[1].Index)
	}
	if !strings.Contains(stashes[0].Message, "newer stash") || !strings.Contains(stashes[1].Message, "older stash") {
		t.Fatalf("list order broken: %q / %q", stashes[0].Message, stashes[1].Message)
	}

	diff0, err := StashShow(repo, 0)
	if err != nil {
		t.Fatalf("StashShow(0): %v", err)
	}
	if !strings.Contains(diff0, "newer") {
		t.Fatalf("stash@{0} diff should contain newer change, got: %s", diff0)
	}
	diff1, err := StashShow(repo, 1)
	if err != nil {
		t.Fatalf("StashShow(1): %v", err)
	}
	if !strings.Contains(diff1, "older") {
		t.Fatalf("stash@{1} diff should contain older change, got: %s", diff1)
	}
	// 列表行内容与该 index 的 diff 严格对应：0 号不含 older、1 号不含 newer
	if strings.Contains(diff0, "older") || strings.Contains(diff1, "newer") {
		t.Fatal("index and list order diverged")
	}
}

// TestStashShow_IncludesUntracked：--include-untracked 生效——未跟踪文件以
// new file diff 形式出现在 stash 内容里（stash 时间舱最有价值的正是这部分）
func TestStashShow_IncludesUntracked(t *testing.T) {
	repo := stashShowFixture(t)

	diff, err := StashShow(repo, 0)
	if err != nil {
		t.Fatalf("StashShow: %v", err)
	}
	if !strings.Contains(diff, "untracked.txt") {
		t.Fatalf("untracked file missing from diff: %s", diff)
	}
	if !strings.Contains(diff, "brand new") {
		t.Fatalf("untracked content missing from diff: %s", diff)
	}
	if !strings.Contains(diff, "newer") {
		t.Fatalf("tracked change missing from diff: %s", diff)
	}
}

// TestStashShow_Truncated：超大 stash 内容走既有 diff 截文约定——输出有界且带标记
func TestStashShow_Truncated(t *testing.T) {
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q")
	must("config", "core.autocrlf", "false")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("v0\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	must("add", ".")
	must("commit", "-q", "-m", "base")

	// 4096 行 × 40 字节 ≈ 160KB，远超测试用截文阈值
	var big strings.Builder
	for i := 0; i < 4096; i++ {
		big.WriteString("0123456789012345678901234567890123456789\n")
	}
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte(big.String()), 0o644); err != nil {
		t.Fatalf("write big: %v", err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: "big stash"}); err != nil {
		t.Fatalf("stash: %v", err)
	}

	old := MaxDiffOutput
	MaxDiffOutput = 512
	defer func() { MaxDiffOutput = old }()

	diff, err := StashShow(repo, 0)
	if err != nil {
		t.Fatalf("StashShow: %v", err)
	}
	if len(diff) > 512+128 {
		t.Fatalf("truncated output too large: %d", len(diff))
	}
	if !strings.Contains(diff, "[diff truncated") {
		t.Fatal("truncation marker missing")
	}
}

// TestStashShow_InvalidIndex：负 index 无对应 stash@{N}，必须报错而非静默查 stash@{0}
func TestStashShow_InvalidIndex(t *testing.T) {
	repo := stashShowFixture(t)
	if _, err := StashShow(repo, -1); err == nil {
		t.Fatal("negative index should error")
	}
}
