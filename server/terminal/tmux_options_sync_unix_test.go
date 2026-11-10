//go:build !windows

package terminal

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestTmuxRuntimeSyncClipboardAndMouse（P-20261109-7 A②运行同步+C 热切换的真实
// tmux 断言，专有 per-PID 测试 socket）：真实 server 上验证三件事——
//  1. 托管 conf 启动的 server：set-clipboard=on（server option 全局生效）与
//     mouse=on（conf 行）；
//  2. syncTmuxServerOptions 运行同步：conf 之后翻 mouse off → show-options -g
//     mouse=off（热切换即时生效——mouse 逐事件读取的语义基座）；
//     set-clipboard 恒重新置 on（幂等，不随 mouse 翻转漂移）；
//  3. history-limit 运行同步仍生效（既有语义不回归）。
//
// tmux 不可用环境 skip（与 serverreadonly_ext_unix_test 同款门控）。
func TestTmuxRuntimeSyncClipboardAndMouse(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	// 真实 server + 托管 conf：conf 由 tmuxConfContent 物化（与产品同源），
	// 经临时文件喂给 -f，new-session 首命令即拉起 server（读 conf）
	name := "sc-optsync0000-t1"
	confPath := writeTempTmuxConf(t, tmuxConfContent(10000, true))
	if _, err := runTmuxWithConf(confPath, "new-session", "-d", "-s", name); err != nil {
		t.Fatalf("new-session with conf: %v", err)
	}
	t.Cleanup(func() { _, _ = runTmux("kill-session", "-t", name) })

	// ① conf 启动的 server：set-clipboard on（server option）/ mouse on（conf 行）
	assertTmuxOption(t, "-s", "set-clipboard", "on")
	assertTmuxOption(t, "-g", "mouse", "on")

	// ② 运行同步热切换：mouse off 即刻生效；set-clipboard 幂等回 on
	syncTmuxServerOptions(10000, false)
	assertTmuxOption(t, "-g", "mouse", "off")
	assertTmuxOption(t, "-s", "set-clipboard", "on")

	// ③ history-limit 运行同步（server option，与 backend 运行同步同一 -s 口径）：
	// 换值同步即生效——既有语义不回归；mouse 随同切回 on
	syncTmuxServerOptions(12345, false)
	assertTmuxOption(t, "-s", "history-limit", "12345")
	syncTmuxServerOptions(12345, true)
	assertTmuxOption(t, "-g", "mouse", "on")
}

// assertTmuxOption 断言 tmux 选项值等于期望：runTmux("show-options", scope,
// name)（show-options 只收选项名一个参数，期望值绝不能进命令行——否则
// "too many arguments (need at most 1)"）；输出形如 "name value"，取末段比对。
// scope：set-clipboard/history-limit 是 server option 用 -s，mouse 是全局
// session option 用 -g
func assertTmuxOption(t *testing.T, scope, name, want string) {
	t.Helper()
	out, err := runTmux("show-options", scope, name)
	if err != nil {
		t.Fatalf("runTmux show-options %s %s: %v", scope, name, err)
	}
	got := strings.TrimSpace(string(out))
	parts := strings.Fields(got)
	if len(parts) < 2 {
		t.Fatalf("tmux show-options %s %s: unexpected output %q (want \"name value\")", scope, name, got)
	}
	if parts[len(parts)-1] != want {
		t.Fatalf("tmux option %s = %q, want %q", name, got, want)
	}
}

// writeTempTmuxConf 写临时 conf 文件（测试专用，t.TempDir 自动清理）
func writeTempTmuxConf(t *testing.T, content string) string {
	t.Helper()
	path := t.TempDir() + "/tmux.conf"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write conf: %v", err)
	}
	return path
}
