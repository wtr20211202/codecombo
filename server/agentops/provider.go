package agentops

import (
	"sync"
)

// Provider 一种 Agent 运行时的接入实现（终端 TUI 承接形态）。
//
// 契约：InteractiveCommand 返回服务端常量命令（不含用户输入），由调用方经
// PTY 注入 shell 执行；认证凭据由终端管理器统一经环境变量注入
//（CC_BASE_URL / CC_LOCK_TOKEN），不出现在进程列表。
type Provider interface {
	// Name 运行时名称（日志/选型展示/设置选项来源）
	Name() string
	// Available 是否可用（CLI 在 PATH 等）；不可用的提供者自动跳过
	Available() bool
	// InteractiveCommand 返回交互模式启动命令（智能体终端会话用）。
	// ok=false 表示该运行时不支持终端交互形态
	InteractiveCommand() (command string, ok bool)
}

var (
	providerMu sync.RWMutex
	providers  []Provider
)

// RegisterProvider 追加注册一个 Agent 运行时（注册顺序即选型优先级）。
// 相同 Name 的后注册者覆盖先注册者（保持原优先级位次）
func RegisterProvider(p Provider) {
	providerMu.Lock()
	defer providerMu.Unlock()
	for i, existing := range providers {
		if existing.Name() == p.Name() {
			providers[i] = p
			return
		}
	}
	providers = append(providers, p)
}

// SelectProvider 按注册顺序返回第一个可用的 Provider；全部不可用返回 nil
func SelectProvider() Provider {
	providerMu.RLock()
	defer providerMu.RUnlock()
	for _, p := range providers {
		if p.Available() {
			return p
		}
	}
	return nil
}

// SelectProviderByName 按名称选择 Provider；name 为空或 "auto" 时等价 SelectProvider。
// 指定名称不存在或不可用时回退 auto（用户配置先于环境消失的运行时仍可正常使用）
func SelectProviderByName(name string) Provider {
	if name != "" && name != "auto" {
		providerMu.RLock()
		for _, p := range providers {
			if p.Name() == name {
				providerMu.RUnlock()
				if p.Available() {
					return p
				}
				break // 指定的运行时当前不可用 → 回退 auto
			}
		}
	}
	return SelectProvider()
}

// Providers 返回已注册 Provider 名称快照（诊断用）
func ProviderNames() []string {
	providerMu.RLock()
	defer providerMu.RUnlock()
	out := make([]string, 0, len(providers))
	for _, p := range providers {
		out = append(out, p.Name())
	}
	return out
}

// RuntimeInfo 单个运行时的对外描述（设置/会话创建对话框的选项清单用）
type RuntimeInfo struct {
	// Name 运行时注册名
	Name string `json:"name"`
	// Available CLI 是否在环境中可用（PATH 探测）
	Available bool `json:"available"`
	// DefaultCommand 交互模式官方默认启动命令（服务端常量）；
	// ok=false 表示该运行时不支持终端交互形态
	DefaultCommand string `json:"defaultCommand"`
}

// Runtimes 返回全部已注册运行时的描述快照（注册顺序）
func Runtimes() []RuntimeInfo {
	providerMu.RLock()
	defer providerMu.RUnlock()
	out := make([]RuntimeInfo, 0, len(providers))
	for _, p := range providers {
		info := RuntimeInfo{Name: p.Name(), Available: p.Available()}
		if cmd, ok := p.InteractiveCommand(); ok {
			info.DefaultCommand = cmd
		}
		out = append(out, info)
	}
	return out
}

// IsRegisteredProvider 名称是否已注册（设置白名单校验用，与可用性无关）
func IsRegisteredProvider(name string) bool {
	providerMu.RLock()
	defer providerMu.RUnlock()
	for _, p := range providers {
		if p.Name() == name {
			return true
		}
	}
	return false
}

// InteractiveLaunchCommand 智能体终端启动命令选型：按用户设置（providerName，
// auto/claude/dsh/codex/自定义注册名）选择可用运行时并取其交互启动命令。
// 无可用运行时或所选运行时不支持交互形态时 ok=false
func InteractiveLaunchCommand(providerName string) (runtimeName, command string, ok bool) {
	p := SelectProviderByName(providerName)
	if p == nil {
		return "", "", false
	}
	cmd, ok := p.InteractiveCommand()
	if !ok {
		return "", "", false
	}
	return p.Name(), cmd, true
}
