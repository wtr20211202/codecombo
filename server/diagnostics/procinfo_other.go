//go:build !linux

package diagnostics

// 非 Linux 的 /proc 采集占位（Windows/macOS 没有 /proc，host.json 显式
// skipped；保留 this 编译单元只为让 hostinfo.go 的调用点在所有平台可编译）

// collectProcHost 非 Linux 无 /proc：不做任何采集
func collectProcHost(info *HostInfo, dataDir string, roots []string, red *Redactor) {}
