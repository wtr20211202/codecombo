package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// untracked 追补单测（P-20261004-56 导出补丁包含 untracked 文件）：
// 混合现场 tracked+untracked 段齐备 / 纯 untracked 可导 / staged 语义不变 /
// 大小与数量上限注记 / 收件侧干净克隆 git apply 双向（正向还原含二进制字节级、
// 逆向删除新文件——替换备份链还原口诀）。

// newPatchFixture 最小仓库：基线提交 1 个 tracked 文件，工作区留下
// tracked 改动 + untracked 文本/二进制/空文件/被 .gitignore 排除的文件
func newPatchFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		abs := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", name, err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	run("init", "-b", "main")
	run("config", "core.autocrlf", "false") // 三平台行尾语义对齐（e2e 同款口径）
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	write("base.txt", "v1\n")
	run("add", ".")
	run("commit", "-m", "base")
	write("base.txt", "v2\n")                        // tracked 未暂存改动
	write("new-mod/added.txt", "agent scaffold\n")   // untracked 新文件（子目录）
	write("new-mod/blob.bin", "PNG\x00payload")      // untracked 二进制
	write("new-mod/empty.txt", "")                   // untracked 空文件（头段也须可 apply）
	write(".gitignore", "*.log\n")
	write("ignored.log", "should not enter patch\n") // 被 .gitignore 排除
	return dir
}

