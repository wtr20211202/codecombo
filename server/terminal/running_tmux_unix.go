//go:build !windows

package terminal

import "strings"

// probeTmuxRunning tmux 前台探测：pane_current_command 是 pane 前台进程组的
// 进程名（tmux 自身监听 tty 前台组）。任一存活 pane 的前台命令非 shell 即
// "有任务在跑"（split 多 pane 任意一个在跑都算）
func (s *Session) probeTmuxRunning() (bool, bool) {
	s.mu.Lock()
	spec := s.spec
	s.mu.Unlock()
	if spec.TmuxName == "" {
		return false, false
	}
	// socket 按 spec 分流（runTmuxFor）：外部接管会话在用户默认 socket 上
	out, err := runTmuxFor(spec, "list-panes", "-t", spec.TmuxName, "-F", "#{pane_dead}\t#{pane_current_command}")
	if err != nil {
		// 会话可能刚被外部 kill：按不可判定处理而非空闲
		return false, false
	}
	anyAlive := false
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) != 2 || f[0] == "1" {
			continue // dead pane
		}
		anyAlive = true
		if !isShellProc(f[1]) {
			return true, true
		}
	}
	if !anyAlive {
		return false, false
	}
	return false, true
}
