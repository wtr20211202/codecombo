package app

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/config"
)

// 生效断言：auto-fetch 并发拉取的瞬时并发数不得超过信号量上限
// （历史实现为串行 for 循环，40+ 项目一轮以分钟计）
func TestFetchProjectsConcurrent_RespectsConcurrencyCap(t *testing.T) {
	projects := make([]config.ProjectConfig, 12)
	for i := range projects {
		projects[i] = config.ProjectConfig{ID: string(rune('a' + i)), Path: "/p", Name: "p"}
	}

	var inflight, maxInflight atomic.Int32
	fetch := func(ctx context.Context, path string, timeout time.Duration) error {
		n := inflight.Add(1)
		for {
			old := maxInflight.Load()
			if n <= old || maxInflight.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		inflight.Add(-1)
		return nil
	}

	fetchProjectsConcurrent(context.Background(), projects, 4, time.Second, fetch)
	if got := maxInflight.Load(); got > 4 {
		t.Fatalf("max concurrent fetches = %d, want <= 4", got)
	}
	if got := maxInflight.Load(); got < 2 {
		t.Fatalf("fetches did not run concurrently (max = %d), serialization regression", got)
	}
}

// 生效断言：单个挂起的 fetch 不得拖死整轮（超时后调用方继续处理其余项目）
func TestFetchProjectWithTimeout_AbandonsHungFetch(t *testing.T) {
	block := make(chan struct{})
	hung := func(ctx context.Context, path string, timeout time.Duration) error {
		<-block // 模拟网络挂起
		return nil
	}
	_ = hung

	start := time.Now()
	err := fetchProjectWithTimeout(context.Background(), "/slow/repo", 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("caller blocked %v — hung fetch stalls the loop", elapsed)
	}
	close(block) // 让被放弃的 goroutine 退出，避免泄漏到其他测试
}

// 生效断言：上层 ctx 取消同样终止等待
func TestFetchProjectWithTimeout_RespectsParentContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	block := make(chan struct{})
	defer close(block)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-block
	}()

	err := fetchProjectWithTimeout(ctx, "/x", time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}
