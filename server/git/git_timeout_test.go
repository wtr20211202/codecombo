package git

import (
	"os/exec"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func TestClassifyGitTimeout(t *testing.T) {
	// store 未装配：网络/重操作档回落默认 15 分钟
	store.SetDefault(nil)

	readCases := [][]string{
		{"status", "--porcelain"},
		{"log", "-10", "--oneline"},
		{"diff", "HEAD~1", "--", "a.go"},
		{"blame", "-L", "1,5", "main.go"},
		{"rev-parse", "HEAD"},
		{"for-each-ref", "--format=%(refname)"},
		{"grep", "-n", "todo"},
		{"ls-files", "-m"},
		{"cat-file", "-p", "HEAD"},
		{"merge-base", "a", "b"},
		{"-C", "/tmp/x", "status"},       // 全局 flag 带值后跟动词
		{"stash", "list"},                // 带子命令的动词：白名单子命令
		{"stash", "show", "stash@{0}"},   //
		{"remote", "-v"},                 // flag 形态子命令
		{"remote", "get-url", "origin"},  //
		{"config", "--get", "user.name"}, //
	}
	for _, args := range readCases {
		if got := classifyGitTimeout(args); got != gitReadTimeout {
			t.Errorf("classify(%v) = %v, want read timeout %v", args, got, gitReadTimeout)
		}
	}

	networkCases := [][]string{
		{"fetch", "--all", "--prune"},
		{"push", "origin", "main"},
		{"pull", "--rebase"},
		{"merge", "feature"},
		{"rebase", "-i", "HEAD~3"},
		{"lfs", "pull"},
		{"clone", "https://x"}, // 理论不经此处（stream.go），保守归网络档
		{"reset", "--hard", "HEAD~1"},
		{"add", "-A"},
		{"commit", "-m", "msg"},
		{"stash", "pop"},            // 非白名单子命令 → 保守网络档
		{"remote", "add", "o", "u"}, //
		{"branch", "-D", "x"},       // 写操作 → 网络档
	}
	for _, args := range networkCases {
		if got := classifyGitTimeout(args); got != gitNetworkTimeoutFallback {
			t.Errorf("classify(%v) = %v, want network fallback %v", args, got, gitNetworkTimeoutFallback)
		}
	}
}

func TestGitNetworkTimeoutFromSettings(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 未配置 → 默认
	if got := gitNetworkTimeout(); got != gitNetworkTimeoutFallback {
		t.Fatalf("unset → fallback, got %v", got)
	}

	// 配置 3600s → 即时生效
	cfg := store.Get().Settings.Get()
	cfg.Server.GitNetworkTimeoutSec = 3600
	if got := gitNetworkTimeout(); got != time.Hour {
		t.Fatalf("3600s → 1h, got %v", got)
	}

	// 过小值 → 下限钳制
	cfg.Server.GitNetworkTimeoutSec = 1
	if got := gitNetworkTimeout(); got != gitNetworkTimeoutMin {
		t.Fatalf("1s → min clamp, got %v", got)
	}
}

func TestRunWithTimeout(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skip("sleep 不可用，跳过（CI 无 Unix shell 环境）")
	}

	// 正常完成：不超时，输出正确
	cmd := exec.Command("sleep", "0.01")
	if err := runWithTimeout(cmd, 5*time.Second); err != nil {
		t.Fatalf("正常命令不应报错: %v", err)
	}

	// 超时：返回超时错误（进程组整组清理在 unix 下由 OS 保证，
	// 进程消亡本身由 <-done 同步等待覆盖——Run 退出前不返回）
	cmd2 := exec.Command("sleep", "30")
	start := time.Now()
	err := runWithTimeout(cmd2, 200*time.Millisecond)
	if err == nil {
		t.Fatal("超时命令应返回错误")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("超时后应立即返回，实际耗时 %v（进程树清理未生效）", elapsed)
	}
}
