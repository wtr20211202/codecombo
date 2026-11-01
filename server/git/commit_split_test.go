package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// commitSplitFiles 读一个提交落库的文件清单（git show --name-only 去头去空）
func commitSplitFiles(t *testing.T, dir, ref string) []string {
	t.Helper()
	out, err := execGit(dir, "show", "--name-only", "--format=", ref)
	if err != nil {
		t.Fatalf("show %s: %v", ref, err)
	}
	var files []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			files = append(files, l)
		}
	}
	return files
}

func writeTestFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestExecuteCommitSplitGroupByGroup 干净分组全量执行：组序落库、每组恰好
// 含自己的文件、报告无失败
func TestExecuteCommitSplitGroupByGroup(t *testing.T) {
	dir := initTestRepo(t)
	writeTestFile(t, dir, "a.txt", "v3\n") // 修改已跟踪
	writeTestFile(t, dir, "b.txt", "new b\n")
	writeTestFile(t, dir, "c.txt", "new c\n")

	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{
		{Name: "功能", Files: []string{"a.txt", "b.txt"}, Subject: "feat: ui"},
		{Name: "配置", Files: []string{"c.txt"}, Subject: "chore: cfg"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if report.Total != 2 || len(report.Executed) != 2 || report.Failed != nil || report.Remaining != 0 {
		t.Fatalf("unexpected report: %+v", report)
	}
	if got := commitSubject(t, dir, "HEAD"); got != "chore: cfg" {
		t.Fatalf("HEAD subject = %q", got)
	}
	if got := commitSubject(t, dir, "HEAD~1"); got != "feat: ui" {
		t.Fatalf("HEAD~1 subject = %q", got)
	}
	if got := commitSplitFiles(t, dir, "HEAD"); len(got) != 1 || got[0] != "c.txt" {
		t.Fatalf("HEAD files = %v", got)
	}
	if got := commitSplitFiles(t, dir, "HEAD~1"); len(got) != 2 {
		t.Fatalf("HEAD~1 files = %v", got)
	}
	if report.Executed[0].Commit == "" || report.Executed[1].Commit == "" {
		t.Fatalf("short hashes missing: %+v", report.Executed)
	}
}

// TestExecuteCommitSplitPreStagedGroups P-186 真实形态：所有组文件**已暂存**
// ——pathspec 提交保证组间隔离（裸 git commit 提交整个 index 会把第二组卷进
// 首组，e2e 实测必踩），每组恰好落库自己的文件
func TestExecuteCommitSplitPreStagedGroups(t *testing.T) {
	dir := initTestRepo(t)
	writeTestFile(t, dir, "a.txt", "v3\n")
	writeTestFile(t, dir, "b.txt", "new b\n")
	if out, err := execGit(dir, "add", "a.txt", "b.txt"); err != nil {
		t.Fatalf("prestage: %v (%s)", err, out)
	}

	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{
		{Files: []string{"a.txt"}, Subject: "feat: alpha"},
		{Files: []string{"b.txt"}, Subject: "docs: beta"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(report.Executed) != 2 || report.Failed != nil {
		t.Fatalf("unexpected report: %+v", report)
	}
	if got := commitSplitFiles(t, dir, "HEAD"); len(got) != 1 || got[0] != "b.txt" {
		t.Fatalf("HEAD files = %v", got)
	}
	if got := commitSplitFiles(t, dir, "HEAD~1"); len(got) != 1 || got[0] != "a.txt" {
		t.Fatalf("HEAD~1 files = %v", got)
	}
}

// TestExecuteCommitSplitLeavesForeignStaged 分组外已暂存文件不卷入任何组、
// 保持暂存态（pathspec 提交不触碰组外 index 内容）
func TestExecuteCommitSplitLeavesForeignStaged(t *testing.T) {
	dir := initTestRepo(t)
	writeTestFile(t, dir, "a.txt", "v3\n")
	writeTestFile(t, dir, "stray.txt", "not in any group\n")
	if out, err := execGit(dir, "add", "a.txt", "stray.txt"); err != nil {
		t.Fatalf("stage: %v (%s)", err, out)
	}

	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{
		{Files: []string{"a.txt"}, Subject: "g1"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(report.Executed) != 1 || report.Failed != nil {
		t.Fatalf("unexpected report: %+v", report)
	}
	if got := commitSplitFiles(t, dir, "HEAD"); len(got) != 1 || got[0] != "a.txt" {
		t.Fatalf("HEAD files = %v", got)
	}
	// stray 仍暂存未提交
	out, err := execGit(dir, "status", "--porcelain", "stray.txt")
	if err != nil || !strings.HasPrefix(out, "A ") {
		t.Fatalf("stray should remain staged, got %q (%v)", out, err)
	}
}

// TestExecuteCommitSplitInterruptsOnFailure 组级 stage 失败即中断：已完成组
// 保留，失败组与剩余数如实上报
func TestExecuteCommitSplitInterruptsOnFailure(t *testing.T) {
	dir := initTestRepo(t)
	writeTestFile(t, dir, "a.txt", "v3\n")
	writeTestFile(t, dir, "b.txt", "new b\n")

	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{
		{Files: []string{"a.txt"}, Subject: "g1: ok"},
		{Files: []string{"missing.txt"}, Subject: "g2: broken"},
		{Files: []string{"b.txt"}, Subject: "g3: skipped"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(report.Executed) != 1 || report.Executed[0].Subject != "g1: ok" {
		t.Fatalf("executed = %+v", report.Executed)
	}
	if report.Failed == nil || report.Failed.Index != 1 || report.Failed.Step != "stage" {
		t.Fatalf("failed = %+v", report.Failed)
	}
	if report.Failed.Error == "" {
		t.Fatal("failure error text is empty")
	}
	if report.Remaining != 1 || report.Total != 3 {
		t.Fatalf("remaining/total = %d/%d", report.Remaining, report.Total)
	}
	if got := commitSubject(t, dir, "HEAD"); got != "g1: ok" {
		t.Fatalf("HEAD subject = %q", got)
	}
	// 中断后剩余组文件不被动到（b.txt 仍未跟踪）
	out, err := execGit(dir, "status", "--porcelain", "b.txt")
	if err != nil || !strings.HasPrefix(out, "??") {
		t.Fatalf("b.txt should remain untracked, got %q (%v)", out, err)
	}
}

// TestExecuteCommitSplitCommitStepFailure 重复文件组：该组相对 HEAD 无差异，
// pathspec 提交失败同样中断上报
func TestExecuteCommitSplitCommitStepFailure(t *testing.T) {
	dir := initTestRepo(t)
	writeTestFile(t, dir, "a.txt", "v3\n")

	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{
		{Files: []string{"a.txt"}, Subject: "g1: ok"},
		{Files: []string{"a.txt"}, Subject: "g2: dup"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(report.Executed) != 1 {
		t.Fatalf("executed = %+v", report.Executed)
	}
	if report.Failed == nil || report.Failed.Index != 1 || report.Failed.Step != "commit" {
		t.Fatalf("failed = %+v", report.Failed)
	}
}

// TestExecuteCommitSplitValidation 请求级畸形走 error（handler 映射 400），
// 不产出报告
func TestExecuteCommitSplitValidation(t *testing.T) {
	dir := initTestRepo(t)
	cases := []struct {
		name   string
		groups []CommitSplitGroup
	}{
		{"empty groups", nil},
		{"empty subject", []CommitSplitGroup{{Files: []string{"a.txt"}}}},
		{"empty files", []CommitSplitGroup{{Subject: "s"}}},
		{"blank file entry", []CommitSplitGroup{{Files: []string{"  "}, Subject: "s"}}},
	}
	for _, tc := range cases {
		if _, err := ExecuteCommitSplit(dir, tc.groups); err == nil {
			t.Fatalf("%s: expected error", tc.name)
		}
	}
	many := make([]CommitSplitGroup, CommitSplitMaxGroups+1)
	for i := range many {
		many[i] = CommitSplitGroup{Files: []string{"a.txt"}, Subject: "s"}
	}
	if _, err := ExecuteCommitSplit(dir, many); err == nil {
		t.Fatal("too many groups: expected error")
	}

	// 组名缺省合法（展示面退化用主题）：规整后正常执行
	writeTestFile(t, dir, "a.txt", "v3\n")
	report, err := ExecuteCommitSplit(dir, []CommitSplitGroup{{Files: []string{"a.txt"}, Subject: "s1"}})
	if err != nil || len(report.Executed) != 1 {
		t.Fatalf("unnamed group should pass: %v %+v", err, report)
	}
}
