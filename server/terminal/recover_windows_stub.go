//go:build windows

package terminal

// RecoverSessions Windows 平台不支持 tmux，恢复为 no-op
// main.go 不需要感知平台差异
func RecoverSessions() int {
	return 0
}

// HealthCheck Windows 平台无 tmux 持久化 session，health check 为 no-op
func HealthCheck() {}
