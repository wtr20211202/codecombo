//go:build !linux

package diagnostics

// 非 Linux 无 /proc/net：接口清单/代理面仍由 netinfo.go 采集（字段级缺席
// 说明写在 Notes），这里只给编译占位
func collectProcNet(info *NetInfo) {}
