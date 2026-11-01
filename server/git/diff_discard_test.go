package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// DiscardHunk 单测（P-20261003-49）：真实 fixture 仓库走 git 层全链。
// 覆盖任务书三点——单 hunk 回滚 / 冲突拒绝（安全失败工作区不动）/ 相邻 hunk
// 不受扰；另补暂存区不受染与越界索引拒绝。

// discardFixture 最小仓库：基线提交三段文件 + 两个相距超过上下文窗口（3 行）
// 的改动块（alpha / omega 各改一行 → 恰好两个独立 hunk）
type discardFixture struct {
	t       *testing.T
	path    string
	file    string
	base    string
	changed string
}

func newDiscardFixture(t *testing.T) *discardFixture {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init")
	run("config", "core.autocrlf", "false") // 三平台行尾语义对齐（e2e 同款口径）
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")

	file := "discard.txt"
	base := strings.Join([]string{
		"alpha one",
		"alpha two",
		"ctx",
		"ctx",
		"ctx",
		"ctx",
		"ctx",
		"ctx",
		"ctx",
		"ctx",
		"omega one",
		"omega two",
		"",
	}, "\n")
	changed := strings.Replace(base, "alpha two", "alpha CHANGED", 1)
	changed = strings.Replace(changed, "omega one", "omega CHANGED", 1)

	if err := os.WriteFile(filepath.Join(dir, file), []byte(base), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "baseline")
	if err := os.WriteFile(filepath.Join(dir, file), []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	return &discardFixture{t: t, path: dir, file: file, base: base, changed: changed}
}

func (f *discardFixture) read() string {
	f.t.Helper()
	b, err := os.ReadFile(filepath.Join(f.path, f.file))
	if err != nil {
		f.t.Fatal(err)
	}
	return string(b)
}

// stagedFiles 返回暂存区有内容的文件名列表（git diff --cached --name-only）
func (f *discardFixture) stagedFiles() string {
	f.t.Helper()
	cmd := exec.Command("git", "diff", "--cached", "--name-only")
	cmd.Dir = f.path
	out, err := cmd.Output()
	if err != nil {
		f.t.Fatalf("git diff --cached: %v", err)
	}
	return string(out)
}

func (f *discardFixture) stage(rel, content string) {
	f.t.Helper()
	p := filepath.Join(f.path, rel)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	cmd := exec.Command("git", "add", rel)
	cmd.Dir = f.path
	if out, err := cmd.CombinedOutput(); err != nil {
		f.t.Fatalf("git add %s: %v: %s", rel, err, out)
	}
}

// TestDiscardHunk_RestoresSingleBlock 单 hunk 回滚 + 相邻 hunk 不受扰 +
// 暂存区不受染：两个未暂存改动块，discard 第 0 块后 alpha 段还原、omega 段
// 保持改动，无关文件暂存内容原样
func TestDiscardHunk_RestoresSingleBlock(t *testing.T) {
	f := newDiscardFixture(t)

	// 无关文件先入暂存区：discard 只许动工作区，不许碰索引
	f.stage("staged.txt", "staged content\n")

	hunks, err := GetFileHunks(f.path, f.file, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(hunks) != 2 {
		t.Fatalf("hunks = %d, want 2 (alpha/omega 各一块)", len(hunks))
	}

	if err := DiscardHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("DiscardHunk(0): %v", err)
	}

	got := f.read()
	if strings.Contains(got, "alpha CHANGED") {
		t.Error("hunk 0 回滚后 alpha 段仍是被改内容")
	}
	if !strings.Contains(got, "alpha one") || !strings.Contains(got, "alpha two") {
		t.Error("hunk 0 回滚后 alpha 段未还原为基线内容")
	}
	// 相邻 hunk 不受扰：omega 段保持工作区改动
	if !strings.Contains(got, "omega CHANGED") {
		t.Error("相邻 hunk（omega 段）被误回滚")
	}
	// 暂存区不动：无关文件的暂存内容原样，目标文件不入暂存
	if staged := f.stagedFiles(); staged != "staged.txt\n" {
		t.Errorf("staged files = %q, want staged.txt（暂存区被 discard 污染）", staged)
	}

	// 第二块同样可单独回滚：全弃后工作区回到基线
	if err := DiscardHunk(f.path, f.file, 0); err != nil {
		t.Fatalf("DiscardHunk(0) 第二次: %v", err)
	}
	if got := f.read(); got != f.base {
		t.Errorf("全部 discard 后文件 = %q, want 基线 %q", got, f.base)
	}
}

// TestDiscardHunk_ConflictRejected 冲突拒绝（③）：拿旧快照 hunk 打已再改的
// 工作区 → ErrHunkDiscardConflict 且工作区一个字节不动（安全失败）。
// 直接调 applyHunkReverse 注入「快照-应用窗口内文件被改」的确定性冲突——
// DiscardHunk 内部窗口毫秒级，黑盒无法稳定复现
func TestDiscardHunk_ConflictRejected(t *testing.T) {
	f := newDiscardFixture(t)

	hunks, err := GetFileHunks(f.path, f.file, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(hunks) == 0 {
		t.Fatal("无 hunk，fixture 失效")
	}
	stale := hunks[0].Content

	// 快照后该块被再次改动：alpha 段改成与快照不同的另一版
	tampered := strings.Replace(f.changed, "alpha CHANGED", "alpha EDITED-AGAIN", 1)
	if err := os.WriteFile(filepath.Join(f.path, f.file), []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}

	err = applyHunkReverse(f.path, f.file, stale)
	if !errors.Is(err, ErrHunkDiscardConflict) {
		t.Fatalf("err = %v, want ErrHunkDiscardConflict", err)
	}
	if !strings.Contains(err.Error(), HunkDiscardConflictMarker) {
		t.Errorf("错误文本缺稳定标记 %q: %v", HunkDiscardConflictMarker, err)
	}
	// 安全失败：工作区保持被再改的版本，未被部分改写
	if got := f.read(); got != tampered {
		t.Errorf("冲突后文件被改动：got %q, want %q", got, tampered)
	}
}

// TestDiscardHunk_InvalidIndex 越界索引拒绝：负数/超表尾报错且文件不动
func TestDiscardHunk_InvalidIndex(t *testing.T) {
	f := newDiscardFixture(t)

	for _, idx := range []int{-1, 99} {
		if err := DiscardHunk(f.path, f.file, idx); err == nil {
			t.Errorf("DiscardHunk(%d) 应报错", idx)
		} else if !strings.Contains(err.Error(), "invalid hunk index") {
			t.Errorf("DiscardHunk(%d) err = %v, want invalid hunk index", idx, err)
		}
	}
	if got := f.read(); got != f.changed {
		t.Errorf("越界请求后文件被改动：%q", got)
	}
}
