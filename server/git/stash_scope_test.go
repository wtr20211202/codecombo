package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/model"
)

// stashScopeFixture 构造「部分暂存」场景（P-20261003-119 三种范围语义的公共底座）：
//
//	base 提交：f.txt="base"
//	已暂存：新文件 s.txt 已 add（仅索引，未提交）
//	未暂存：f.txt 追加一行（仅工作区）
//	未跟踪：u.txt（无 -u 时任何 stash 形态都不碰）
func stashScopeFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q", "-b", "master")
	// 本机全局 autocrlf 会污染内容稳定性，仓库级显式关闭
	must("config", "core.autocrlf", "false")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	write("f.txt", "base\n")
	must("add", ".")
	must("commit", "-q", "-m", "base")

	write("s.txt", "staged\n")
	must("add", "s.txt")
	write("f.txt", "base\nunstaged edit\n")
	write("u.txt", "untracked\n")

	st := must("status", "--porcelain")
	// 双列形态断言：s.txt=「A 」索引新增；f.txt=「 M」工作区修改——两半各就各位
	if !strings.Contains(st, "A  s.txt") || !strings.Contains(st, " M f.txt") {
		t.Fatalf("fixture status = %q, want staged s.txt + unstaged f.txt", st)
	}
	return repo
}

// stashTopFiles 返回栈顶 stash 条目涉及的文件清单（stash show --name-only）
func stashTopFiles(t *testing.T, repo string) []string {
	t.Helper()
	out, err := execGit(repo, "stash", "show", "--name-only", "stash@{0}")
	if err != nil {
		t.Fatalf("stash show: %v", err)
	}
	var files []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			files = append(files, l)
		}
	}
	return files
}

// stagedFiles 返回当前索引相对 HEAD 的文件清单（diff --cached --name-only）
func stagedFiles(t *testing.T, repo string) []string {
	t.Helper()
	out, err := execGit(repo, "diff", "--cached", "--name-only")
	if err != nil {
		t.Fatalf("diff --cached: %v", err)
	}
	var files []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			files = append(files, l)
		}
	}
	return files
}

func assertStashCount(t *testing.T, repo string, want int) {
	t.Helper()
	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	if len(stashes) != want {
		t.Fatalf("stash count = %d, want %d (%+v)", len(stashes), want, stashes)
	}
}

// TestStashScopeAll 现状语义回归：scope 缺省/显式 all 行为与改动前一致——
// 已跟踪变更（暂存+未暂存）全部入栈，工作区干净（untracked 不带 -u 不动）
func TestStashScopeAll(t *testing.T) {
	for _, scope := range []string{"", StashScopeAll} {
		repo := stashScopeFixture(t)
		if _, err := Stash(repo, model.StashRequest{Message: "all", Scope: scope}); err != nil {
			t.Fatalf("Stash(scope=%q): %v", scope, err)
		}
		st, err := execGit(repo, "status", "--porcelain")
		if err != nil {
			t.Fatal(err)
		}
		if st != "?? u.txt\n" {
			t.Fatalf("scope=%q status = %q, want only untracked u.txt", scope, st)
		}
		files := stashTopFiles(t, repo)
		if len(files) != 2 {
			t.Fatalf("scope=%q stash files = %v, want f.txt+s.txt", scope, files)
		}
		assertStashCount(t, repo, 1)
	}
}

// TestStashScopeUnstagedKeepsStaged 仅未暂存（--keep-index）：工作区/索引保留
// 已暂存变更，未暂存修改入栈（git 语义：stash 也收下已暂存部分，pop 时以未暂存
// 形态带回——范围 stash 的时间舱注记，此处断言工作区面向「保留已暂存」即可）
func TestStashScopeUnstagedKeepsStaged(t *testing.T) {
	repo := stashScopeFixture(t)
	if _, err := Stash(repo, model.StashRequest{Message: "unstaged only", Scope: StashScopeUnstaged}); err != nil {
		t.Fatalf("Stash: %v", err)
	}

	// 已暂存变更保留在工作区（索引仍有 s.txt）
	idx := stagedFiles(t, repo)
	if len(idx) != 1 || idx[0] != "s.txt" {
		t.Fatalf("staged after stash = %v, want [s.txt]", idx)
	}
	// 工作区无未暂存修改：f.txt 回到基线内容
	if got, err := os.ReadFile(filepath.Join(repo, "f.txt")); err != nil || string(got) != "base\n" {
		t.Fatalf("f.txt = %q (err %v), want baseline base\\n", got, err)
	}
	// stash 含未暂存变更涉及的文件
	found := false
	for _, f := range stashTopFiles(t, repo) {
		if f == "f.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stash files = %v, want contain f.txt (unstaged)", stashTopFiles(t, repo))
	}
	assertStashCount(t, repo, 1)
}

