package agentops

import (
	"codecombo/server/userbin"
)

// 内置 Agent 运行时接入。新增运行时：实现 Provider 并在本文件（或独立文件）
// init() 中 RegisterProvider 即可，选型（InteractiveLaunchCommand / SelectProviderByName）
// 与设置白名单无需改动。用户自配的自定义运行时走另一条路——settings 里的
// CustomAgents 经 SyncCustomAgents（custom.go）动态注册，无需改代码。
//
// 可用性探测一律走 userbin.Available（禁止裸 exec.LookPath）：服务以守护进程
// 运行时进程 PATH 不含 nvm/用户 npm prefix 等用户级工具链，交互 shell 能跑
// claude/codex 而服务端误报「未安装」的存量问题由此根治——见 userbin 包注释。
//
// 注：headless 会话式运行核心（Run/BuildCommand/stream-json 解析）已随早期
// 会话式 AI 助手移除——本系统定位为管理环境内成熟智能体（终端 TUI 承接），
// 运行时接入面收敛为「交互启动命令 + 可用性探测」。若未来需要 headless
// 形态（定时任务/Webhook 触发），按新需求重新设计接口而非复用历史实现。

// ClaudeProvider Claude Code CLI（终端 TUI；skill 自动发现 ~/.claude/skills）
type ClaudeProvider struct{}

func (ClaudeProvider) Name() string { return "claude" }

func (ClaudeProvider) Available() bool { return userbin.Available("claude") }

// InteractiveCommand 交互模式：原生 TUI（skill 自动发现 ~/.claude/skills，
// 系统回调凭据经环境变量注入），不带 -p 与提示词参数
func (ClaudeProvider) InteractiveCommand() (string, bool) { return "claude", true }

func init() { RegisterProvider(ClaudeProvider{}) }

// DSHProvider dsh CLI（DeepSeek Harness；交互式 terminal 应用）
type DSHProvider struct{}

func (DSHProvider) Name() string { return "dsh" }

func (DSHProvider) Available() bool { return userbin.Available("dsh") }

// InteractiveCommand 交互式 terminal 应用（--resume 仅存在于交互形态）
func (DSHProvider) InteractiveCommand() (string, bool) { return "dsh", true }

// CodexProvider OpenAI Codex CLI（交互式 TUI；指令经 ~/.codex/AGENTS.md 全局注入）
type CodexProvider struct{}

func (CodexProvider) Name() string { return "codex" }

func (CodexProvider) Available() bool { return userbin.Available("codex") }

func (CodexProvider) InteractiveCommand() (string, bool) { return "codex", true }

func init() { RegisterProvider(DSHProvider{}) }

func init() { RegisterProvider(CodexProvider{}) }
