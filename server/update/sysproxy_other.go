//go:build !windows && !darwin && !linux

package update

// platformSysProxyProbe 产品承诺三平台（win/mac/linux）之外的 GOOS（BSD 族等）：
// 无探测实现，入口返回 ErrSystemProxyUnsupported 落下一档——本文件只为这些 GOOS
// 保持可编译
func platformSysProxyProbe() sysProxyProbe {
	return sysProxyProbe{}
}
