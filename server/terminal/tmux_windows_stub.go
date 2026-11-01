//go:build windows

package terminal

import "fmt"

// Windows 平台不支持 tmux（ConPTY 走 native 路径）
// 以下 stub 让 ResolveBackend/NewBackend/computeTmuxSessionName 在 Windows 下编译通过并走 native

func isTmuxAvailable() bool {
	return false
}

// IsTmuxAvailable 公开 wrapper（Windows 平台始终返回 false）
func IsTmuxAvailable() bool {
	return false
}

// TmuxInfo 跨平台结构（Windows 用同样的 JSON 结构返回给前端）
type TmuxInfo struct {
	Available      bool   `json:"available"`
	Version        string `json:"version"`
	Path           string `json:"path"`
	Required       string `json:"required"`
	Installable    bool   `json:"installable"`
	PkgManager     string `json:"pkgManager"`
	InstallCommand string `json:"installCommand"`
}

// GetTmuxInfo Windows 平台：tmux 永远不可用，无包管理器
func GetTmuxInfo() TmuxInfo {
	return TmuxInfo{
		Available: false,
		Required:  "3.3+ (Unix only)",
	}
}

// InstallTmuxResult 跨平台结构（与 Unix 版字段一致）
type InstallTmuxResult struct {
	Success   bool   `json:"success"`
	Command   string `json:"command"`
	Output    string `json:"output"`
	NeedsSudo bool   `json:"needsSudo"`
}

// InstallTmux Windows 平台不支持 tmux
func InstallTmux() (InstallTmuxResult, error) {
	return InstallTmuxResult{}, fmt.Errorf("tmux is not supported on Windows")
}

func newTmuxBackend() PtyBackend {
	// Windows 无 tmux，返回 native backend 兜底
	// 实际上 ResolveBackend 已保证不会走到这里（isTmuxAvailable=false 会 fallback）
	return newNativeBackend()
}

// computeTmuxSessionName Windows 无 tmux，永远返回空字符串
// manager.go 中即使调用此函数，spec.TmuxName 在 native 路径下不会被使用
func computeTmuxSessionName(projectID string) string {
	return ""
}

// parseTmuxSessionName Windows 平台不会执行重启恢复（tmux 不存在）
// 提供 stub 满足编译
func parseTmuxSessionName(name string) (projHash, randID string, ok bool) { //nolint:unused // 平台对等 stub：实现与引用均在 unix 侧（tmux_cmd.go/recover.go）
	return "", "", false
}

// parseTmuxVersion Windows 平台不会调用，提供 stub 满足测试编译
func parseTmuxVersion(s string) (int, int, bool) { //nolint:unused // 平台对等 stub：实现与引用均在 unix 侧（tmux_cmd.go/recover.go）
	return 0, 0, false
}

// ListExternalTmuxSessions Windows stub：tmux 不可用，外部会话面恒为空
// （HTTP 层据错误回 available:false，前端隐藏接管入口）
func ListExternalTmuxSessions() ([]ExternalTmuxSession, error) {
	return nil, fmt.Errorf("tmux is not supported on Windows")
}

// externalTmuxPanePath Windows stub：不可达（接管仅在 tmux 后端可用），返回空串
func externalTmuxPanePath(name string) string { //nolint:unused // 平台对等 stub：实现与引用均在 unix 侧（tmux_external_unix.go）
	return ""
}
