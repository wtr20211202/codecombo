package store_test

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func newInboxTestStore(t *testing.T) store.InboxStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).Inbox
}

// TestInbox_AppendAndTakeDrain 投递与拉取即读（drain）：首次拉取按投递序
// 返回全部未读并标记已读，再次拉取为空；已读条目留在环形窗口内供对账
func TestInbox_AppendAndTakeDrain(t *testing.T) {
	s := newInboxTestStore(t)
	now := time.Now()

	if _, err := s.Append("agent-b", "agent-a", "配置在 config/dev.env", now); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := s.Append("agent-b", "agent-c", "测试套件 Y 在抖", now.Add(time.Second)); err != nil {
		t.Fatalf("Append 2: %v", err)
	}

	got, err := s.Take("agent-b", now.Add(2*time.Second))
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Take = %d messages, want 2", len(got))
	}
	if got[0].From != "agent-a" || got[0].Body != "配置在 config/dev.env" {
		t.Fatalf("first message = %+v, want from agent-a", got[0])
	}
	if got[1].From != "agent-c" {
		t.Fatalf("second message from = %q, want agent-c", got[1].From)
	}
	if got[0].ID == "" || got[0].At.IsZero() {
		t.Fatalf("message id/at must be populated, got %+v", got[0])
	}

	again, err := s.Take("agent-b", now.Add(3*time.Second))
	if err != nil {
		t.Fatalf("Take again: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("second Take = %d messages, want 0 (drain semantics)", len(again))
	}

	in, err := s.Get("agent-b")
	if err != nil || in == nil {
		t.Fatalf("Get: %v, %v", in, err)
	}
	if len(in.Messages) != 2 || !in.Messages[0].Read {
		t.Fatalf("Get after drain = %+v, want 2 read messages", in.Messages)
	}
}

// TestInbox_TakeEmptyAndMissing 无收件箱拉取/空投递防线
func TestInbox_TakeEmptyAndMissing(t *testing.T) {
	s := newInboxTestStore(t)
	got, err := s.Take("agent-none", time.Now())
	if err != nil {
		t.Fatalf("Take missing: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Take missing = %v, want empty", got)
	}
	if in, err := s.Get("agent-none"); err != nil || in != nil {
		t.Fatalf("Get missing = %v, %v; want nil,nil", in, err)
	}
	if _, err := s.Append("agent-b", "agent-a", "", time.Now()); !errors.Is(err, store.ErrInboxInvalid) {
		t.Fatalf("Append empty body err = %v, want ErrInboxInvalid", err)
	}
	if _, err := s.Append("", "agent-a", "x", time.Now()); !errors.Is(err, store.ErrInboxInvalid) {
		t.Fatalf("Append empty session err = %v, want ErrInboxInvalid", err)
	}
}

// TestInbox_RingCapEvictsOldest 容量保留策略：环形 20 条裁最旧
func TestInbox_RingCapEvictsOldest(t *testing.T) {
	s := newInboxTestStore(t)
	now := time.Now()
	for i := 0; i < store.InboxKeepMax+5; i++ {
		if _, err := s.Append("agent-b", "agent-a", "m", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
	in, err := s.Get("agent-b")
	if err != nil || in == nil {
		t.Fatalf("Get: %v, %v", in, err)
	}
	if len(in.Messages) != store.InboxKeepMax {
		t.Fatalf("ring cap: len = %d, want %d", len(in.Messages), store.InboxKeepMax)
	}
	if !in.Messages[0].At.Equal(now.Add(5 * time.Second)) {
		t.Fatalf("oldest survivor At = %v, want %v", in.Messages[0].At, now.Add(5*time.Second))
	}
}

// TestInbox_TTLPrune 24h TTL：过期条目在下次读/写时惰性剪枝，不出现在拉取面
func TestInbox_TTLPrune(t *testing.T) {
	s := newInboxTestStore(t)
	now := time.Now()
	if _, err := s.Append("agent-b", "agent-a", "old", now.Add(-2*store.InboxTTL)); err != nil {
		t.Fatalf("Append old: %v", err)
	}
	if _, err := s.Append("agent-b", "agent-a", "fresh", now); err != nil {
		t.Fatalf("Append fresh: %v", err)
	}
	got, err := s.Take("agent-b", now)
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if len(got) != 1 || got[0].Body != "fresh" {
		t.Fatalf("TTL prune: got %+v, want only fresh message", got)
	}
}

// TestInbox_CleanupBeforeRemovesIdleInboxes 文档级巡检口：最近消息早于截止
// 的收件箱整体删除（无主收件箱随 TTL 自然过期，会话关闭不级联）
func TestInbox_CleanupBeforeRemovesIdleInboxes(t *testing.T) {
	s := newInboxTestStore(t)
	now := time.Now()
	if _, err := s.Append("agent-old", "agent-a", "m", now.Add(-2*store.InboxTTL)); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := s.Append("agent-live", "agent-a", "m", now); err != nil {
		t.Fatalf("Append: %v", err)
	}
	removed, err := s.CleanupBefore(now.Add(-store.InboxTTL))
	if err != nil {
		t.Fatalf("CleanupBefore: %v", err)
	}
	if removed != 1 {
		t.Fatalf("CleanupBefore = %d, want 1", removed)
	}
	if in, _ := s.Get("agent-old"); in != nil {
		t.Fatalf("stale inbox must be removed, got %+v", in)
	}
	if in, _ := s.Get("agent-live"); in == nil {
		t.Fatalf("live inbox must survive cleanup")
	}
}

// TestInbox_DeleteIdempotent 显式清理口幂等
func TestInbox_DeleteIdempotent(t *testing.T) {
	s := newInboxTestStore(t)
	if _, err := s.Append("agent-b", "agent-a", "m", time.Now()); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := s.Delete("agent-b"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := s.Delete("agent-b"); err != nil {
		t.Fatalf("Delete again: %v", err)
	}
	if in, _ := s.Get("agent-b"); in != nil {
		t.Fatalf("inbox must be gone after Delete")
	}
}

// TestInbox_ConcurrentAppendNoLoss 并发投递不丢条目（repo 锁串行化读-改-写）
func TestInbox_ConcurrentAppendNoLoss(t *testing.T) {
	s := newInboxTestStore(t)
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = s.Append("agent-b", "agent-a", "m", now.Add(time.Duration(i)*time.Millisecond))
		}(i)
	}
	wg.Wait()
	in, err := s.Get("agent-b")
	if err != nil || in == nil {
		t.Fatalf("Get: %v, %v", in, err)
	}
	if len(in.Messages) != 8 {
		t.Fatalf("concurrent append lost messages: len = %d, want 8", len(in.Messages))
	}
}
