//go:build !windows

// Package servicectx 服务上下文探测与重启意图（P-20261106 页面重启链）——
// 非 Windows 平台恒非服务形态（Linux systemd / macOS launchd 经 update 包的
// systemdUnit / ppid 探测走各自重启链），API 与 Windows 侧保持同形
package servicectx

// IsService 非 Windows 平台恒非 SCM 服务形态
func IsService() bool { return false }

// RequestRestart 非 Windows 无 SCM 恢复链，空实现
func RequestRestart() {}

// ServiceExitCode 非 Windows 无服务退出码语义，恒 0
func ServiceExitCode() uint32 { return 0 }
