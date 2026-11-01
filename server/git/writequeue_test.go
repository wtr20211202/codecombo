package git

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestIsQueuedWriteCommand 写命令分类表：写类入队、读/网络类直通、
// stash 需子命令甄别、全局选项前缀（gitLongPathsArgs 的 -c）正确跳过
func TestIsQueuedWriteCommand(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"add", []string{"add", "."}, true},
		{"commit", []string{"commit", "-m", "x"}, true},
		{"reset", []string{"reset", "--hard"}, true},
		{"checkout", []string{"checkout", "main"}, true},
		{"clean", []string{"clean", "-fd"}, true},
		{"apply", []string{"apply", "-R", "p.diff"}, true},
		{"stash bare 默认 push", []string{"stash"}, true},
		{"stash push flag 形态", []string{"stash", "--include-untracked"}, true},
		{"stash pop", []string{"stash", "pop"}, true},
		{"stash list 读直通", []string{"stash", "list"}, false},
		{"stash show 读直通", []string{"stash", "show"}, false},
		{"stash --list 读直通", []string{"stash", "--list"}, false},
		{"stash 带消息的 push", []string{"stash", "-m", "wip"}, true},
		{"stash branch 应用到新分支入队（P-20261003-263）", []string{"stash", "branch", "trial", "stash@{0}"}, true},
		{"push 网络不持锁", []string{"push", "origin", "main"}, false},
		{"fetch 网络不持锁", []string{"fetch", "--all"}, false},
		{"pull 网络不持锁", []string{"pull", "--rebase"}, false},
		{"status 读直通", []string{"status", "--porcelain"}, false},
		{"log 读直通", []string{"log", "--oneline"}, false},
		{"diff 读直通", []string{"diff", "--cached"}, false},
		{"rev-parse 读直通", []string{"rev-parse", "--git-dir"}, false},
		{"branch 列表读直通", []string{"branch", "-a", "-vv", "--no-abbrev"}, false},
		{"branch 建分支不入队（引用级锁）", []string{"branch", "feature/x"}, false},
		{"branch 删除不入队（引用级锁）", []string{"branch", "-d", "feature/x"}, false},
		{"branch -m 重命名入队（P-20261003-221）", []string{"branch", "-m", "new-name"}, true},
		{"branch -m old new 入队", []string{"branch", "-m", "old", "new"}, true},
		{"branch -M 入队", []string{"branch", "-M", "old", "new"}, true},
		{"branch --move 长形态入队", []string{"branch", "--move", "old", "new"}, true},
		{"branch 重命名混杂旗标命中", []string{"branch", "--sort=-committerdate", "-m", "new"}, true},
		{"-c 前缀跳过后 branch -m", []string{"-c", "core.longpaths=true", "branch", "-m", "old", "new"}, true},
		{"remote 读直通", []string{"remote", "-v"}, false},
		{"-c 全局选项前缀跳过后定位 add", []string{"-c", "core.longpaths=true", "add", "."}, true},
		{"-C 全局选项前缀跳过后定位 commit", []string{"-C", "/repo", "commit", "-m", "x"}, true},
		{"空参数", nil, false},
		{"仅选项", []string{"--no-pager"}, false},
	}
	for _, tc := range cases {
		if got := isQueuedWriteCommand(tc.args); got != tc.want {
			t.Errorf("%s: isQueuedWriteCommand(%v) = %v, want %v", tc.name, tc.args, got, tc.want)
		}
	}
}

