package filestore

import (
	"testing"
	"time"

	"codecombo/server/store"
)

// 跨实例互斥（同一进程内两个 fileDocStore = 模拟两个进程：flock/LockFileEx
// 按打开的文件句柄冲突，即使同进程不同 fd 也互斥）：A 持锁期间 B 取锁必须
// 阻塞等待，A 释放后 B 才能获得
func TestLockKindDirMutualExclusion(t *testing.T) {
	dir := t.TempDir()
	a := &fileDocStore{dir: dir}
	b := &fileDocStore{dir: dir}

	releaseA := a.lockKindDir("k")
	if releaseA == nil {
		t.Fatal("expected lock acquired")
	}

	acquired := make(chan struct{})
	go func() {
		releaseB := b.lockKindDir("k")
		close(acquired)
		releaseB()
	}()

	select {
	case <-acquired:
		t.Fatal("second instance must block while first holds the lock")
	case <-time.After(150 * time.Millisecond):
		// 阻塞符合预期
	}

	releaseA()
	select {
	case <-acquired:
	case <-time.After(5 * time.Second):
		t.Fatal("second instance must acquire after release")
	}
}

// 锁文件是 kind 目录外的 <kind>.lock，Clear 不应把它一并删除导致互斥失效；
// 且 List/Count 不受 data/ 下锁文件影响（非 .json 后缀天然被过滤）
func TestLockFileSurvivesClearAndIgnoredByList(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	if err := s.Create("conf", "k1", []byte(`{"v":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Clear("conf"); err != nil {
		t.Fatal(err)
	}
	// Clear 后锁机制仍可用（锁文件位于 kind 目录外）
	release := (&fileDocStore{dir: dir}).lockKindDir("conf")
	if release == nil {
		t.Fatal("lock must still be acquirable after Clear")
	}
	release()

	// 再次建文档 + 列表：锁文件不在 kind 目录内，List 不会看到它
	if err := s.Create("conf", "k2", []byte(`{"v":2}`)); err != nil {
		t.Fatal(err)
	}
	keys, total, err := s.List("conf", store.ListOpts{})
	if err != nil || total != 1 || len(keys) != 1 || keys[0] != "k2" {
		t.Fatalf("List after clear+lock: %v total=%d err=%v", keys, total, err)
	}
}
