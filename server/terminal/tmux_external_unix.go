//go:build !windows

package terminal

import (
	"fmt"
	"strings"
)

// 外部会话面的 tmux 执行（unix）：列举走用户默认 socket（无 -L 前缀），
// 自建会话住专属 socket，两平面互不可见——这正是「外部」的判定边界

// tmuxExternalFormat tmux list-sessions 的取数字段（\t 分隔，parseExternalTmuxSessions 消费）
const tmuxExternalFormat = "#{session_name}\t#{session_attached}\t#{session_created}\t#{session_windows}\t#{session_activity}"

// ListExternalTmuxSessions 列举用户默认 socket 上的 tmux 会话（即外部会话集）。
// 自建会话住专属 socket 天然不在列——「过滤本项目命名前缀」在双 socket 现实下
// 的等价实现是「另一 socket 整体排除」，无需按名过滤；已接管的会话以 TakenOver
// 标记如实回告（置灰防重复 attach，不隐藏——接管中的会话仍属外部面）。
// tmux 不可用返回错误（HTTP 层转 available:false）；默认 socket 上无运行中的
// server 属正常情况返回空集
func ListExternalTmuxSessions() ([]ExternalTmuxSession, error) {
	if !isTmuxAvailable() {
		return nil, fmt.Errorf("tmux not available")
	}
	out, err := runTmuxDefaultSocket("list-sessions", "-F", tmuxExternalFormat)
	if err != nil {
		// tmux 未装/默认 socket 无 server 都按空集处理；其余错误如实上抛
		if strings.Contains(err.Error(), "no server running") || strings.Contains(err.Error(), "no such file or directory") {
			return []ExternalTmuxSession{}, nil
		}
		return nil, err
	}
	sessions := parseExternalTmuxSessions(string(out))
	for i := range sessions {
		sessions[i].TakenOver = DefaultManager.GetSession(sessions[i].Name) != nil
	}
	return sessions, nil
}

// externalTmuxPanePath 探测外部会话当前工作目录（display-message
// pane_current_path，recover.go 恢复 agent 会话同款探测）：接管会话的展示
// 路径/产出兜底。best-effort——失败返回空串（展示端空显不虚构）
func externalTmuxPanePath(name string) string {
	out, err := runTmuxDefaultSocket("display-message", "-p", "-t", name, "#{pane_current_path}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
