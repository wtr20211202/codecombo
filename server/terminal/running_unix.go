//go:build !windows

package terminal

import (
	"unsafe"

	"golang.org/x/sys/unix"
)

// ForegroundRunning 原生 PTY 前台进程组探测（运行状态事实源，Unix）：
// tcgetpgrp(ptmx) 返回终端当前前台进程组。pty.Start 以 Setsid 启动 shell
// （Close 处注释：子进程为会话首，pgid=pid），交互 shell 空闲等待输入时
// 前台组就是 shell 本身；用户执行任何前台命令（claude code、vim、make…）
// 后前台组切给命令进程——二者不等即视为"有任务在跑"。
// 返回 (running, known)：known=false 表示无法判定（fd 不可用等），调用方
// 保持既有状态不覆盖
func (c *unixPtyConn) ForegroundRunning() (running, known bool) {
	if c.cmd.Process == nil {
		return false, false
	}
	shellPgid := c.cmd.Process.Pid
	// tcgetpgrp：x/sys/unix 的 IoctlGetUint32 便捷封装仅 Linux 提供（darwin 无此
	// 符号，交叉编译 darwin 目标直接 undefined），改走 SYS_IOCTL 原始调用保证
	// linux/darwin 双平台可用；TIOCGPGRP 入参为 int*，失败 errno 非 0
	var fg uint32
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, c.File.Fd(), uintptr(unix.TIOCGPGRP), uintptr(unsafe.Pointer(&fg)))
	if errno != 0 {
		return false, false
	}
	return int(fg) != shellPgid, true
}
