package liveterm

import (
	"sync"
	"testing"
)

// 尺寸实时面（P-20261107-4 渲染保真）回归：访客 hello/resize 帧取会话「当前」
// 尺寸——接线时刻定格的 cols/rows 在主人调整窗口后即过期，访客栅格与主机
// 不符即折行/光标定位错乱。另锁默认会话解析的 typed-nil 防线（缺失会话必须
// 是 nil 接口，否则 reconcile/wire 的「会话已不在」判定永远失效，且对 nil
// 指针调 Size 会 panic）。

// sizedSession 尺寸可变的桩会话（其余能力复用 fakeSession）
type sizedSession struct {
	*fakeSession
	smu        sync.Mutex
	cols, rows uint16
}

func (s *sizedSession) Size() (uint16, uint16) {
	s.smu.Lock()
	defer s.smu.Unlock()
	return s.cols, s.rows
}

func (s *sizedSession) resize(cols, rows uint16) {
	s.smu.Lock()
	s.cols, s.rows = cols, rows
	s.smu.Unlock()
}

func TestSubscriptionSizeTracksSessionResize(t *testing.T) {
	sess := &sizedSession{fakeSession: newFakeSession(nil), cols: 100, rows: 30}
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := &Hub{feeds: map[string]*feed{}}
	h.Wire("tok", "s1", false)

	sub, err := h.Subscribe("tok", "s1", false)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Release()
	if c, r := sub.Size(); c != 100 || r != 30 {
		t.Fatalf("initial size = %dx%d, want 100x30", c, r)
	}
	// 主人调整窗口：订阅期间尺寸读取跟随会话（不是接线/订阅时刻的快照）
	sess.resize(160, 48)
	if c, r := sub.Size(); c != 160 || r != 48 {
		t.Fatalf("size after host resize = %dx%d, want 160x48", c, r)
	}
	// 新订阅同样拿当前尺寸（hello 帧数据源）
	sub2, err := h.Subscribe("tok", "s1", false)
	if err != nil {
		t.Fatalf("subscribe 2: %v", err)
	}
	defer sub2.Release()
	if c, r := sub2.Size(); c != 160 || r != 48 {
		t.Fatalf("fresh subscriber size = %dx%d, want 160x48", c, r)
	}
	// 会话报 0 尺寸（从未 resize 的会话）：回落接线时刻值，不把 0 下发访客
	sess.resize(0, 0)
	if c, r := sub.Size(); c != 100 || r != 30 {
		t.Fatalf("zero-size fallback = %dx%d, want wire-time 100x30", c, r)
	}
	// 馈线终结后释放会话引用：尺寸回落接线时刻值（不再读已关闭会话）
	sess.resize(200, 50)
	h.Unwire("tok")
	if c, r := sub.Size(); c != 100 || r != 30 {
		t.Fatalf("ended feed size = %dx%d, want wire-time 100x30", c, r)
	}
}

// 默认会话解析：缺失会话必须返回 nil 接口（*terminal.Session 的 nil 指针装进
// 接口后 != nil——typed-nil 会让 reconcile 永远判不出会话已关闭，wire 对 nil
// 指针调 Size 直接 panic）
func TestDefaultLookupMissingSessionIsNilInterface(t *testing.T) {
	SetSessionLookup(nil)
	if s := lookupSession("no-such-session-p20261107-4"); s != nil {
		t.Fatalf("missing session lookup = %#v, want nil interface", s)
	}
	// 缺失会话的惰性接线：建一条立即终结的空馈线（访客收「已结束」），不 panic
	h := &Hub{feeds: map[string]*feed{}}
	sub, err := h.Subscribe("tok-missing", "no-such-session-p20261107-4", false)
	if err != nil {
		t.Fatalf("subscribe missing: %v", err)
	}
	defer sub.Release()
	if !sub.Ended() {
		t.Fatal("subscription to a missing session must be ended")
	}
	if c, r := sub.Size(); c != 0 || r != 0 {
		t.Fatalf("missing session size = %dx%d, want 0x0 (guest falls back to fit)", c, r)
	}
}
