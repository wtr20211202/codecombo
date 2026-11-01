package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/model"
)

// autoStashFixture 构造带 master/feature 两分支的仓库（分支名不依赖 init 默认，
// 显式落 master）：
//
//	base 提交（master）：carry.txt="carry"（两分支同内容，可被干净携带）+
//	conflict.txt="base"；feature 分支独有提交把 conflict.txt 改为
//	"feature version"——master 侧对 conflict.txt 的脏改动 pop 回 feature 必冲突
func autoStashFixture(t *testing.T) string {
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

	write("carry.txt", "carry\n")
	write("conflict.txt", "base\n")
	must("add", ".")
	must("commit", "-q", "-m", "base")

	must("checkout", "-q", "-b", "feature")
	write("conflict.txt", "feature version\n")
	must("commit", "-qam", "feat: conflict.txt on feature")
	must("checkout", "-q", "master")

	if b, err := GetCurrentBranch(repo); err != nil || b != "master" {
		t.Fatalf("fixture: current branch = %q, err = %v", b, err)
	}
	return repo
}

// dirty 落一个工作区修改并断言 stash 栈状态（栈深 + 顶条消息）
func assertStashState(t *testing.T, repo string, wantCount int, wantTopMsg string) {
	t.Helper()
	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	if len(stashes) != wantCount {
		t.Fatalf("stash count = %d, want %d (list: %+v)", len(stashes), wantCount, stashes)
	}
	if wantCount > 0 && !strings.Contains(stashes[0].Message, wantTopMsg) {
		t.Fatalf("top stash message = %q, want substring %q", stashes[0].Message, wantTopMsg)
	}
}

// TestCheckoutWithAutoStash_SuccessRestoresChanges 主链路：脏改动可干净携带时，
// stash → checkout → pop 一键完成——变更回到目标分支，stash 栈清空
func TestCheckoutWithAutoStash_SuccessRestoresChanges(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\ndirty edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := CheckoutWithAutoStash(repo, "feature")
	if err != nil {
		t.Fatalf("CheckoutWithAutoStash: %v", err)
	}
	if !res.Stashed || !res.Restored || res.StashKept {
		t.Fatalf("result = %+v, want Stashed/Restored true, StashKept false", res)
	}
	if b, _ := GetCurrentBranch(repo); b != "feature" {
		t.Fatalf("branch = %q, want feature", b)
	}
	// 变更回来了：修改内容随 pop 回到目标分支工作区
	if got := readRepoFile(t, repo, "carry.txt"); !strings.Contains(got, "dirty edit") {
		t.Fatalf("carry.txt = %q, want restored dirty edit", got)
	}
	assertStashState(t, repo, 0, "")
}

