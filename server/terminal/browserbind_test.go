package terminal

import (
	"sync"
	"testing"
)

// 会话浏览器亲和绑定（P-20261117-4）单测：初绑/迁移（last-attach-wins）/清空
// 的字段语义 + 并发安全（-race 档）。绑定落 Session 内存态不落盘——重启恢复
// 绑定丢失由发布口单浏览器启发式兜底，本组只钉读写面。

// TestSessionBrowserBindingLifecycle 初绑 → 接管迁移 → 清空：
// 空串 = 清除/未绑定是发布口「走启发式」的判定输入，语义必须成立
func TestSessionBrowserBindingLifecycle(t *testing.T) {
	s := &Session{ID: "t-bind"}
	if got := s.BrowserID(); got != "" {
		t.Fatalf("fresh session expect unbound, got %q", got)
	}
	s.BindBrowser("bA")
	if got := s.BrowserID(); got != "bA" {
		t.Fatalf("after bind expect bA, got %q", got)
	}
	// 接管即迁移（last-attach-wins）：另一浏览器附着同会话，绑定跟随
	s.BindBrowser("bB")
	if got := s.BrowserID(); got != "bB" {
		t.Fatalf("re-attach wins expect bB, got %q", got)
	}
	// 空串清除（无绑定形态）：发布口回落启发式/降级
	s.BindBrowser("")
	if got := s.BrowserID(); got != "" {
		t.Fatalf("blank clear expect unbound, got %q", got)
	}
}

// TestSessionBrowserBindingConcurrent 并发读写安全（配 -race 跑）：绑定写在
// attach 热路径（每次 WS 连接触发）、读在发布口——与 lastActivity 同款取向
// 的锁语义不得撕裂
func TestSessionBrowserBindingConcurrent(t *testing.T) {
	s := &Session{ID: "t-bind-race"}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				s.BindBrowser("bA")
				_ = s.BrowserID()
				s.BindBrowser("bB")
				_ = s.BrowserID()
			}
		}()
	}
	wg.Wait()
	if got := s.BrowserID(); got != "bB" {
		t.Fatalf("final value expect bB (last write wins), got %q", got)
	}
}
