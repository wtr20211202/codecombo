//go:build !windows

package terminal

import (
	"sync"

	"codecombo/server/store"
)

// agentCallbackVarNames agent 回调环境变量名（会话级注入与全局残留清理共用）。
// P-20261025-1 标识切换：CC_ 正名；SC_ 旧名保留在清理清单一个版本期——旧版本
// 会话里写下的 SC_* 会话级环境不随本服务重启消失，轮换/撤销时必须同名覆盖清理
var agentCallbackVarNames = []string{"CC_BASE_URL", "CC_LOCK_TOKEN", "CC_BASE_URL", "CC_LOCK_TOKEN"}

var scrubLegacyGlobalEnvOnce sync.Once

// scrubLegacyGlobalEnv 清理历史版本遗留的 -g 全局注入（旧版本把回调变量写进
// tmux server 全局环境；tmux server 常驻且其全局环境不随本服务重启重置）。
// 只带变量名无值，不涉及 argv 敏感值问题
func scrubLegacyGlobalEnv() {
	for _, name := range agentCallbackVarNames {
		_, _ = runTmux("set-environment", "-g", "-u", name)
	}
}

// RefreshAgentCallbackEnv 令牌轮换/撤销后刷新全部会话的会话级回调环境：
// -t 逐会话重写当前值（既有会话中新开 pane/window 即拿到新令牌，行为不劣化
// 于旧的全局注入），并清理历史版本的全局残留。下发通道 setTmuxSessionEnv
// 走 0600 临时 conf + source-file，令牌值不落进程 argv。运行中进程的环境
// 无法变更——已在运行的智能体需重开会话才能拿到新令牌（与旧行为一致，前端已提示）
func RefreshAgentCallbackEnv() {
	if store.Get() == nil {
		return
	}
	env := agentCallbackEnv()
	for _, s := range DefaultManager.ListSessions() {
		// 外部接管会话豁免（P-20261005-189）：其 tmux 会话是用户自建的（默认
		// socket），本系统不做任何环境注入——往里写 SC_* 等于向用户会话泄露
		// 长效令牌；且 set-environment 定向专属 socket，同名误伤同样不可接受
		if s.Origin == OriginExternal {
			continue
		}
		setTmuxSessionEnv(s.ID, env)
	}
	scrubLegacyGlobalEnv()
}
