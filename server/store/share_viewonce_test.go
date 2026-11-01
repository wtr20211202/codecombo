package store_test

// 一次性分享（阅后即焚，P-20261006-27）store 层判定矩阵：
// Consumed 纯函数边界、MarkFirstView first-writer-wins、幂等创建/轮换对
// ViewOnce/ViewedAt 的语义。访客面行为矩阵在 server/share（viewonce_test.go），
// 管理 API 投影在 server/api/share（handlers_viewonce_test.go）——三层分工。

import (
	"errors"
	"testing"
	"time"

	"codecombo/server/store"
)

// TestShareConsumedMatrix Consumed 纯函数矩阵：窗内/窗外/窗界/未武装/
// 非一次性/与 ExpiresAt 无关（TTL 归 Expired 司职，消费判定不看它）
func TestShareConsumedMatrix(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		sh   store.Share
		want bool
	}{
		{"非一次性", store.Share{}, false},
		{"一次性未打开（倒计时未武装）", store.Share{ViewOnce: true}, false},
		{"窗内（还剩 1 分钟）", store.Share{ViewOnce: true, ViewedAt: now.Add(-store.ViewOnceGrace + time.Minute)}, false},
		{"窗外（超 1 分钟）", store.Share{ViewOnce: true, ViewedAt: now.Add(-store.ViewOnceGrace - time.Minute)}, true},
		{"窗界（恰好走完即失效）", store.Share{ViewOnce: true, ViewedAt: now.Add(-store.ViewOnceGrace)}, true},
		{"已武装但 ExpiresAt 未到", store.Share{ViewOnce: true, ViewedAt: now.Add(-store.ViewOnceGrace - time.Minute), ExpiresAt: now.Add(time.Hour)}, true},
		{"ViewedAt 有值但未开一次性（防御态不消费）", store.Share{ViewedAt: now.Add(-time.Hour)}, false},
	}
	for _, tc := range cases {
		if got := tc.sh.Consumed(now); got != tc.want {
			t.Errorf("%s: Consumed = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestMarkFirstViewFirstWriterWins 武装语义：首开落库、重复开不重置
// （并发两访客同开，先到者锚定倒计时起点）、非一次性 no-op、未知 token 404
func TestMarkFirstViewFirstWriterWins(t *testing.T) {
	st := newShareStoreForTest(t)

	s, err := st.Create(store.Share{ProjectID: "p1", Name: "secret.txt", Path: "secret.txt", ViewOnce: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t0 := time.Now().Add(-time.Minute)
	if err := st.MarkFirstView(s.Token, t0); err != nil {
		t.Fatalf("mark first view: %v", err)
	}
	got, err := st.Get(s.Token)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.ViewedAt.Equal(t0) {
		t.Fatalf("ViewedAt = %v, want armed at %v", got.ViewedAt, t0)
	}

	// 重复武装 no-op：倒计时起点不被后到的访问重置
	if err := st.MarkFirstView(s.Token, time.Now()); err != nil {
		t.Fatalf("second mark: %v", err)
	}
	got, _ = st.Get(s.Token)
	if !got.ViewedAt.Equal(t0) {
		t.Fatalf("ViewedAt reset by second view: %v, want %v", got.ViewedAt, t0)
	}

	// 非一次性记录 no-op（nil，不报错）
	plain, err := st.Create(store.Share{ProjectID: "p1", Name: "plain", Path: "plain.txt"})
	if err != nil {
		t.Fatalf("create plain: %v", err)
	}
	if err := st.MarkFirstView(plain.Token, time.Now()); err != nil {
		t.Fatalf("mark on non-viewonce should no-op: %v", err)
	}
	got, _ = st.Get(plain.Token)
	if !got.ViewedAt.IsZero() {
		t.Fatalf("non-viewonce must stay unarmed, got %v", got.ViewedAt)
	}

	// 未知 token → ErrNotFound（调用方按记录死亡丢弃）
	if err := st.MarkFirstView("zzzzzzzzzzzzzzzz", time.Now()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token err = %v, want ErrNotFound", err)
	}
}

// TestViewOnceIdempotentCreateAndRotate 幂等创建/轮换的开关与时钟语义：
// 保持一次性沿用既有 ViewedAt（重复分享不重置倒计时）、显式关闭连时钟清、
// frozen/terminal 形态兜底清防绕过、轮换随记录走、snippet 同规则
func TestViewOnceIdempotentCreateAndRotate(t *testing.T) {
	st := newShareStoreForTest(t)

	// 文件分享：创建（一次性）→ 武装 → 幂等重建保持一次性沿用时钟
	s, err := st.Create(store.Share{ProjectID: "p1", Name: "key.txt", Path: "key.txt", ViewOnce: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t0 := time.Now().Add(-2 * time.Minute)
	if err := st.MarkFirstView(s.Token, t0); err != nil {
		t.Fatalf("mark: %v", err)
	}
	again, err := st.Create(store.Share{ProjectID: "p1", Name: "key.txt", Path: "key.txt", ViewOnce: true})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if !again.ViewOnce || !again.ViewedAt.Equal(t0) {
		t.Fatalf("idempotent recreate must keep viewOnce clock: %+v", again)
	}
	// 显式关闭一次性：连时钟一并清（再次开启 = 重新武装）
	off, err := st.Create(store.Share{ProjectID: "p1", Name: "key.txt", Path: "key.txt"})
	if err != nil {
		t.Fatalf("recreate off: %v", err)
	}
	if off.ViewOnce || !off.ViewedAt.IsZero() {
		t.Fatalf("explicit opt-out must clear clock: %+v", off)
	}

	// frozen 文件形态兜底清（API 层已拒，store 防直入）
	fr, err := st.Create(store.Share{ProjectID: "p1", Name: "snap", Path: "snap", Frozen: true, ViewOnce: true})
	if err != nil {
		t.Fatalf("create frozen: %v", err)
	}
	if fr.ViewOnce || !fr.ViewedAt.IsZero() {
		t.Fatalf("frozen record must never carry viewOnce: %+v", fr)
	}

	// terminal 直播形态兜底清
	tl, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "sess-1", Name: "live", ViewOnce: true})
	if err != nil {
		t.Fatalf("create terminal: %v", err)
	}
	if tl.ViewOnce || !tl.ViewedAt.IsZero() {
		t.Fatalf("terminal record must never carry viewOnce: %+v", tl)
	}

	// 轮换随记录走：开关与时钟都是记录态（rotate 救不回已武装倒计时，
	// 也不因轮换而开启）
	rot, err := st.Rotate(s.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rot.ViewOnce || !rot.ViewedAt.IsZero() {
		t.Fatalf("rotate must carry record state (was opted out): %+v", rot)
	}

	// snippet：创建一次性 → 武装 → 幂等重建沿用时钟 → 关闭清时钟
	sn, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "view-once-snippet-body", ViewOnce: true})
	if err != nil {
		t.Fatalf("create snippet: %v", err)
	}
	if !sn.ViewOnce {
		t.Fatal("snippet viewOnce flag lost on create")
	}
	if err := st.MarkFirstView(sn.Token, t0); err != nil {
		t.Fatalf("mark snippet: %v", err)
	}
	sn2, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "view-once-snippet-body", ViewOnce: true})
	if err != nil {
		t.Fatalf("recreate snippet: %v", err)
	}
	if !sn2.ViewOnce || !sn2.ViewedAt.Equal(t0) {
		t.Fatalf("snippet idempotent recreate must keep clock: %+v", sn2)
	}
	sn3, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "view-once-snippet-body"})
	if err != nil {
		t.Fatalf("recreate snippet off: %v", err)
	}
	if sn3.ViewOnce || !sn3.ViewedAt.IsZero() {
		t.Fatalf("snippet opt-out must clear clock: %+v", sn3)
	}
}
