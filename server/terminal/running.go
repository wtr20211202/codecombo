package terminal

// 会话前台活动探测（运行状态事实源）：
// 此前"运行中/空闲"只有前端 OSC 133 事件一种来源，且是纯浏览器内存——
// 刷新/重连后一律显示"空闲"，服务器上明明在跑的 claude code 长任务不可见。
// 本文件让服务端成为事实源：API 层周期调用 ProbeRunning 并在状态变化时经
// terminals.changed 广播；前端重连时以服务端为准同步，OSC 事件只保留
// 即时性价值（探测周期内会被服务端校准）。
// 平台差异：native 后端的前台组探测在 running_unix.go（ioctl）；
// tmux 探测依赖 tmux_cmd（unix），Windows 提供恒不可判定的 stub。

import (
	"path"
	"strings"
	"time"
)

// RunningProbeInterval 前台探测周期 = 状态变化的最大可见延迟。tmux 探测是
// 一次本地 socket 调用（毫秒级）、native 是一次 ioctl，4s 颗粒度足够
const RunningProbeInterval = 4 * time.Second

// shellProcNames 前台命令白名单：这些进程名视为"交互 shell 空闲等待输入"。
// 白名单外的任何前台进程（node=claude、vim、make、ssh…）都算"有任务在跑"
var shellProcNames = map[string]bool{ //nolint:unused // 引用在 running_tmux_unix.go（!windows 构建标签）
	"bash": true, "zsh": true, "sh": true, "ash": true, "dash": true,
	"ksh": true, "fish": true, "csh": true, "tcsh": true,
	"pwsh": true, "powershell": true, "cmd": true, "nu": true,
	"elvish": true, "xonsh": true, "login": true, "screen": true, "tmux": true,
}

// isShellProc 前台命令名是否为 shell（去路径/去 .exe 后缀比较）
func isShellProc(name string) bool { //nolint:unused // 引用在 running_tmux_unix.go（!windows 构建标签）
	name = strings.TrimSuffix(path.Base(strings.TrimSpace(name)), ".exe")
	return shellProcNames[name]
}

// ProbeRunning 探测会话当前是否有前台命令在跑，并缓存结果（RunningState
// 供 snapshot 读取，免重复探测）。返回 (running, known)：known=false 表示
// 此后端无法判定（Windows ConPTY 无前台组概念），调用方保持既有状态
func (s *Session) ProbeRunning() (bool, bool) {
	running, known := s.probeRunningUncached()
	s.mu.Lock()
	s.runningKnown = known
	s.running = running
	s.mu.Unlock()
	return running, known
}

// RunningState 最近一次探测的缓存结果（未探测过 known=false）
func (s *Session) RunningState() (bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running, s.runningKnown
}

func (s *Session) probeRunningUncached() (bool, bool) {
	switch s.Backend {
	case "tmux":
		return s.probeTmuxRunning()
	default:
		s.mu.Lock()
		conn := s.ptmx
		s.mu.Unlock()
		if p, ok := conn.(interface {
			ForegroundRunning() (running, known bool)
		}); ok {
			return p.ForegroundRunning()
		}
		return false, false
	}
}
