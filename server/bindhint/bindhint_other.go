//go:build !windows

package bindhint

// forPlatform 非 Windows：保持原始错误不加提示
//（unix 侧 EADDRINUSE 语义单一，错误文本已足够定位）
func forPlatform(err error, port int) string { return "" }
