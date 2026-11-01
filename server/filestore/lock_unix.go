//go:build !windows

package filestore

import (
	"os"

	"golang.org/x/sys/unix"
)

// lockFD 对锁文件加排他 flock（阻塞语义）。跨进程互斥见 lock.go 注释
func lockFD(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX)
}

// unlockFD 释放 lockFD 加的锁
func unlockFD(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}
