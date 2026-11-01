//go:build windows

package terminal

// RefreshAgentCallbackEnv Windows 无 tmux 后端（native 会话不经 tmux 环境
// 注入），令牌轮换/撤销无 tmux 侧刷新动作
func RefreshAgentCallbackEnv() {}