// TestStashScopeStagedOnly 仅已暂存（--staged，git 2.35+）：只有已暂存变更入栈，
// 未暂存修改原样留在工作区、索引清空。跑测试的机器 git < 2.35 时如实跳过
// （降级路径由 TestStashScopeStagedUnsupportedRejects 在任意版本上覆盖）
func TestStashScopeStagedOnly(t *testing.T) {
	if !SupportsStashStaged() {
		t.Skip("本机 git 不支持 stash --staged（< 2.35），语义用例跳过")
	}
	repo := stashScopeFixture(t)
	if _, err := Stash(repo, model.StashRequest{Message: "staged only", Scope: StashScopeStaged}); err != nil {
		t.Fatalf("Stash: %v", err)
	}

	// 索引清空：s.txt 已入栈
	if idx := stagedFiles(t, repo); len(idx) != 0 {
		t.Fatalf("staged after stash = %v, want empty", idx)
	}
	// 未暂存修改原样留在工作区
	if got, err := os.ReadFile(filepath.Join(repo, "f.txt")); err != nil || string(got) != "base\nunstaged edit\n" {
		t.Fatalf("f.txt = %q (err %v), want unstaged edit kept", got, err)
	}
	// stash 只含已暂存文件，不含未暂存修改
	files := stashTopFiles(t, repo)
	if len(files) != 1 || files[0] != "s.txt" {
		t.Fatalf("stash files = %v, want [s.txt]", files)
	}
	assertStashCount(t, repo, 1)
}

// TestStashScopeStagedUnsupportedRejects 降级路径：本机 git 版本检测不通过时
// scope=staged 显式拒绝（稳定标记对外契约），工作区零副作用。经注入缝强制
// unsupported，任意 git 版本上都可验证
func TestStashScopeStagedUnsupportedRejects(t *testing.T) {
	orig := stashStagedSupportedFn
	stashStagedSupportedFn = func() bool { return false }
	defer func() { stashStagedSupportedFn = orig }()

	repo := stashScopeFixture(t)
	_, err := Stash(repo, model.StashRequest{Message: "x", Scope: StashScopeStaged})
	if err == nil || !strings.Contains(err.Error(), "stash --staged requires git 2.35 or newer") {
		t.Fatalf("err = %v, want stable marker for KNOWN_ERROR_I18N", err)
	}
	// 拒绝即零副作用：两半变更原样
	st, err := execGit(repo, "status", "--porcelain")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st, "A  s.txt") || !strings.Contains(st, " M f.txt") {
		t.Fatalf("status after reject = %q, want unchanged fixture state", st)
	}
	assertStashCount(t, repo, 0)
}

// TestStashScopeInvalid 未知 scope 值显式报错（不静默回落全量——调用方拼错值
// 得到可诊断的失败而非语义漂移）
func TestStashScopeInvalid(t *testing.T) {
	repo := stashScopeFixture(t)
	if _, err := Stash(repo, model.StashRequest{Scope: "bogus"}); err == nil {
		t.Fatal("invalid scope should error")
	}
	assertStashCount(t, repo, 0)
}

// TestGitVersionAtLeast 版本比较解析：真实世界输出变体 + 解析失败安全降级
func TestGitVersionAtLeast(t *testing.T) {
	cases := []struct {
		name   string
		output string
		major  int
		minor  int
		want   bool
	}{
		{"windows 后缀", "git version 2.45.1.windows.1", 2, 35, true},
		{"恰好边界版本", "git version 2.35.0", 2, 35, true},
		{"差一个小版本", "git version 2.34.1", 2, 35, false},
		{"apple 变体", "git version 2.39.5 (Apple Git-143)", 2, 35, true},
		{"大版本跨越", "git version 1.9.9", 2, 35, false},
		{"下个大版本", "git version 3.0.0", 2, 35, true},
		{"空输出", "", 2, 35, false},
		{"异常输出", "not a git output", 2, 35, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gitVersionAtLeast(c.output, c.major, c.minor); got != c.want {
				t.Fatalf("gitVersionAtLeast(%q, %d, %d) = %v, want %v", c.output, c.major, c.minor, got, c.want)
			}
		})
	}
}