// TestCheckoutWithAutoStash_PopConflictKeepsStash 冲突路径：pop 冲突时切换已
// 成功、stash 条目保留（git pop 冲突不 drop 语义）、结果为非错误的结构化标记
func TestCheckoutWithAutoStash_PopConflictKeepsStash(t *testing.T) {
	repo := autoStashFixture(t)
	// master 侧对 conflict.txt 的改动与 feature 分支提交相撞 → pop 必冲突
	if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("master dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := CheckoutWithAutoStash(repo, "feature")
	if err != nil {
		t.Fatalf("pop conflict must not be an error (switch succeeded), got: %v", err)
	}
	if !res.Stashed || res.Restored || !res.StashKept {
		t.Fatalf("result = %+v, want Stashed/StashKept true, Restored false", res)
	}
	if b, _ := GetCurrentBranch(repo); b != "feature" {
		t.Fatalf("branch = %q, want feature", b)
	}
	// stash 保留且消息可对账：目标分支名在案（原分支名由 git `On master:` 前缀承载）
	assertStashState(t, repo, 1, "auto: checkout to feature")
	// 工作区留下冲突现场（标记 + 双方内容），变更未丢
	got := readRepoFile(t, repo, "conflict.txt")
	if !strings.Contains(got, "<<<<<<<") || !strings.Contains(got, "master dirty") || !strings.Contains(got, "feature version") {
		t.Fatalf("conflict.txt = %q, want conflict markers with both sides", got)
	}
}

// TestCheckoutWithAutoStash_CheckoutFailureRestores 失败路径：目标分支不存在时
// 报错并还原现场——改动 pop 回原分支，stash 栈清空，不丢变更
func TestCheckoutWithAutoStash_CheckoutFailureRestores(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\ndirty edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := CheckoutWithAutoStash(repo, "no-such-branch")
	if err == nil {
		t.Fatal("checkout to nonexistent branch must fail")
	}
	if !strings.Contains(err.Error(), "changes restored from auto-stash") {
		t.Fatalf("error = %v, want restored-from-auto-stash annotation", err)
	}
	if b, _ := GetCurrentBranch(repo); b != "master" {
		t.Fatalf("branch = %q, want master (restored)", b)
	}
	if got := readRepoFile(t, repo, "carry.txt"); !strings.Contains(got, "dirty edit") {
		t.Fatalf("carry.txt = %q, want dirty edit restored", got)
	}
	assertStashState(t, repo, 0, "")
}

// TestCheckoutWithAutoStash_CleanWorktreeSkipsPop 安全路径：执行时工作区已干净
// （stash 为 no-op）→ 尾部 pop 必须跳过，绝不误 pop 存量条目
func TestCheckoutWithAutoStash_CleanWorktreeSkipsPop(t *testing.T) {
	repo := autoStashFixture(t)
	// 预置一条与本次无关的存量 stash，再把工作区还原干净
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nolder\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: "older stash"}); err != nil {
		t.Fatalf("seed stash: %v", err)
	}
	if _, err := execGit(repo, "checkout", "--", "carry.txt"); err != nil {
		t.Fatalf("clean worktree: %v", err)
	}

	res, err := CheckoutWithAutoStash(repo, "feature")
	if err != nil {
		t.Fatalf("CheckoutWithAutoStash: %v", err)
	}
	if res.Stashed || res.Restored || res.StashKept {
		t.Fatalf("result = %+v, want all false (no stash created, pop skipped)", res)
	}
	// 存量条目原封不动：仍是那一条旧 stash，未被误 pop/误 drop
	assertStashState(t, repo, 1, "older stash")
}

