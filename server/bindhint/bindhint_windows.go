//go:build windows

package bindhint

import (
	"errors"
	"fmt"
	"syscall"
)

// wsaEAddrInUse syscall 包未导出该 WSA 常量（10048）
const wsaEAddrInUse syscall.Errno = 10048

// forPlatform Windows 实现：Go 监听套接字带 SO_EXCLUSIVEADDRUSE，
// 他人独占的端口同样报 WSAEACCES——两种高频 bind 失败都给出下一动作
func forPlatform(err error, port int) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.WSAEACCES:
		return fmt.Sprintf("port %d bind refused — find the holder with 'netstat -ano | findstr :%d' (third-party apps like netdisk/VPN TUN services often occupy ports), or it may fall in a Windows reserved range: 'netsh interface ipv4 show excludedportrange protocol=tcp'; free the port or pick another in config.json", port, port)
	case wsaEAddrInUse:
		return fmt.Sprintf("port %d is occupied — find the holder with 'netstat -ano | findstr :%d' and stop it (another Codecombo instance or a third-party app), or pick another port in config.json", port, port)
	}
	return ""
}
