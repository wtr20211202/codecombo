//go:build windows

package terminal

// probeTmuxRunning Windows stub：tmux 后端在 Windows 不可用（ResolveBackend
// 不产出 tmux），此分支实际不可达——恒返回不可判定
func (s *Session) probeTmuxRunning() (bool, bool) {
	return false, false
}
