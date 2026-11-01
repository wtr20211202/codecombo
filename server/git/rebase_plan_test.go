package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initSubjectRepo 建一个每提交独占文件的测试仓库：subjects[i] → 文件 f<i>.txt
// 内容同名（提交间零接触，重排/删除任意组合都能干净应用）
func initSubjectRepo(t *testing.T, subjects []string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	for i, s := range subjects {
		if err := os.WriteFile(filepath.Join(dir, "f"+strings.TrimSpace(s)+".txt"), []byte(s+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-m", s)
		_ = i
	}
	return dir
}

// subjectsOf 从新到旧列出区间内提交的首行信息
func subjectsOf(t *testing.T, dir string) []string {
	t.Helper()
	out, err := execGit(dir, "log", "--format=%s", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			rows = append(rows, line)
		}
	}
	return rows
}

// pickPlan 把区间列表原样转为全 pick 计划
func pickPlan(todo []RebaseAction) []RebaseAction { return todo }

// TestCommitParent 「整理自此提交起」的基准换算：普通提交取父，根提交 isRoot
func TestCommitParent(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c"})
	parent, isRoot, err := CommitParent(dir, mustRevParse(dir, "HEAD~1"))
	if err != nil || isRoot {
		t.Fatalf("parent = %q isRoot = %v err = %v", parent, isRoot, err)
	}
	if parent != mustRevParse(dir, "HEAD~2") {
		t.Fatalf("parent = %q, want root commit", parent)
	}
	_, isRoot, err = CommitParent(dir, mustRevParse(dir, "HEAD~2"))
	if err != nil || !isRoot {
		t.Fatalf("root commit: isRoot = %v err = %v, want true/nil", isRoot, err)
	}
	if _, _, err := CommitParent(dir, "zzzzzzz!!"); err == nil {
		t.Fatal("invalid hash must be rejected")
	}
}

// TestInteractiveRebaseSquashDrop 相邻 squash + drop：合并消息按序拼接、
// 被丢提交的文件从工作区消失
func TestInteractiveRebaseSquashDrop(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c", "d"})
	todo, err := GetRebaseTodo(dir, mustRevParse(dir, "HEAD~3")) // 区间 b,c,d
	if err != nil {
		t.Fatal(err)
	}
	if len(todo) != 3 || todo[0].Msg != "b" || todo[2].Msg != "d" {
		t.Fatalf("todo = %+v, want apply order [b c d]", todo)
	}
	plan := []RebaseAction{
		{Action: "pick", Hash: todo[0].Hash, Msg: "b"},
		{Action: "squash", Hash: todo[1].Hash, Msg: "c"},
		{Action: "drop", Hash: todo[2].Hash, Msg: "d"},
	}
	if _, err := InteractiveRebase(dir, mustRevParse(dir, "HEAD~3"), plan, false); err != nil {
		t.Fatalf("rebase: %v", err)
	}
	got := subjectsOf(t, dir)
	// 合并消息 = "b\n\nc"，首行 subject 仍是 "b"（完整消息在下方断言）
	if len(got) != 2 || got[0] != "b" || got[1] != "a" {
		t.Fatalf("subjects = %v, want [b a]", got)
	}
	// 合并消息 = b 与 c 的完整消息按序空行连接（标准 squash 输出）
	full, err := execGit(dir, "log", "--format=%B", "-1", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if want := "b\n\nc"; strings.TrimSpace(full) != want {
		t.Fatalf("squashed message = %q, want %q", strings.TrimSpace(full), want)
	}
	// 被丢提交的文件不在工作区；保留提交的文件在
	if _, err := os.Stat(filepath.Join(dir, "fd.txt")); !os.IsNotExist(err) {
		t.Fatalf("dropped commit file should be gone, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "fb.txt")); err != nil {
		t.Fatalf("kept commit file missing: %v", err)
	}
}

// TestInteractiveRebaseReorder 重排：调换两条互不接触的提交后按新序落历史
func TestInteractiveRebaseReorder(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c", "d"})
	onto := mustRevParse(dir, "HEAD~3")
	todo, err := GetRebaseTodo(dir, onto)
	if err != nil {
		t.Fatal(err)
	}
	// 应用序 [b c d] → 重排为 [c b d]
	plan := []RebaseAction{
		{Action: "pick", Hash: todo[1].Hash, Msg: todo[1].Msg},
		{Action: "pick", Hash: todo[0].Hash, Msg: todo[0].Msg},
		{Action: "pick", Hash: todo[2].Hash, Msg: todo[2].Msg},
	}
	if _, err := InteractiveRebase(dir, onto, plan, false); err != nil {
		t.Fatalf("rebase: %v", err)
	}
	got := subjectsOf(t, dir)
	if want := []string{"d", "b", "c", "a"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("subjects = %v, want %v", got, want)
	}
}

// TestInteractiveRebaseReword 历史中段 reword 携新消息：目标被改、后代保留
func TestInteractiveRebaseReword(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c", "d"})
	onto := mustRevParse(dir, "HEAD~3")
	todo, err := GetRebaseTodo(dir, onto)
	if err != nil {
		t.Fatal(err)
	}
	plan := []RebaseAction{
		{Action: "pick", Hash: todo[0].Hash, Msg: "b"},
		{Action: "reword", Hash: todo[1].Hash, Msg: "c", NewMessage: "c: fixed message"},
		{Action: "pick", Hash: todo[2].Hash, Msg: "d"},
	}
	if _, err := InteractiveRebase(dir, onto, plan, false); err != nil {
		t.Fatalf("rebase: %v", err)
	}
	got := subjectsOf(t, dir)
	if want := []string{"d", "c: fixed message", "b", "a"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("subjects = %v, want %v", got, want)
	}
	// 文件内容不被改写（autocrlf 检出可能是 CRLF，归一后比较）
	data, err := os.ReadFile(filepath.Join(dir, "fc.txt"))
	if err != nil || strings.TrimSpace(string(data)) != "c" {
		t.Fatalf("worktree content changed: %q %v", data, err)
	}
}

// TestInteractiveRebaseRootRange onto 为空 = 根提交区间（--root 全历史）
func TestInteractiveRebaseRootRange(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b"})
	todo, err := GetRebaseTodo(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(todo) != 2 || todo[0].Msg != "a" {
		t.Fatalf("todo = %+v, want apply order [a b]", todo)
	}
	plan := []RebaseAction{
		{Action: "reword", Hash: todo[0].Hash, Msg: "a", NewMessage: "a: root reworded"},
		{Action: "pick", Hash: todo[1].Hash, Msg: "b"},
	}
	if _, err := InteractiveRebase(dir, "", plan, false); err != nil {
		t.Fatalf("rebase: %v", err)
	}
	got := subjectsOf(t, dir)
	if want := []string{"b", "a: root reworded"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("subjects = %v, want %v", got, want)
	}
}

// TestInteractiveRebaseMergeRejected 区间内含合并提交直接拒绝
func TestInteractiveRebaseMergeRejected(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a"})
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "feature work")
	run("checkout", "main")
	if err := os.WriteFile(filepath.Join(dir, "m.txt"), []byte("m\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "m1")
	run("merge", "--no-ff", "feature", "-m", "merge feature")

	todo, err := GetRebaseTodo(dir, mustRevParse(dir, "HEAD~2"))
	if err != nil {
		t.Fatal(err)
	}
	plan := pickPlan(todo)
	if _, err := InteractiveRebase(dir, mustRevParse(dir, "HEAD~2"), plan, false); err == nil {
		t.Fatal("merge commit in range must be rejected")
	} else if !strings.Contains(err.Error(), "merge") {
		t.Fatalf("error = %v, want merge-related", err)
	}
}

// TestInteractiveRebaseConflictAborts 冲突场景：服务端 abort 回原状，
// 历史与工作区不变、无进行中 rebase 残留（提案 e2e 冲突场景的单测镜像）
func TestInteractiveRebaseConflictAborts(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	write := func(content string) {
		if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-m", "step")
	}
	write("line1\nline2\nline3\n") // c1
	write("line1\nC2\nline3\n")    // c2：改 line2
	write("line1\nC3\nline3\n")    // c3：基于 C2 再改 line2

	onto := mustRevParse(dir, "HEAD~2")
	plan := []RebaseAction{
		{Action: "drop", Hash: mustRevParse(dir, "HEAD~1"), Msg: "step"},
		{Action: "pick", Hash: mustRevParse(dir, "HEAD"), Msg: "step"},
	}
	// 丢掉 c2 后 c3 的补丁上下文失配 → 冲突
	_, err := InteractiveRebase(dir, onto, plan, false)
	if err == nil {
		t.Fatal("conflicting plan must fail")
	}
	if !strings.Contains(err.Error(), "restored via rebase --abort") {
		t.Fatalf("error = %v, want abort-restored marker", err)
	}
	// 历史不变
	got := subjectsOf(t, dir)
	if len(got) != 3 {
		t.Fatalf("history changed after abort: %v", got)
	}
	// 无进行中 rebase 残留
	if op := OperationInProgress(dir); op != "" {
		t.Fatalf("operation in progress after abort: %q", op)
	}
	// 工作区回到原状态
	data, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil || !strings.Contains(strings.TrimSpace(string(data)), "C3") {
		t.Fatalf("worktree not restored: %q %v", data, err)
	}
}

// TestInteractiveRebasePushedRequiresConfirm 区间含已推送提交：未确认拒绝并给
// 影响面分支列表，确认后放行（reword ErrCommitPushed 同款两段式）
func TestInteractiveRebasePushedRequiresConfirm(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c"})
	bare := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "--bare", bare).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v (%s)", err, out)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("remote", "add", "origin", filepath.ToSlash(bare))
	run("push", "-u", "origin", "main")

	onto := mustRevParse(dir, "HEAD~2")
	todo, err := GetRebaseTodo(dir, onto)
	if err != nil {
		t.Fatal(err)
	}
	plan := []RebaseAction{
		{Action: "reword", Hash: todo[0].Hash, Msg: "b", NewMessage: "b: rewritten"},
		{Action: "pick", Hash: todo[1].Hash, Msg: "c"},
	}
	result, err := InteractiveRebase(dir, onto, plan, false)
	if !errors.Is(err, ErrRebaseRangePushed) {
		t.Fatalf("want ErrRebaseRangePushed, got %v", err)
	}
	if !result.Pushed || len(result.RemoteBranches) == 0 || !strings.Contains(result.RemoteBranches[0], "origin/main") {
		t.Fatalf("result = %+v, want origin/main impact", result)
	}
	// 确认后放行
	if _, err := InteractiveRebase(dir, onto, plan, true); err != nil {
		t.Fatalf("confirmed rebase: %v", err)
	}
	if got := subjectsOf(t, dir); got[0] != "c" || got[1] != "b: rewritten" {
		t.Fatalf("subjects = %v", got)
	}
}

// TestInteractiveRebaseValidation 计划校验：动作白名单 / reword 必须带消息 /
// newMessage 仅限 reword / 覆盖完整性 / 首动作 / 全 drop
func TestInteractiveRebaseValidation(t *testing.T) {
	dir := initSubjectRepo(t, []string{"a", "b", "c"})
	onto := mustRevParse(dir, "HEAD~2")
	todo, err := GetRebaseTodo(dir, onto)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		onto    string
		plan    []RebaseAction
		errPart string
	}{
		{"unknown action", onto, []RebaseAction{{Action: "edit", Hash: todo[0].Hash, Msg: "b"}}, "unsupported rebase action"},
		{"bad hash", onto, []RebaseAction{{Action: "pick", Hash: "zzzzzzz!!", Msg: "b"}}, "invalid commit hash"},
		{"reword without message", onto, []RebaseAction{{Action: "reword", Hash: todo[0].Hash, Msg: "b"}}, "reword requires a new message"},
		{"newMessage on pick", onto, []RebaseAction{{Action: "pick", Hash: todo[0].Hash, Msg: "b", NewMessage: "x"}}, "newMessage is only valid"},
		{"missing coverage", onto, []RebaseAction{{Action: "pick", Hash: todo[0].Hash, Msg: "b"}}, "must cover every commit"},
		{"out of range", onto, []RebaseAction{
			{Action: "pick", Hash: todo[0].Hash, Msg: "b"},
			{Action: "pick", Hash: todo[1].Hash, Msg: "c"},
			{Action: "pick", Hash: mustRevParse(dir, "main~2"), Msg: "a"},
		}, "outside the rebase range"},
		{"duplicate", onto, []RebaseAction{
			{Action: "pick", Hash: todo[0].Hash, Msg: "b"},
			{Action: "pick", Hash: todo[0].Hash, Msg: "b"},
			{Action: "pick", Hash: todo[1].Hash, Msg: "c"},
		}, "duplicate commit"},
		{"squash first", onto, []RebaseAction{
			{Action: "squash", Hash: todo[0].Hash, Msg: "b"},
			{Action: "pick", Hash: todo[1].Hash, Msg: "c"},
		}, "cannot be the first action"},
		{"all dropped", onto, []RebaseAction{
			{Action: "drop", Hash: todo[0].Hash, Msg: "b"},
			{Action: "drop", Hash: todo[1].Hash, Msg: "c"},
		}, "drops the entire range"},
		{"empty plan", onto, []RebaseAction{}, "plan is empty"},
		// bad onto：validateRef 只防选项注入，不存在的引用由 git rev-list 报错，
		// 文案随 git 版本变化——errPart 置空只断言失败
		{"bad onto", "not..a..ref", pickPlan(todo), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := InteractiveRebase(dir, tc.onto, tc.plan, false)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			if tc.errPart != "" && !strings.Contains(err.Error(), tc.errPart) {
				t.Fatalf("err = %v, want containing %q", err, tc.errPart)
			}
		})
	}
	// 历史未被任何失败用例破坏
	if got := subjectsOf(t, dir); len(got) != 3 {
		t.Fatalf("history changed by rejected plans: %v", got)
	}
}