// TestRepoWriteGate_Serializes 门级串行语义：持有方未释放前第二获取方阻塞，
// 释放后立刻轮到（精确断言等待时长）
func TestRepoWriteGate_Serializes(t *testing.T) {
	const key = "wt-gate-serialize"
	release1, err := acquireRepoWriteGate(key, time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	go func() {
		time.Sleep(80 * time.Millisecond)
		release1()
	}()
	start := time.Now()
	release2, err := acquireRepoWriteGate(key, 5*time.Second)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	release2()
	if elapsed < 50*time.Millisecond {
		t.Fatalf("second acquire got slot after %v; expected to wait for release (~80ms)", elapsed)
	}
}

// TestRepoWriteGate_Timeout 门级超时路径：等待上限到达返回 errWriteQueueTimeout，
// 错误含稳定标记（前端 KNOWN_ERROR_I18N 匹配契约）
func TestRepoWriteGate_Timeout(t *testing.T) {
	const key = "wt-gate-timeout"
	release, err := acquireRepoWriteGate(key, time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release()
	_, err = acquireRepoWriteGate(key, 50*time.Millisecond)
	if !errors.Is(err, errWriteQueueTimeout) {
		t.Fatalf("err = %v, want errWriteQueueTimeout", err)
	}
}

// TestExecGitWriteQueue_TimeoutThroughExecGit 经 execGit 的超时路径：门被占用 +
// 短等待上限注入 → 写命令失败且错误含稳定标记（命令未执行的措辞留痕）；
// 释放后同命令成功（入队→执行的闭环）
func TestExecGitWriteQueue_TimeoutThroughExecGit(t *testing.T) {
	dir := initRepo(t)
	old := writeQueueWaitTimeout
	writeQueueWaitTimeout = 200 * time.Millisecond
	t.Cleanup(func() { writeQueueWaitTimeout = old })

	release, err := acquireRepoWriteGate(dir, time.Second)
	if err != nil {
		t.Fatalf("hold gate: %v", err)
	}
	_, err = execGit(dir, "add", ".")
	if !errors.Is(err, errWriteQueueTimeout) {
		t.Fatalf("execGit add under contention: err = %v, want errWriteQueueTimeout", err)
	}
	if !strings.Contains(err.Error(), GitWriteBusyMarker) {
		t.Fatalf("err = %v, want marker %q", err, GitWriteBusyMarker)
	}
	release()

	if _, err := execGit(dir, "add", "."); err != nil {
		t.Fatalf("execGit add after release: %v", err)
	}
}

// TestExecGitWriteQueue_ReadsNotQueued 读类直通：门被占用时 status / stash list
// 照常执行（读不排队——排队只会白白增加延迟）
func TestExecGitWriteQueue_ReadsNotQueued(t *testing.T) {
	dir := initRepo(t)
	release, err := acquireRepoWriteGate(dir, time.Second)
	if err != nil {
		t.Fatalf("hold gate: %v", err)
	}
	defer release()
	if _, err := execGit(dir, "status"); err != nil {
		t.Fatalf("status while gate held: %v", err)
	}
	if _, err := execGit(dir, "stash", "list"); err != nil {
		t.Fatalf("stash list while gate held: %v", err)
	}
}

// TestExecGitWriteQueue_SerializesConcurrentCommits 端到端串行（提案核心场景）：
// 两个并发 commit（pre-commit hook 各睡 400ms）——串行队列下 hook 先后执行，
// 总耗时 ≈ 2×sleep + git 开销；若队列失效则 hook 并发重叠，总耗时 ≈ 1×sleep。
// 同时断言双双成功（无 index.lock 冲突失败）
func TestExecGitWriteQueue_SerializesConcurrentCommits(t *testing.T) {
	dir := initRepo(t)
	if _, err := execGit(dir, "config", "user.name", "t"); err != nil {
		t.Fatalf("config user.name: %v", err)
	}
	if _, err := execGit(dir, "config", "user.email", "t@t"); err != nil {
		t.Fatalf("config user.email: %v", err)
	}
	installSleepyPreCommitHook(t, dir, 400*time.Millisecond)

	const workers = 2
	errs := make([]error, workers)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = execGit(dir, "commit", "--allow-empty", "-m", fmt.Sprintf("c%d", i))
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("commit %d failed: %v", i, err)
		}
	}
	// 串行下界：2×400ms hook + git 进程开销；阈值取 750ms——队列失效时
	// hook 并发（≈400ms+开销）远够不到，慢机只会更慢不会误判
	if elapsed < 750*time.Millisecond {
		t.Fatalf("two concurrent commits finished in %v; expected serialized >= ~2x hook sleep (800ms+), queue may be bypassed", elapsed)
	}
}

// installSleepyPreCommitHook 安装睡 sleep 时长的 pre-commit hook。
// 脚本无 BOM、shebang 起头——git-bash（Windows）与 POSIX sh（Linux）都可直接执行
func installSleepyPreCommitHook(t *testing.T, repo string, sleep time.Duration) {
	t.Helper()
	hooks := filepath.Join(repo, ".git", "hooks")
	if err := os.MkdirAll(hooks, 0o755); err != nil {
		t.Fatalf("mkdir hooks: %v", err)
	}
	script := fmt.Sprintf("#!/bin/sh\nsleep %.3f\n", sleep.Seconds())
	if err := os.WriteFile(filepath.Join(hooks, "pre-commit"), []byte(script), 0o755); err != nil {
		t.Fatalf("write hook: %v", err)
	}
}

// TestExecGitWriteQueue_BranchRenameQueued 经 execGit 的 branch -m 超时路径：
// 门被占用 + 短等待上限注入 → 重命名失败且错误含稳定标记（证明甄别结果在
// 汇流点真实生效，非仅分类表）；释放后同命令成功（入队→执行的闭环）
func TestExecGitWriteQueue_BranchRenameQueued(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "commit", "--allow-empty", "-m", "c1")
	runGit(t, dir, "branch", "feature/x")

	old := writeQueueWaitTimeout
	writeQueueWaitTimeout = 200 * time.Millisecond
	t.Cleanup(func() { writeQueueWaitTimeout = old })

	release, err := acquireRepoWriteGate(dir, time.Second)
	if err != nil {
		t.Fatalf("hold gate: %v", err)
	}
	if _, err := execGit(dir, "branch", "-m", "feature/x", "feature/y"); !errors.Is(err, errWriteQueueTimeout) {
		t.Fatalf("branch -m under contention: err = %v, want errWriteQueueTimeout", err)
	} else if !strings.Contains(err.Error(), GitWriteBusyMarker) {
		t.Fatalf("err = %v, want marker %q", err, GitWriteBusyMarker)
	}
	release()

	if err := RenameBranch(dir, "feature/x", "feature/y"); err != nil {
		t.Fatalf("RenameBranch after release: %v", err)
	}
}

// TestInvalidateRepoWriteQueue 清理语义：旧槽位仍被持有时清理该路径，新获取方
// 拿到的是重建后的新门（立即可用）——防泄漏同时不留死锁窗口；旧释放函数幂等
// 安全。空路径调用为无害 no-op
func TestInvalidateRepoWriteQueue(t *testing.T) {
	const key = "wt-invalidate-path"
	release, err := acquireRepoWriteGate(key, time.Second)
	if err != nil {
		t.Fatalf("hold gate: %v", err)
	}
	InvalidateRepoWriteQueue(key)
	release2, err := acquireRepoWriteGate(key, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("acquire after invalidate should get a fresh gate immediately: %v", err)
	}
	release()
	release2()
	InvalidateRepoWriteQueue("")
}
