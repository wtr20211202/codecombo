package git

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// commitAt 定时提交：显式钉住作者/提交时间——对称差 `A...B` 两侧按提交时间排序，
// 同秒提交的相对序不保证跨平台稳定（Windows/Linux git 实现差异），夹具必须
// 时间可数才能对「最新在前」作精确断言
func commitAt(t *testing.T, dir, msg, date string) {
	t.Helper()
	cmd := exec.Command("git", "-C", dir, "commit", "--allow-empty", "-m", msg)
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("commit %s: %v: %s", msg, err, out)
	}
}

// switchBranch 切换分支（失败即 fatal）
func switchBranch(t *testing.T, dir, branch string) {
	t.Helper()
	runGit(t, dir, "switch", branch)
}

// setupCompareRepo 建分叉双分支夹具（P-20261003-233）：
//
//	c1 (base, 01:00)──c2 main 侧 (04:00)
//	   └──f1 (02:00)──f2 feature 侧 (03:00)
func setupCompareRepo(t *testing.T) string {
	t.Helper()
	work := filepath.Join(t.TempDir(), "repo")
	runGit(t, "", "init", "-b", "main", work)
	runGit(t, work, "config", "user.email", "t@t")
	runGit(t, work, "config", "user.name", "t")
	if err := writeFile(work+"/a.txt", "one\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "add", "-A")
	// 首提交走 commitAt 钉时间（runGit 无 env 注入口）
	commitAt(t, work, "c1: base", "2026-01-01T01:00:00 +0000")
	runGit(t, work, "branch", "feature")
	commitAt(t, work, "c2: main side", "2026-01-01T04:00:00 +0000")
	switchBranch(t, work, "feature")
	commitAt(t, work, "f1: feature one", "2026-01-01T02:00:00 +0000")
	commitAt(t, work, "f2: feature two", "2026-01-01T03:00:00 +0000")
	switchBranch(t, work, "main")
	return work
}

// GetCompareLog（P-20261003-233 分支比较「仅独有提交」过滤）：
//   - uniqueOnly=true → from..to 单向（仅 to 独有，待合入审阅聚焦）
//   - uniqueOnly=false → from...to 对称差（双向全量）
//   - 基线缺失（from 不可解析）→ 降级 to 全量历史 + noBase 标志而非错误
//   - to 不可解析 → 硬错误（对比本身不可能）
//   - limit 截取最新 N 条；from 空 = HEAD 缺省
func TestGetCompareLog(t *testing.T) {
	work := setupCompareRepo(t)

	// 单向：main..feature 仅 feature 侧独有（f2/f1），不含 main 侧 c2 与共同祖先 c1
	commits, noBase, err := GetCompareLog(work, "main", "feature", true, 100)
	if err != nil || noBase {
		t.Fatalf("unique: err=%v noBase=%v", err, noBase)
	}
	wantUnique := []string{"f2: feature two", "f1: feature one"}
	if len(commits) != len(wantUnique) {
		t.Fatalf("unique: want %d commits, got %d: %v", len(wantUnique), len(commits), commits)
	}
	for i, want := range wantUnique {
		if commits[i].Message != want {
			t.Errorf("unique[%d] = %q, want %q (newest first)", i, commits[i].Message, want)
		}
	}

	// 双向全量：main...feature 对称差 = 两侧独有（c2/f2/f1），不含共同祖先 c1，
	// 按提交时间最新在前（c2 04:00 > f2 03:00 > f1 02:00，时间已钉死）
	commits, noBase, err = GetCompareLog(work, "main", "feature", false, 100)
	if err != nil || noBase {
		t.Fatalf("symmetric: err=%v noBase=%v", err, noBase)
	}
	wantSym := []string{"c2: main side", "f2: feature two", "f1: feature one"}
	if len(commits) != len(wantSym) {
		t.Fatalf("symmetric: want %d commits, got %d: %v", len(wantSym), len(commits), commits)
	}
	for i, want := range wantSym {
		if commits[i].Message != want {
			t.Errorf("symmetric[%d] = %q, want %q", i, commits[i].Message, want)
		}
	}

	// from 空 = HEAD 缺省（HEAD 在 main，语义同 "main"）
	commits, _, err = GetCompareLog(work, "", "feature", true, 100)
	if err != nil {
		t.Fatalf("head default: err=%v", err)
	}
	if len(commits) != 2 || commits[0].Message != "f2: feature two" {
		t.Fatalf("head default: want f2/f1, got %v", commits)
	}

	// 基线缺失：from 不可解析 → 降级 to 全量历史（c1+f1+f2）+ noBase 标志而非错误
	commits, noBase, err = GetCompareLog(work, "no-such-branch", "feature", true, 100)
	if err != nil {
		t.Fatalf("no-base: err=%v", err)
	}
	if !noBase {
		t.Fatalf("no-base: want noBase=true")
	}
	if len(commits) != 3 || commits[0].Message != "f2: feature two" || commits[2].Message != "c1: base" {
		t.Fatalf("no-base: want full history f2/f1/c1, got %v", commits)
	}

	// to 不可解析：硬错误（noBase 不成立）
	_, noBase, err = GetCompareLog(work, "main", "bogus-ref", true, 100)
	if err == nil {
		t.Fatalf("bad to: want error, got nil")
	}
	if noBase {
		t.Fatalf("bad to: want noBase=false")
	}

	// limit 截取最新 N 条
	commits, _, err = GetCompareLog(work, "main", "feature", false, 2)
	if err != nil {
		t.Fatalf("limit: err=%v", err)
	}
	if len(commits) != 2 || commits[0].Message != "c2: main side" || commits[1].Message != "f2: feature two" {
		t.Fatalf("limit: want 2 newest, got %v", commits)
	}
}
