//go:build windows

package filestore

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockFD 对锁文件首字节加排他锁（LockFileEx 阻塞语义，等价 unix flock LOCK_EX）。
// 跨进程互斥见 lock.go 注释
func lockFD(f *os.File) error {
	return windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0,
		&windows.Overlapped{},
	)
}

// unlockFD 释放 lockFD 加的锁
func unlockFD(f *os.File) error {
	return windows.UnlockFileEx(
		windows.Handle(f.Fd()), 0, 1, 0,
		&windows.Overlapped{},
	)
}
