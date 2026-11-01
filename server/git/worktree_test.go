package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestRemoveWorktreeMixedPathForms 回归：Windows 下 AddWorktree 以反斜杠路径
// 注册，而列表输出/后续操作使用正斜杠形态——直接把任意形态交给
// `git worktree remove` 报 "is not a working tree"（Round 82 实测）。
// 修复后 RemoveWorktree 先经 resolveWorktreePath 解析为注册表精确路径
// 前提只在 Windows 存在：Linux 把反斜杠当普通文件名字符，注册出来的就是
// 另一个目录，形态混用无从谈起——非 Windows 跳过（WSL/Linux 实测踩中）
func TestRemoveWorktreeMixedPathForms(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("反斜杠路径形态仅 Windows 语义，非 Windows 跳过")
	}
	base := t.TempDir()
	src := base + "-src"
	_ = os.MkdirAll(src, 0755)
	run := func(args []string, cwd string) string {
		cmd := exec.Command("git")
		cmd.Args = append(cmd.Args, args...)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		if err != nil && !strings.Contains(err.Error(), "exit status") {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run([]string{"init"}, base)
	run([]string{"config", "user.name", "e2e"}, base)
	run([]string{"config", "user.email", "e2e@test.local"}, base)
	_ = os.WriteFile(filepath.Join(base, "r.md"), []byte("x\n"), 0644)
	run([]string{"add", "."}, base)
	run([]string{"commit", "-m", "root"}, base)

	wtDir := base + "-wt"
	// 注册时使用反斜杠形态（复现用户输入/Windows 传参形态）
	mixed := strings.ReplaceAll(wtDir, "/", "\\")
	run([]string{"-c", "protocol.file.allow=always", "worktree", "add", mixed, "-b", "wt-x"}, base)

	if _, err := os.Stat(filepath.Join(wtDir, ".git")); err != nil {
		t.Fatalf("worktree 未注册: %v", err)
	}

	// 以正斜杠形态删除（列表输出的形态）
	if err := RemoveWorktree(base, wtDir, false); err != nil {
		t.Fatalf("RemoveWorktree（正斜杠路径）应成功: %v", err)
	}
	if _, err := os.Stat(wtDir + "/.git"); !os.IsNotExist(err) {
		t.Fatalf("删除后 worktree 目录应被移除")
	}
}

// TestAddWorktreeFromHashRefDetached 历史检视 worktree 的服务端语义锚点
// （P-20261005-179）：AddWorktreeFromRef 接受任意 ref 形态，裸 hash 落成
// HEAD 分离、不建分支的定点检出——提交右键「在此提交检视」透传 hash 的
// 依赖面。断言三点：检视工作区文件为目标提交的历史态内容（非 HEAD）、
// worktree 注册表无分支行（Branch 空）、HEAD 落在目标提交
func TestAddWorktreeFromHashRefDetached(t *testing.T) {
	base := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = base
		out, err := cmd.CombinedOutput()
		if err != nil && !strings.Contains(err.Error(), "exit status") {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init")
	run("config", "user.name", "e2e")
	run("config", "user.email", "e2e@test.local")
	// 双路径（win/linux）：压掉全局 autocrlf，worktree 检出内容与写入字节一致
	run("config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(base, "r.md"), []byte("v1\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "root")
	if err := os.WriteFile(filepath.Join(base, "r.md"), []byte("v2\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "second")

	// 检视目标 = 首个提交（历史态；HEAD 已在 second）
	firstHash := strings.TrimSpace(run("rev-parse", "HEAD~1"))

	wtDir := base + "-hist"
	if err := AddWorktreeFromRef(base, wtDir, firstHash); err != nil {
		t.Fatalf("AddWorktreeFromRef(裸 hash): %v", err)
	}
	t.Cleanup(func() { _ = RemoveWorktree(base, wtDir, true) })

	// 检视工作区 = 历史态内容（v1 而非 HEAD 的 v2）
	b, err := os.ReadFile(filepath.Join(wtDir, "r.md"))
	if err != nil {
		t.Fatalf("读检视工作区文件: %v", err)
	}
	if string(b) != "v1\n" {
		t.Fatalf("检视工作区应为目标提交内容 v1，got %q", string(b))
	}

	// 注册表：无分支行（HEAD 分离不建分支）且 HEAD 指向目标提交
	wts, err := ListWorktrees(base)
	if err != nil {
		t.Fatalf("ListWorktrees: %v", err)
	}
	var hist *Worktree
	for i := range wts {
		if normalizeWorktreePath(wts[i].Path) == normalizeWorktreePath(wtDir) {
			hist = &wts[i]
		}
	}
	if hist == nil {
		t.Fatalf("检视 worktree 未登记: %v", wts)
	}
	if hist.Branch != "" {
		t.Fatalf("裸 hash 检视不得建分支（HEAD 分离），got branch=%q", hist.Branch)
	}
	if hist.Hash != firstHash {
		t.Fatalf("HEAD 应落在目标提交 %s，got %s", firstHash, hist.Hash)
	}
}

// TestResolveWorktreePathCaseFallback 验证大小写回退匹配（Windows 路径大小
// 写不敏感场景），Linux 精确匹配路径不受影响
func TestResolveWorktreePathCaseFallback(t *testing.T) {
	base := t.TempDir()
	src := base + "-src"
	_ = os.MkdirAll(src, 0755)
	run := func(args []string, cwd string) string {
		cmd := exec.Command("git")
		cmd.Args = append(cmd.Args, args...)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		if err != nil && !strings.Contains(err.Error(), "exit status") {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run([]string{"init"}, base)
	run([]string{"config", "user.name", "e2e"}, base)
	run([]string{"config", "user.email", "e2e@test.local"}, base)
	_ = os.WriteFile(filepath.Join(base, "r.md"), []byte("x\n"), 0644)
	run([]string{"add", "."}, base)
	run([]string{"commit", "-m", "root"}, base)

	wtDir := base + "-Wt"
	run([]string{"worktree", "add", wtDir, "-b", "wt-y"}, base)

	// 精确（正斜杠）匹配
	got, err := resolveWorktreePath(base, wtDir)
	if err != nil {
		t.Fatalf("resolve（正斜杠）: %v", err)
	}
	if strings.ReplaceAll(got, "\\", "/") != strings.ReplaceAll(wtDir, "\\", "/") {
		t.Fatalf("resolve = %q, want %q", got, wtDir)
	}
}
