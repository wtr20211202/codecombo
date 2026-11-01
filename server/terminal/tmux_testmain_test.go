//go:build !windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"testing"
)

// TestMain 并行门禁 socket 隔离：每个测试二进制一枚专属 tmux socket。
//
// 动机（实测互踩）：本包所有测试会话的 projectId 为空 → tmux 会话名哈希恒为
// sc-e3b0c442-*（空串 SHA-256 前缀）；socket 共享时，任一二进制的
// TestModuleConformance→Start→RecoverSessions 按自己的空 store 反查项目，
// 把这些会话全部判孤儿 kill-session——同仓多包并行、多 worktree 并行 WSL
// 门禁下，对方存活中的真实 PTY 等待面测试帧流随机中断（framesSeen=true 但
// D 永不再来 / 首帧不来），表现为偶发失败。per-PID socket 后各二进制的
// 清扫只作用于自己的会话（同二进制内测试串行，无互踩窗口）。
//
// 退出时 kill-server：per-PID socket 的 tmux server 是守护进程，测试二进制
// 退出后残留会话/服务器进程；产品语义（持久化跨重启恢复）不在测试面内，
// 测试收尾整炉清掉，不留 /tmp/tmux-0/simple-coding-test-* 垃圾
func TestMain(m *testing.M) {
	tmuxSocketName = fmt.Sprintf("simple-coding-test-%d", os.Getpid())
	code := m.Run()
	_ = exec.Command("tmux", "-L", tmuxSocketName, "kill-server").Run()
	os.Exit(code)
}
