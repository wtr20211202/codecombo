// Package sysinfo 本机系统信息采集小包：磁盘容量水位等与业务无关的
// 只读观测面。从 update 包的更新前空间预检提升而来（P-20261002-12）——
// 更新预检与系统监控两域共用同一采集口，避免各持一份平台分支。
package sysinfo

// DiskUsage 单个文件系统卷的容量水位。三个字段来自同一次采集调用，
// 分别服务两类口径：
//   - 展示面（监控面板水位条）：Used/UsedPercent 基于 Total-Free，
//     与 df / 资源管理器一致；
//   - 写盘预检（更新包下载前）：Avail 是非特权进程实际可写空间
//     （Unix Bavail / Windows 配额感知），比 Free 保守，沿用原
//     update.diskFree 语义。
type DiskUsage struct {
	Total uint64 // 卷总容量（字节）
	Free  uint64 // 总空闲（字节；含特权保留块，展示口径）
	Avail uint64 // 非特权进程可写空间（字节；写盘预检口径）
}

// Used 已用容量（展示口径：Total-Free）
func (d DiskUsage) Used() uint64 { return d.Total - d.Free }

// UsedPercent 已用百分比（0~100；Total 为 0 时返回 0，避免除零）
func (d DiskUsage) UsedPercent() float64 {
	if d.Total == 0 {
		return 0
	}
	return float64(d.Used()) / float64(d.Total) * 100
}
