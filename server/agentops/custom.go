package agentops

import (
	"strings"

	"codecombo/server/config"
	"codecombo/server/userbin"
)

// 用户自定义智能体运行时接入：用户在设置里为任意 CLI 智能体工具（gemini/
// aider/qwen-code 等）自取注册名 + 启动命令，经 SyncCustomAgents 动态注册，
// 与内置运行时（providers_builtin.go）走同一条选型/白名单/清单链路。
// 与内置 init() 静态注册的差异仅在生命周期——设置增删改时整体换血，见
// SyncCustomAgents；customProvider 值类型同时充当注册表中的"自定义段"标记。

// CustomProvider 用户自定义智能体运行时（经 NewCustomProvider 构造；
// 值类型断言用于在注册表中识别自定义段）
type CustomProvider struct {
	runtimeName string
	command     string
}

// NewCustomProvider 构造自定义运行时（name/command 已由设置入口校验非空）
func NewCustomProvider(name, command string) CustomProvider {
	return CustomProvider{runtimeName: name, command: command}
}

func (p CustomProvider) Name() string { return p.runtimeName }

// Available 首词二进制探测：命令行可带参数（如 `aider --model x`），
// 整串无法作为可执行文件探测，约定首词为二进制名。探测走 userbin（禁止裸
// LookPath，守护进程 PATH 不含用户级工具链）——探测不到不阻断使用，与
// 前端「探测不可用不禁用」口径一致：resolveAgentLaunch 对显式名 + 配置命令
// 跳过可用性门控按原样启动
func (p CustomProvider) Available() bool {
	return userbin.Available(CustomBinName(p.command))
}

// InteractiveCommand 返回用户配置的启动命令行（经 PTY 注入 shell 执行，
// 与手敲等价——安全口径同 AgentLaunchCommands）
func (p CustomProvider) InteractiveCommand() (string, bool) { return p.command, true }

// CustomBinName 取命令行首词（二进制名）：可用性探测与版本探测共用此约定
func CustomBinName(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// SyncCustomAgents 以配置中的自定义智能体整体替换注册表中的自定义段
// （内置注册不受影响）。同步后 IsRegisteredProvider / Runtimes / 选型 /
// 设置白名单即刻生效，无需重启。空 name/command 的条目跳过（脏数据防御）
func SyncCustomAgents(defs []config.CustomAgent) {
	providerMu.Lock()
	defer providerMu.Unlock()
	kept := make([]Provider, 0, len(providers)+len(defs))
	for _, p := range providers {
		if _, isCustom := p.(CustomProvider); isCustom {
			continue
		}
		kept = append(kept, p)
	}
	for _, d := range defs {
		name, cmd := strings.TrimSpace(d.Name), strings.TrimSpace(d.Command)
		if name == "" || cmd == "" {
			continue
		}
		kept = append(kept, NewCustomProvider(name, cmd))
	}
	providers = kept
}
