package terminal

// 运行状态事实源广播：周期探测每个会话的前台命令状态，与上次相比有变化
// 才广播 terminals.changed。前端刷新/重连时经 ListTerminals 拿到 running
// 基线（服务端为事实源），之后由本广播维持实时；OSC 133 事件继续提供
// 命令开始/结束的即时性与退出码，探测周期内被服务端校准

import (
	"codecombo/server/terminal"
	"time"
)

func init() {
	go probeRunningLoop()
}

func probeRunningLoop() {
	last := map[string]bool{}
	ticker := time.NewTicker(terminal.RunningProbeInterval)
	defer ticker.Stop()
	for range ticker.C {
		sessions := terminal.DefaultManager.ListSessions()
		cur := map[string]bool{}
		for _, s := range sessions {
			if running, known := s.ProbeRunning(); known {
				cur[s.ID] = running
			}
		}
		if !runningMapsEqual(cur, last) {
			broadcastTerminalsChanged()
		}
		last = cur
	}
}

func runningMapsEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}
