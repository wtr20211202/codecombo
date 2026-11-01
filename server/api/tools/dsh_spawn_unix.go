//go:build !windows

package tools

import "syscall"

// dshSysProcAttr 一键启动子进程的脱离属性：Setsid 使 dsh 独立成新会话，
// 终端关闭/SC 退出的 SIGHUP 不再波及——nohup 语义（后台存活的前提）
func dshSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