// applyInCleanClone 把补丁正向/逆向应用到干净克隆（替换备份链还原口诀的
// 双向验证）：正向后逐文件字节级一致，逆向删掉新文件回到基线
func applyInCleanClone(t *testing.T, repoDir, patch string, expect map[string]string) string {
	t.Helper()
	clone := filepath.Join(t.TempDir(), "clone")
	runIn := func(dir string, args ...string) string {
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
	// --no-checkout 先克隆、关 smudge 再检出：全局 autocrlf=true 会把基线检成
	// CRLF，补丁上下文失配（e2e freshClone 同款防线）
	runIn(t.TempDir(), "clone", "--no-checkout", repoDir, clone)
	runIn(clone, "config", "core.autocrlf", "false")
	runIn(clone, "checkout", "HEAD")

	patchPath := filepath.Join(t.TempDir(), "u.patch")
	if err := os.WriteFile(patchPath, []byte(patch), 0o644); err != nil {
		t.Fatalf("write patch: %v", err)
	}
	runIn(clone, "apply", "--check", patchPath) // 先 check：整体可应用（全有或全无）
	runIn(clone, "apply", patchPath)
	for name, want := range expect {
		data, err := os.ReadFile(filepath.Join(clone, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("applied file %s missing: %v", name, err)
		}
		if string(data) != want {
			t.Errorf("applied %s = %q, want %q", name, data, want)
		}
	}
	runIn(clone, "apply", "-R", patchPath) // 逆向：替换备份链「丢弃后重放」之外的双向性
	for name := range expect {
		if name == "base.txt" {
			continue // tracked 改动逆向回 v1 仍在；此处断言的是 untracked 新文件被删
		}
		if _, err := os.Stat(filepath.Join(clone, filepath.FromSlash(name))); err == nil {
			t.Errorf("reverse apply should remove new file %s", name)
		}
	}
	return clone
}

func TestDiffHeadPatch_IncludesUntracked(t *testing.T) {
	dir := newPatchFixture(t)
	patch, err := DiffHeadPatch(dir)
	if err != nil {
		t.Fatalf("DiffHeadPatch: %v", err)
	}
	if !strings.Contains(patch, "diff --git a/base.txt") || !strings.Contains(patch, "+v2") {
		t.Errorf("tracked 改动段缺失:\n%s", patch)
	}
	for _, want := range []string{
		"diff --git a/new-mod/added.txt b/new-mod/added.txt",
		"new file mode",
		"--- /dev/null",
		"+++ b/new-mod/added.txt",
		"+agent scaffold",
		"diff --git a/new-mod/empty.txt b/new-mod/empty.txt",
	} {
		if !strings.Contains(patch, want) {
			t.Errorf("untracked 段缺 %q:\n%s", want, patch)
		}
	}
	if !strings.Contains(patch, "GIT binary patch") {
		t.Errorf("untracked 二进制应出 GIT binary patch literal 段:\n%s", patch)
	}
	if strings.Contains(patch, "ignored.log") {
		t.Errorf(".gitignore 排除文件不应入补丁:\n%s", patch)
	}
	// 确定性次序：tracked 在前、untracked 段按路径序在后
	if strings.Index(patch, "+++ b/base.txt") > strings.Index(patch, "+++ b/new-mod/added.txt") {
		t.Errorf("次序应为 tracked 前 / untracked 段在后（路径序）")
	}

	applyInCleanClone(t, dir, patch, map[string]string{
		"base.txt":           "v2\n",
		"new-mod/added.txt":  "agent scaffold\n",
		"new-mod/blob.bin":   "PNG\x00payload",
		"new-mod/empty.txt":  "",
	})
}

func TestExportDiffAsPatch_WorktreeIncludesUntracked_StagedNot(t *testing.T) {
	dir := newPatchFixture(t)

	wt, err := ExportDiffAsPatch(dir, false)
	if err != nil {
		t.Fatalf("ExportDiffAsPatch(worktree): %v", err)
	}
	if !strings.Contains(wt, "+++ b/new-mod/added.txt") {
		t.Errorf("worktree 形态应追补 untracked 段:\n%s", wt)
	}
	if !strings.Contains(wt, "+v2") {
		t.Errorf("worktree 形态应含未暂存 tracked 改动:\n%s", wt)
	}

	sg, err := ExportDiffAsPatch(dir, true)
	if err != nil {
		t.Fatalf("ExportDiffAsPatch(staged): %v", err)
	}
	if strings.TrimSpace(sg) != "" {
		t.Errorf("staged 语义不变：本夹具暂存区干净，不应有任何输出（含 untracked）:\n%s", sg)
	}
}

func TestExportDiffAsPatch_PureUntrackedExportable(t *testing.T) {
	dir := newPatchFixture(t)
	// 清掉 tracked 改动 → 纯 untracked 现场（P-72 时代此形态导出为空/按钮禁用）
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	runGit("checkout", "--", "base.txt")

	wt, err := ExportDiffAsPatch(dir, false)
	if err != nil {
		t.Fatalf("pure untracked export: %v", err)
	}
	if !strings.Contains(wt, "new file mode") || !strings.Contains(wt, "+++ b/new-mod/added.txt") {
		t.Errorf("纯 untracked 现场应可导出且含新文件段:\n%s", wt)
	}
	if strings.Contains(wt, "base.txt") {
		t.Errorf("tracked 已还原，不应有 tracked 段:\n%s", wt)
	}
	applyInCleanClone(t, dir, wt, map[string]string{
		"new-mod/added.txt": "agent scaffold\n",
		"new-mod/blob.bin":  "PNG\x00payload",
	})
}

func TestUntrackedPatchSegments_Caps(t *testing.T) {
	// 收缩上限（var 可注入）：免跑数百个 git 子进程把单测拖成 20s+
	origFiles, origBytes := untrackedPatchMaxFiles, untrackedPatchMaxBytes
	t.Cleanup(func() { untrackedPatchMaxFiles, untrackedPatchMaxBytes = origFiles, origBytes })
	untrackedPatchMaxFiles = 5
	untrackedPatchMaxBytes = 16

	initRepo := func(t *testing.T) string {
		t.Helper()
		dir := t.TempDir()
		cmd := exec.Command("git", "init", "-b", "main")
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git init: %v: %s", err, out)
		}
		return dir
	}

	t.Run("oversized file noted not embedded", func(t *testing.T) {
		dir := initRepo(t)
		write := func(name, content string) {
			t.Helper()
			if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
				t.Fatalf("write: %v", err)
			}
		}
		write("huge.bin", strings.Repeat("x", int(untrackedPatchMaxBytes)+1))
		write("ok.txt", "small\n")
		seg := untrackedPatchSegments(dir)
		if strings.Contains(seg, "huge.bin b/huge.bin") {
			t.Errorf("超限文件不应产出 diff 段:\n%s", seg)
		}
		wantNote := "...[untracked file omitted from patch: huge.bin (oversized:"
		if !strings.Contains(seg, wantNote) {
			t.Errorf("超限文件应有注记 %q:\n%s", wantNote, seg)
		}
		if !strings.Contains(seg, "+++ b/ok.txt") {
			t.Errorf("未超限文件照常入补丁:\n%s", seg)
		}
	})

	t.Run("file count cap noted aggregate", func(t *testing.T) {
		dir := initRepo(t)
		total := untrackedPatchMaxFiles + 2
		for i := 0; i < total; i++ {
			name := "f" + strconv.Itoa(i) + ".txt"
			if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o644); err != nil {
				t.Fatalf("write: %v", err)
			}
		}
		seg := untrackedPatchSegments(dir)
		// 聚合注记一条（防产物海把补丁灌满注记行），带剩余数与首条路径定位
		wantNote := "...[2 untracked files omitted from patch (exceeds " + strconv.Itoa(untrackedPatchMaxFiles) + "-file export cap), starting at f5.txt]"
		if !strings.Contains(seg, wantNote) {
			t.Errorf("缺聚合注记 %q:\n%s", wantNote, seg)
		}
		if strings.Count(seg, "untracked files omitted") != 1 {
			t.Errorf("聚合注记应只有一条:\n%s", seg)
		}
		if got := strings.Count(seg, "new file mode"); got != untrackedPatchMaxFiles {
			t.Errorf("入补丁段数 = %d, want %d", got, untrackedPatchMaxFiles)
		}
	})
}
