//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// setDaemonAttrs 后台守护（cmdStart 派生 --serve 子进程）的 Windows 进程属性：
//   - CREATE_NO_WINDOW：守护进程获得**独立隐藏控制台**——脱离启动它的终端窗口
//     生命周期。仅 CREATE_NEW_PROCESS_GROUP 时守护进程仍挂接父控制台，用户
//     关闭终端窗口（含 Windows Terminal）即向全部挂接进程投递
//     CTRL_CLOSE_EVENT，服务随窗口退出（2026-11-10 实测：可见窗口内 start 后
//     关窗，守护进程 2s 内死于 signal=terminated 优雅停机）——即用户反馈的
//     「带参数 start 好像就是前台了」。隐藏控制台同时让守护进程派生的
//     git/shell 等控制台子进程继承它，不弹新窗口。
//     不用 DETACHED_PROCESS：完全无控制台的进程派生控制台子进程时，每个子
//     进程会各自弹出一个新控制台窗口。
//   - CREATE_NEW_PROCESS_GROUP：脱离父进程组（历史行为，保留）
func setDaemonAttrs(cmd *exec.Cmd) {
	// 0x08000000 = CREATE_NO_WINDOW（syscall 包未定义该常量，与
	// server/git/git_timeout_windows.go / server/api/tools/dsh_spawn_windows.go
	// 同款字面量口径）
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x08000000,
	}
}
