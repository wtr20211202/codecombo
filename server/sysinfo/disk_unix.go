//go:build !windows

package sysinfo

import (
	"os"
	"syscall"
)

// Usage 采集 path 所在文件系统卷的容量水位（Unix：statfs）。
// Free 取 Bfree（含特权保留），Avail 取 Bavail（非特权可写），与 df 同源
func Usage(path string) (DiskUsage, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return DiskUsage{}, err
	}
	bsize := uint64(stat.Bsize)
	return DiskUsage{
		Total: uint64(stat.Blocks) * bsize,
		Free:  uint64(stat.Bfree) * bsize,
		Avail: uint64(stat.Bavail) * bsize,
	}, nil
}

// SameVolume 判定两路径是否在同一文件系统卷（Unix：比较 stat 设备号 dev——
// 精确到挂载点，绑定挂载/独立分区均不会误判同卷）。任一路径 stat 失败
// 返回 false（按异卷处理：展示面最多多一条，不会错误隐藏）
func SameVolume(a, b string) bool {
	da, err := deviceID(a)
	if err != nil {
		return false
	}
	db, err := deviceID(b)
	if err != nil {
		return false
	}
	return da == db
}

func deviceID(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, os.ErrInvalid
	}
	return uint64(st.Dev), nil
}
