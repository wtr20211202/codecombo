package git

import (
	"os/exec"
	"path/filepath"
	"testing"

	"codecombo/server/model"
)

// setupMergedRepo 建临时仓库：master 基线 + 已合并分支 feat-merged（多一个提交后
// 合回 master）+ 未合并分支 feat-kept（提交留在分支上）。
// 验证 GetBranches 的 isMerged 数据源（P-20261003-50）：`branch -vv` 从不输出
// "(merged)" 标记，合并态必须由 `branch -a --merged` 集合标注。
func setupMergedRepo(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "repo")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(cmd.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	// init 不能带 -C（目标目录尚不存在），与 branch_tracking_batch_test.go 同款
	if out, err := exec.Command("git", "init", "-b", "master", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	if err := writeFile(filepath.Join(dir, "a.txt"), "one\n"); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "c1")

	// 已合并分支：独立提交后合回 master
	run("branch", "feat-merged")
	run("checkout", "feat-merged")
	if err := writeFile(filepath.Join(dir, "m.txt"), "merged\n"); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "feat merged")
	run("checkout", "master")
	run("merge", "feat-merged")

	// 未合并分支：提交留在分支上
	run("branch", "feat-kept")
	run("checkout", "feat-kept")
	if err := writeFile(filepath.Join(dir, "k.txt"), "kept\n"); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "feat kept")
	run("checkout", "master")
	return dir
}

func mergedByName(branches []model.Branch) map[string]bool {
	set := make(map[string]bool, len(branches))
	for _, b := range branches {
		set[b.Name] = b.IsMerged
	}
	return set
}

func TestGetBranchesMergedFlag(t *testing.T) {
	dir := setupMergedRepo(t)

	branches, err := GetBranches(dir)
	if err != nil {
		t.Fatalf("GetBranches: %v", err)
	}
	flags := mergedByName(branches)

	if !flags["feat-merged"] {
		t.Errorf("feat-merged 已合回 master，isMerged 应为 true")
	}
	if flags["feat-kept"] {
		t.Errorf("feat-kept 有未合并提交，isMerged 应为 false")
	}
	if flags["master"] {
		t.Errorf("master 是当前分支（HEAD 自身），isMerged 应为 false")
	}
}
