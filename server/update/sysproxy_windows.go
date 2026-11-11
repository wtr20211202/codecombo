//go:build windows

package update

import (
	"errors"
	"fmt"
	"slices"

	"golang.org/x/sys/windows/registry"
)

// winInetSettingsKey 当前用户 WinINet 代理设置所在键：系统设置「代理」页与 Clash
// 类工具「设置系统代理」写的都是这里
const winInetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

// platformSysProxyProbe Windows：读 HKCU Internet Settings 的 ProxyEnable/ProxyServer
// （解析/档序/归一在 sysproxy.go 平台无关实现）
func platformSysProxyProbe() sysProxyProbe {
	return winInetProbe(readWinInetRegistry)
}

// readWinInetRegistry 以 QUERY_VALUE 只读权限取值（护栏：探测绝不写注册表）。
// 键/值缺省按零值 = 未配置；ProxyEnable 规范类型 REG_DWORD（GetIntegerValue 兼收
// QWORD），写成 REG_BINARY 的也认（任一字节非零即开），其余类型按未启用。
// 诚实边界：以服务账户（LocalSystem）运行时 HKCU 指向服务账户自身 hive，读不到
// 交互用户的代理设置 → 未配置，落下一档
func readWinInetRegistry() (winInetValues, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, winInetSettingsKey, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return winInetValues{}, nil
	}
	if err != nil {
		return winInetValues{}, fmt.Errorf("open Internet Settings registry key: %w", err)
	}
	defer k.Close()

	var v winInetValues
	if n, _, err := k.GetIntegerValue("ProxyEnable"); err == nil {
		v.proxyEnable = n
	} else if b, _, err := k.GetBinaryValue("ProxyEnable"); err == nil &&
		slices.ContainsFunc(b, func(x byte) bool { return x != 0 }) {
		v.proxyEnable = 1
	}
	if s, _, err := k.GetStringValue("ProxyServer"); err == nil {
		v.proxyServer = s
	}
	return v, nil
}