// TestCheckoutWithAutoStash_UntrackedRestored 未跟踪文件入栈：脏区预检口径含
// Untracked，链路须把未跟踪新文件一并 stash 并在目标分支恢复
func TestCheckoutWithAutoStash_UntrackedRestored(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("brand new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := CheckoutWithAutoStash(repo, "feature")
	if err != nil {
		t.Fatalf("CheckoutWithAutoStash: %v", err)
	}
	if !res.Stashed || !res.Restored {
		t.Fatalf("result = %+v, want Stashed/Restored true", res)
	}
	if got := readRepoFile(t, repo, "untracked.txt"); got != "brand new\n" {
		t.Fatalf("untracked.txt = %q, want restored on feature", got)
	}
	assertStashState(t, repo, 0, "")
}

// TestCheckoutWithAutoStash_RejectsOptionLikeBranch 引用名防护前置：形如选项的
// 分支名在任何 git 命令执行前拒绝（工作区零触碰）
func TestCheckoutWithAutoStash_RejectsOptionLikeBranch(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\ndirty edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := CheckoutWithAutoStash(repo, "-D x"); err == nil {
		t.Fatal("option-like branch must be rejected")
	}
	if b, _ := GetCurrentBranch(repo); b != "master" {
		t.Fatalf("branch = %q, want master (untouched)", b)
	}
	if got := readRepoFile(t, repo, "carry.txt"); !strings.Contains(got, "dirty edit") {
		t.Fatalf("carry.txt = %q, want dirty edit untouched", got)
	}
	assertStashState(t, repo, 0, "")
}

func readRepoFile(t *testing.T, repo, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repo, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// TestFindRecoverableAutoStash_KeptEntryRecoveredOnOriginalBranch 恢复提示主链：
// pop 冲突保留的条目（On master: auto: checkout to feature）在切回 master 检出时
// 命中——双注记（分支 + 消息前缀）同源匹配，文件计数在案；检出到其他分支不命中
// （防把 master 的暂存提示恢复到 feature）
func TestFindRecoverableAutoStash_KeptEntryRecoveredOnOriginalBranch(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("master dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := CheckoutWithAutoStash(repo, "feature")
	if err != nil || !res.StashKept {
		t.Fatalf("fixture chain: res = %+v, err = %v (want pop conflict kept)", res, err)
	}

	rec, ok := FindRecoverableAutoStash(repo, "master")
	if !ok {
		t.Fatal("kept auto entry must be found when checking out back to master")
	}
	if rec.Index != 0 || rec.Branch != "master" {
		t.Fatalf("rec = %+v, want index 0 on master", rec)
	}
	if rec.Message != AutoStashMessagePrefix+"feature" {
		t.Fatalf("message = %q, want %q", rec.Message, AutoStashMessagePrefix+"feature")
	}
	if rec.Files < 1 {
		t.Fatalf("files = %d, want >= 1 (conflict.txt in stash)", rec.Files)
	}

	if _, ok := FindRecoverableAutoStash(repo, "feature"); ok {
		t.Fatal("entry created on master must not match checkout to feature")
	}
}

// TestFindRecoverableAutoStash_LatestWins 多条 auto 条目取时间序最新（列表序首个
// 命中即 stash@{N} 最小者），旧条目留在 stash 列表不自动消费
func TestFindRecoverableAutoStash_LatestWins(t *testing.T) {
	repo := autoStashFixture(t)
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nolder\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: AutoStashMessagePrefix + "feature"}); err != nil {
		t.Fatalf("seed older auto entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nnewer\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: AutoStashMessagePrefix + "next"}); err != nil {
		t.Fatalf("seed newer auto entry: %v", err)
	}

	rec, ok := FindRecoverableAutoStash(repo, "master")
	if !ok {
		t.Fatal("auto entry must be found")
	}
	if rec.Message != AutoStashMessagePrefix+"next" {
		t.Fatalf("message = %q, want newest %q", rec.Message, AutoStashMessagePrefix+"next")
	}
	if rec.Index != 0 {
		t.Fatalf("index = %d, want 0 (newest)", rec.Index)
	}
}

// TestFindRecoverableAutoStash_NoFalsePositives 甄别面：非 auto 消息、shelve 前
// 缀（搁置族，恢复出口在搁置流程）、他分支条目、空栈——一律不命中，宁可少提示
// 不误提示。顺带钉住 reflog 段的分支提取（On/WIP on 两形态 + 非标形态留空）
func TestFindRecoverableAutoStash_NoFalsePositives(t *testing.T) {
	// 空栈：零命中
	repo := autoStashFixture(t)
	if _, ok := FindRecoverableAutoStash(repo, "master"); ok {
		t.Fatal("empty stash list must not match")
	}

	// 同分支但非 auto 消息 / shelve 前缀：不命中（shelve 有自己的恢复出口）
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nmanual\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: "older stash"}); err != nil {
		t.Fatalf("seed manual entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nshelved\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Stash(repo, model.StashRequest{Message: "shelve: 1 file(s)"}); err != nil {
		t.Fatalf("seed shelve entry: %v", err)
	}
	if _, ok := FindRecoverableAutoStash(repo, "master"); ok {
		t.Fatal("manual/shelve entries must not match auto recovery")
	}

	// auto 消息但创建在他分支（On feature:）：对 master 不命中，对 feature 命中
	if err := os.WriteFile(filepath.Join(repo, "carry.txt"), []byte("carry\nonfeature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must := func(args ...string) {
		t.Helper()
		if _, err := execGit(repo, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	must("checkout", "-q", "feature")
	if _, err := Stash(repo, model.StashRequest{Message: AutoStashMessagePrefix + "master"}); err != nil {
		t.Fatalf("seed on-feature entry: %v", err)
	}
	must("checkout", "-q", "master")
	if _, ok := FindRecoverableAutoStash(repo, "master"); ok {
		t.Fatal("on-feature auto entry must not match checkout to master")
	}
	if _, ok := FindRecoverableAutoStash(repo, "feature"); !ok {
		t.Fatal("on-feature auto entry must match checkout back to feature")
	}

	// 分支提取钉住：自定义消息 On 形态 / 缺省消息 WIP on 形态 / 非标 reflog 留空
	if b := stashBranchFromReflog("On master"); b != "master" {
		t.Fatalf("stashBranchFromReflog(On master) = %q", b)
	}
	if b := stashBranchFromReflog("WIP on feature/x"); b != "feature/x" {
		t.Fatalf("stashBranchFromReflog(WIP on feature/x) = %q", b)
	}
	if b := stashBranchFromReflog("stored by hand"); b != "" {
		t.Fatalf("stashBranchFromReflog(nonstandard) = %q, want empty", b)
	}
}
