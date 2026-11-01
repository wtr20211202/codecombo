package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mergeRepoFixture 构造带 merge 提交的仓库（分支名跟随 init 默认，不预设 main/master）：
//
//	A --- C (默认分支)
//	 \   /
//	  B (feature)
//
//	M = merge --no-ff B（第一父为 C）
func mergeRepoFixture(t *testing.T) string {
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
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	write("base.txt", "a\n")
	must("add", ".")
	must("commit", "-q", "-m", "A: base")
	mainBranch := strings.TrimSpace(must("rev-parse", "--abbrev-ref", "HEAD"))

	must("checkout", "-q", "-b", "feature")
	write("feature.txt", "f\n")
	must("add", ".")
	must("commit", "-q", "-m", "B: feature")

	must("checkout", "-q", mainBranch)
	write("main.txt", "m\n")
	must("add", ".")
	must("commit", "-q", "-m", "C: main")

	must("merge", "--no-ff", "-q", "-m", "M: merge feature", "feature")
	return repo
}

// findCommit 按主题首行前缀取提交（fixture 内提交消息唯一）
func findCommit(t *testing.T, repo, subjectPrefix string) (hash string, parents int) {
	t.Helper()
	logs, err := GetLog(repo, "", 20, 0, "", "", "")
	if err != nil {
		t.Fatalf("GetLog: %v", err)
	}
	for _, c := range logs {
		if strings.HasPrefix(c.Message, subjectPrefix) {
			return c.Hash, len(c.Parents)
		}
	}
	t.Fatalf("未找到主题为 %q 的提交", subjectPrefix)
	return "", 0
}

// TestGetCommitFiles_MergeShowsFirstParentDiff：merge 提交此前经 diff-tree 默认
// 无输出（组合差异为空），提交面板显示零变更文件——必须与第一父对比
func TestGetCommitFiles_MergeShowsFirstParentDiff(t *testing.T) {
	repo := mergeRepoFixture(t)

	mergeSha, nParents := findCommit(t, repo, "M:")
	if nParents < 2 {
		t.Fatalf("fixture 失败：M 非合并提交 parents=%d", nParents)
	}

	files, err := GetCommitFiles(repo, mergeSha)
	if err != nil {
		t.Fatalf("GetCommitFiles(merge): %v", err)
	}
	paths := map[string]bool{}
	for _, f := range files {
		paths[f.Path] = true
	}
	// 与第一父对比：merge 相对 C 引入的内容 = feature.txt；
	// main.txt 在第一父 C 已存在，不属于 merge 的变更
	if !paths["feature.txt"] {
		t.Errorf("merge diff 缺被合入侧文件 feature.txt，got %v", files)
	}
	if paths["main.txt"] {
		t.Errorf("merge diff 不应含第一父已存在的 main.txt（那不是 merge 引入的变更），got %v", files)
	}
}

// TestGetCommitDiff_MergeNonEmpty：merge 的补丁/单文件补丁/AI 解释补丁均非空
func TestGetCommitDiff_MergeNonEmpty(t *testing.T) {
	repo := mergeRepoFixture(t)
	mergeSha, nParents := findCommit(t, repo, "M:")
	if nParents < 2 {
		t.Fatalf("fixture 失败：M 非合并提交 parents=%d", nParents)
	}

	patch, err := GetCommitDiff(repo, mergeSha)
	if err != nil {
		t.Fatalf("GetCommitDiff(merge): %v", err)
	}
	if !strings.Contains(patch, "diff --git") {
		t.Errorf("merge 提交补丁为空（组合差异语义未修复）: %q", patch)
	}

	filePatch, err := GetCommitFileDiff(repo, mergeSha, "feature.txt")
	if err != nil {
		t.Fatalf("GetCommitFileDiff(merge): %v", err)
	}
	if !strings.Contains(filePatch, "feature.txt") {
		t.Errorf("merge 单文件补丁缺 feature.txt: %q", filePatch)
	}

	aiPatch, err := GetCommitPatch(repo, mergeSha)
	if err != nil {
		t.Fatalf("GetCommitPatch(merge): %v", err)
	}
	if !strings.Contains(aiPatch, "feature.txt") {
		t.Errorf("AI 提交解释补丁缺 feature.txt: %q", aiPatch)
	}
}

// TestGetCommitFiles_RootAndNormal：根提交（--root）与普通提交行为不回归
func TestGetCommitFiles_RootAndNormal(t *testing.T) {
	repo := mergeRepoFixture(t)

	rootSha, _ := findCommit(t, repo, "A:")
	featSha, _ := findCommit(t, repo, "B:")

	rootFiles, err := GetCommitFiles(repo, rootSha)
	if err != nil {
		t.Fatalf("GetCommitFiles(root): %v", err)
	}
	if len(rootFiles) == 0 || rootFiles[0].Path != "base.txt" {
		t.Errorf("根提交应含 base.txt（--root 语义），got %v", rootFiles)
	}

	featFiles, err := GetCommitFiles(repo, featSha)
	if err != nil {
		t.Fatalf("GetCommitFiles(feat): %v", err)
	}
	if len(featFiles) == 0 || featFiles[0].Path != "feature.txt" {
		t.Errorf("普通提交应含 feature.txt，got %v", featFiles)
	}
}
