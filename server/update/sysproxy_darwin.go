//go:build darwin

package update

import "context"

// scutilPath macOS 基础系统自带路径；绝对路径免 PATH 依赖（launchd 服务环境 PATH
// 精简）
const scutilPath = "/usr/sbin/scutil"

// platformSysProxyProbe macOS：scutil --proxy 读 SystemConfiguration 当前生效的代理
// 字典（只读查询；「系统设置 → 网络 → 代理」与 Clash 类工具设置的同源）。解析/
// 档序/归一在 sysproxy.go 平台无关实现
func platformSysProxyProbe() sysProxyProbe {
	return scutilProbe(func(ctx context.Context) ([]byte, error) {
		return runProbeCommand(ctx, scutilPath, "--proxy")
	})
}
