package terminal

import (
	"sync"
	"testing"
)

// TestAttachedClientsReader owner 附着计数读口（P-20261122-16 ④）：只由
// HandleTerminalWS 的 AttachClient/DetachClient 驱动；读口给装配层判定访客
// 视口反喂该不该让位。并发自增自减（多标签/多窗口）读数不错账，下溢不置负
// （错账时宁可多留会话——与 DetachClient 既有下溢防护同旨）
func TestAttachedClientsReader(t *testing.T) {
	s := &Session{ID: "attach-1"}
	if got := s.AttachedClients(); got != 0 {
		t.Fatalf("fresh session attached clients = %d, want 0", got)
	}
	s.AttachClient()
	s.AttachClient()
	if got := s.AttachedClients(); got != 2 {
		t.Fatalf("after 2 attaches = %d, want 2", got)
	}
	s.DetachClient()
	if got := s.AttachedClients(); got != 1 {
		t.Fatalf("after detach = %d, want 1", got)
	}
	s.DetachClient()
	s.DetachClient() // 下溢防护：多减一次不置负
	if got := s.AttachedClients(); got != 0 {
		t.Fatalf("underflow guard = %d, want 0", got)
	}

	// 并发接断（浏览器多标签重连风暴）：读写同锁，终态归零
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				s.AttachClient()
				_ = s.AttachedClients()
				s.DetachClient()
			}
		}()
	}
	wg.Wait()
	if got := s.AttachedClients(); got != 0 {
		t.Fatalf("after concurrent attach/detach = %d, want 0", got)
	}
}
