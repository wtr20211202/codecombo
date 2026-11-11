//go:build linux

package update

import "context"

// platformSysProxyProbe Linux：GNOME gsettings 尽力而为——单次 list-recursively 取
// org.gnome.system.proxy 及其 http/https/socks 子 schema 全部键（逐键 get 需多次
// fork），只读查询。无桌面服务器 / KDE 等无此 schema 或无 gsettings → 探测失败静默
// 落下一档；以系统服务账户运行时读的是该账户的 dconf 而非桌面用户的（诚实边界）。
// 解析/档序/归一在 sysproxy.go 平台无关实现
func platformSysProxyProbe() sysProxyProbe {
	return gsettingsProbe(func(ctx context.Context) ([]byte, error) {
		return runProbeCommand(ctx, "gsettings", "list-recursively", gnomeProxySchema)
	})
}
