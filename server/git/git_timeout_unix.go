//go:build unix

package git

import (
	"os/exec"
	"syscall"
)

// platformProcessGroup unix：子进程落独立进程组（Setpgid），超时清理时
// 对整组发 SIGKILL——网络操作时 git 派生的 ssh/askpass 子进程一并终止，
// 避免杀父留子。forkExec 成功后 Setpgid 生效，失败路径（进程未启动）由
// killProcessTree 的 nil 判断兜底
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessTree 整组终止子进程（unix：负 PID = 组内全部进程）。
// 进程已退出（Timeout 与 Run 完成竞态）时 Kill 返回错误，静默忽略
func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
