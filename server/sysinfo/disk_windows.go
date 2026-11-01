//go:build windows

package sysinfo

import (
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// Usage 采集 path 所在文件系统卷的容量水位（Windows：GetDiskFreeSpaceEx，
// 三个出参一次取全——total 参数非空即得总容量，无需换 API）
func Usage(path string) (DiskUsage, error) {
	pathPtr, _ := syscall.UTF16PtrFromString(path)
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(pathPtr, &avail, &total, &free); err != nil {
		return DiskUsage{}, err
	}
	return DiskUsage{Total: total, Free: free, Avail: avail}, nil
}

// SameVolume 判定两路径是否在同一文件系统卷（Windows：比较卷根——盘符
// 不分大小写，UNC 比较到共享名）。纯字符串解析、不校验存在性：报告面
// 以 Usage 成功为准，不存在路径到不了这里。任一路径解析不出卷根
//（如 Unix 风格相对路径）返回 false——按异卷处理：展示面最多多一条，
// 不会错误隐藏
func SameVolume(a, b string) bool {
	va, ok := volumeRoot(a)
	if !ok {
		return false
	}
	vb, ok := volumeRoot(b)
	if !ok {
		return false
	}
	return strings.EqualFold(va, vb)
}

func volumeRoot(path string) (string, bool) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	vol := filepath.VolumeName(abs)
	if vol == "" {
		return "", false
	}
	return vol, true
}
