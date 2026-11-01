package git

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"

	"codecombo/server/model"
)

// StageHunk/UnstageHunk 单测（P-20261004-24）：与 diff_discard_test.go 同构
// fixture（复用 newDiscardFixture——alpha/omega 两处远距改动恰好两个独立
// hunk）。修复点 = parseHunks 以「下一行前补换行」拼接内容，非末位 hunk
// 尾无换行，旧拼头直交 git apply 报 corrupt patch；补尾收口进
// buildSingleHunkPatch（Stage/Unstage/discard 三处共用）后整链打通

// hunkGitOut 在 fixture 仓库执行只读 git 查询并返回 stdout（测试断言面）
func hunkGitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

// wantTwoHunks 取目标文件的 hunk 表并锁死两块前提（fixture 锚定：块数漂移
// 会让「非末位/末位」语义失真，宁 fail 不误测）
func wantTwoHunks(t *testing.T, f *discardFixture, staged bool) []model.DiffHunk {
	t.Helper()
	hunks, err := GetFileHunks(f.path, f.file, staged)
	if err != nil {
		t.Fatal(err)
	}
	if len(hunks) != 2 {
		t.Fatalf("hunks = %d, want 2（alpha/omega 各一块）", len(hunks))
	}
	return hunks
}

// TestStageHunk_NonFinalHunkStages 非末位 hunk（修复前必 corrupt）暂存成功：
// 先锚定无尾换行补丁确实被 git apply 拒绝，再走 StageHunk 全链验证 alpha 段
// 入暂存、omega 段留工作区
func TestStageHunk_NonFinalHunkStages(t *testing.T) {
	f := newDiscardFixture(t)
	hunks := wantTwoHunks(t, f, false)

	// 修复前形态对照：非末位块内容尾无换行，旧拼头对 git apply --cached
	// 必报 corrupt patch。--check 只校验不落索引，零副作用。若此断言翻红
	// 说明 fixture 失去锚定力（hunk 结构或 git 行为变化），须复查本组用例
	if strings.HasSuffix(hunks[0].Content, "\n") {
		t.Fatalf("fixture 失效：块 0 应为非末位（尾无换行），got %q", hunks[0].Content)
	}
	broken := fmt.Sprintf("--- a/%s\n+++ b/%s\n%s", f.file, f.file, hunks[0].Content)
	if _, err := execGitWithStdin(f.path, broken, "apply", "--cached", "--check"); err == nil {
		t.Fatal("无尾换行补丁被 git apply 接受——非末位暗伤不复存在，本修复与锚定用例须重审")
	}

	if err := StageHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("StageHunk(0)（非末位块）: %v", err)
	}

	staged, err := GetFileDiff(f.path, f.file, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(staged, "alpha CHANGED") {
		t.Error("块 0 暂存后暂存 diff 缺 alpha CHANGED")
	}
	if strings.Contains(staged, "omega CHANGED") {
		t.Error("块 1（omega）被误暂存，应留工作区")
	}
	worktree, err := GetFileDiff(f.path, f.file, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(worktree, "omega CHANGED") {
		t.Error("块 1（omega）应仍在工作区未暂存")
	}
	if strings.Contains(worktree, "alpha CHANGED") {
		t.Error("块 0 暂存后工作区 diff 不应再含 alpha CHANGED")
	}
}

// TestUnstageHunk_NonFinalHunkUnstages unstage 同构：两块全部已暂存后取消
// 暂存非末位块成功——alpha 退回工作区、omega 留在暂存区
func TestUnstageHunk_NonFinalHunkUnstages(t *testing.T) {
	f := newDiscardFixture(t)
	f.stage(f.file, f.changed) // 两块全部入暂存
	wantTwoHunks(t, f, true)

	if err := UnstageHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("UnstageHunk(0)（非末位块）: %v", err)
	}

	staged, err := GetFileDiff(f.path, f.file, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(staged, "alpha CHANGED") {
		t.Error("块 0 应已退出暂存区（暂存 diff 不应含 alpha CHANGED）")
	}
	if !strings.Contains(staged, "omega CHANGED") {
		t.Error("相邻块（omega）被误取消暂存，应留在暂存区")
	}
	worktree, err := GetFileDiff(f.path, f.file, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(worktree, "alpha CHANGED") {
		t.Error("块 0 取消暂存后应以未暂存形态回到工作区 diff")
	}
}

// TestStageHunk_LastHunkNoRegression 末位块不回归：末位 hunk 天然带尾换行
// （补尾逻辑零改写），暂存仍成功
func TestStageHunk_LastHunkNoRegression(t *testing.T) {
	f := newDiscardFixture(t)
	hunks := wantTwoHunks(t, f, false)
	if !strings.HasSuffix(hunks[1].Content, "\n") {
		t.Fatalf("fixture 失效：末位块应天然带尾换行，got %q", hunks[1].Content)
	}

	if err := StageHunk(f.path, f.file, 1); err != nil {
		t.Fatalf("StageHunk(1)（末位块）: %v", err)
	}

	staged, err := GetFileDiff(f.path, f.file, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(staged, "omega CHANGED") || strings.Contains(staged, "alpha CHANGED") {
		t.Errorf("末位块暂存结果不纯：want 仅 omega，got %q", staged)
	}
}

// TestStageHunk_RoundTripStatusCount stage 往返：暂存后 status 命中双改态
// （MM = 已暂存 + 工作区仍有未暂存）、暂存侧行数命中（块 0 = +1/-1）
func TestStageHunk_RoundTripStatusCount(t *testing.T) {
	f := newDiscardFixture(t)
	wantTwoHunks(t, f, false)

	if err := StageHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("StageHunk(0): %v", err)
	}

	// status 命中：首列（暂存区）M + 次列（工作区）M
	status := hunkGitOut(t, f.path, "status", "--porcelain", "--", f.file)
	if status != "MM "+f.file+"\n" {
		t.Errorf("status = %q, want %q（块 0 暂存后双改态）", status, "MM "+f.file)
	}

	// 暂存侧行数命中：块 0 是单行替换，暂存 diff numstat = +1/-1
	numstat := hunkGitOut(t, f.path, "diff", "--cached", "--numstat", "--", f.file)
	if numstat != "1\t1\t"+f.file+"\n" {
		t.Errorf("staged numstat = %q, want %q", numstat, "1\t1\t"+f.file)
	}

	// 往返闭合：unstage 同块后 status 回纯工作区改态（ _M）
	if err := UnstageHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("UnstageHunk(0) 往返: %v", err)
	}
	status = hunkGitOut(t, f.path, "status", "--porcelain", "--", f.file)
	if status != " M "+f.file+"\n" {
		t.Errorf("往返后 status = %q, want %q（暂存区回空）", status, " M "+f.file)
	}
}
