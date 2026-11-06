//go:build windows

// Package servicectx 服务上下文探测与重启意图（P-20261106 页面重启链）。
// 独立成包的原因：main（windows_service.go）、server/app（重启动作装配）、
// server/api/system（重启端点）三方都要读，且不能互相依赖。
package servicectx

import (
	"sync/atomic"

	"golang.org/x/sys/windows/svc"
)

var restartRequested atomic.Bool

// IsService 当前进程是否由 Windows SCM 启动（服务上下文）
func IsService() bool {
	v, _ := svc.IsWindowsService()
	return v
}

// RequestRestart 标记重启意图：服务以非零码结束后 SCM failure-recovery
//（install.ps1 的 sc failure actions=restart/5000）在 5s 内拉起新进程——
// 服务形态的「页面重启」走这条链，不自 spawn（SCM 之外的孤儿进程会与
// 恢复的服务抢端口）
func RequestRestart() { restartRequested.Store(true) }

// ServiceExitCode 服务结束退出码：带重启意图=1（SCM 判 failure → recovery
// restart）；正常停止（sc stop）=0（SCM 不拉起）
func ServiceExitCode() uint32 {
	if restartRequested.Load() {
		return 1
	}
	return 0
}
