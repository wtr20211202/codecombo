//go:build windows

package git

import (
	"os/exec"
	"strconv"
	"syscall"
)

// platformProcessGroup windows：无需进程组设置——killProcessTree 经
// taskkill /T（tree）终止整棵进程树（git 派生的 ssh/credential-manager 等）
func setProcessGroup(cmd *exec.Cmd) {
	_ = cmd // windows 无对应 SysProcAttr 需求，占位保持调用形态对称
}

// killProcessTree 终止子进程及其全部后代（taskkill /T /F）。
// git for Windows 的网络操作会派生 ssh-askpass / git-credential-manager 等
// 子进程，Process.Kill() 只杀 git 本体会留孤儿子进程持有凭据管道。
// taskkill 不可用（极端精简环境）时退回单进程 Kill；
// 进程已退出（Timeout 与 Run 完成竞态）时静默忽略错误
func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	killer := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	// CREATE_NO_WINDOW：服务进程无控制台，避免超时清理路径弹出终端窗口
	killer.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := killer.Run(); err != nil {
		_ = cmd.Process.Kill() // 退回：至少杀 git 本体
	}
}
