//go:build windows

package main

// Windows 服务协议支持（P-20261103-4）：Go 程序作为 Windows 服务运行必须与
// SCM（服务控制管理器）对话上报状态并响应停止请求——裸 --serve 前台进程被
// sc.exe 注册后启动必然 1053（30 秒内无状态上报，用户机器实锚）。
//
// 链路：install.ps1 注册服务（binPath= codecombo.exe --serve ...）→ SCM 启动
// 进程 → main --serve 分支检测服务上下文 → runWindowsService(svc.Run) →
// handler 内 goroutine 执行真实 serve → SCM stop 请求经 signalCh 注入
// SIGTERM 走 app.Run 既有优雅退出（与 Ctrl+C/SIGTERM 同路径）。

import (
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"
)

// svcStopGrace 停止宽限：优雅退出超时后 Execute 返回由 SCM 决定强杀
var svcStopGrace = 10 * time.Second

// signalCh 写端引用：proc_windows.go setupSignalNotify 的实际通道
//（包内共享，main 注册 SIGINT/SIGTERM 后 handler 借此注入停止信号）
var signalCh = make(chan os.Signal, 1)

// isWindowsService 当前进程是否由 Windows SCM 启动（服务上下文）
func isWindowsService() bool {
	v, _ := svc.IsWindowsService()
	return v
}

// runWindowsService 以服务形态运行 serve（阻塞至服务停止）
func runWindowsService(serve func()) error {
	return svc.Run("Codecombo", &comboService{serve: serve})
}

// comboService svc.Handler：serve goroutine + SCM 状态机
type comboService struct {
	serve func()
}

// Execute 实现 svc.Handler。第二返回值是服务特定退出码（exitCode uint32）；
// 退出约定：返回即服务结束（app.Run 经 signalCh 注入 SIGTERM 优雅退出后自然
// 返回；进程被外界硬杀时本函数不可达）
func (s *comboService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	done := make(chan struct{})
	go func() {
		s.serve()
		close(done)
	}()

	changes <- svc.Status{State: svc.Running, Accepts: accepts}
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			// SCM 探询：回当前状态（必须响应，否则服务管理器报错）
			changes <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			// 注入 SIGTERM 走 app.Run 既有优雅退出；双向 chan 由
			// proc_windows.go setupSignalNotify 持有写端
			signalCh <- syscall.SIGTERM
			select {
			case <-done:
			case <-time.After(svcStopGrace):
			}
			return false, 0
		}
	}
	return false, 0
}

// svcStopGrace 停止宽限：优雅退出超时后 Execute 返回由 SCM 决定强杀
