package store_test

// 会话回放只读分享（P-20261003-77）的 store 语义：会话 ID 派生/幂等/
// 默认 24h TTL 与上限钳制/轮换同构/与既有命名空间隔离/过期清理同管线。
// 内容面（条目快照）不属本层，由 share/api 包单测与 e2e 覆盖。

import (
	"errors"
	"testing"
	"time"

	"codecombo/server/store"
)

func TestShareStoreSession(t *testing.T) {
	st := newShareStoreForTest(t)

	// 缺 sessionId → ErrInvalidArg
	if _, err := st.Create(store.Share{Kind: store.ShareKindSession}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("missing sessionId err = %v, want ErrInvalidArg", err)
	}

	before := time.Now()
	s1, err := st.Create(store.Share{
		Kind:      store.ShareKindSession,
		SessionID: "sess-share-a",
		Name:      "排查心跳",
		Size:      4096,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s1.Token == "" || len(s1.Token) != 16 {
		t.Fatalf("token = %q, want 16 base36 chars", s1.Token)
	}
	if s1.ProjectID != "" || s1.Path != "" || s1.IsDir || s1.Frozen {
		t.Fatalf("session share must not bind project fs: %+v", s1)
	}
	if s1.Kind != store.ShareKindSession || s1.SessionID != "sess-share-a" {
		t.Fatalf("session anchor not preserved: %+v", s1)
	}
	if remain := time.Until(s1.ExpiresAt); remain < 23*time.Hour+59*time.Minute || remain > 24*time.Hour+time.Minute {
		t.Fatalf("default ttl = %v, want ~24h", remain)
	}
	if !s1.CreatedAt.After(before.Add(-time.Minute)) {
		t.Fatalf("createdAt = %v", s1.CreatedAt)
	}

	// 幂等：同一会话重复分享 → 同链，CreatedAt/ExpiresAt 不刷新；名称/大小
	// 随请求刷新（重分享可重写快照跟进会话新增回合）
	again, err := st.Create(store.Share{
		Kind:      store.ShareKindSession,
		SessionID: "sess-share-a",
		Name:      "排查心跳（完整）",
		Size:      8192,
	})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if again.Token != s1.Token {
		t.Fatalf("idempotent create drifted: %s vs %s", again.Token, s1.Token)
	}
	if !again.CreatedAt.Equal(s1.CreatedAt) || !again.ExpiresAt.Equal(s1.ExpiresAt) {
		t.Fatalf("idempotent create must keep CreatedAt/ExpiresAt: %+v vs %+v", again, s1)
	}
	if again.Name != "排查心跳（完整）" || again.Size != 8192 {
		t.Fatalf("idempotent create should refresh name/size: %+v", again)
	}

	// 不同会话 → 不同链；与 cast/term-frozen/terminal 命名空间物理隔离
	s2, err := st.Create(store.Share{Kind: store.ShareKindSession, SessionID: "sess-share-b"})
	if err != nil {
		t.Fatalf("create second: %v", err)
	}
	if s2.Token == s1.Token {
		t.Fatal("different sessions must derive different tokens")
	}
	cast, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sess-share-a"})
	if err != nil {
		t.Fatalf("create cast: %v", err)
	}
	if cast.Token == s1.Token {
		t.Fatal("session namespace must not collide with cast")
	}

	// 一次性字段对回放无意义：store 兜底清
	vo, err := st.Create(store.Share{Kind: store.ShareKindSession, SessionID: "sess-share-vo", ViewOnce: true})
	if err != nil {
		t.Fatalf("create view-once session: %v", err)
	}
	if vo.ViewOnce || !vo.ViewedAt.IsZero() {
		t.Fatalf("session share must clear view-once fields: %+v", vo)
	}

	// 轮换同构：新旧链迁移、快照目录锚零代际值（SessionNativeToken 确定性）
	rot, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rot.Token == s1.Token {
		t.Fatal("rotate must derive a new token")
	}
	if _, err := st.Get(s1.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old token after rotate err = %v, want ErrNotFound", err)
	}
	if rot.SessionID != s1.SessionID || !rot.ExpiresAt.Equal(s1.ExpiresAt) {
		t.Fatalf("rotate must keep anchor and expiry: %+v", rot)
	}
	afterRotate, err := st.Create(store.Share{Kind: store.ShareKindSession, SessionID: "sess-share-a"})
	if err != nil {
		t.Fatalf("recreate after rotate: %v", err)
	}
	if afterRotate.Token != rot.Token {
		t.Fatalf("idempotent after rotate = %s, want current generation %s", afterRotate.Token, rot.Token)
	}

	// TTL 上限钳制：显式超 24h 落回 24h（本形态不提供长留存档）
	clamped, err := st.Create(store.Share{
		Kind: store.ShareKindSession, SessionID: "sess-share-ttl",
		ExpiresAt: time.Now().Add(72 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create clamped: %v", err)
	}
	if remain := time.Until(clamped.ExpiresAt); remain > store.SessionShareTTLMax+time.Minute {
		t.Fatalf("ttl not clamped: %v", remain)
	}

	// 显式调短生效（24h 内）
	short, err := st.Create(store.Share{
		Kind: store.ShareKindSession, SessionID: "sess-share-short",
		ExpiresAt: time.Now().Add(30 * time.Minute),
	})
	if err != nil {
		t.Fatalf("create short: %v", err)
	}
	if remain := time.Until(short.ExpiresAt); remain > 31*time.Minute {
		t.Fatalf("explicit shorter ttl not honored: %v", remain)
	}

	// SetExpiry 允许（非 snippet 固定窗口）；过期清理同管线
	if _, err := st.SetExpiry(rot.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("set expiry on session: %v", err)
	}
	if n, err := st.CleanupExpired(time.Now()); err != nil || n == 0 {
		t.Fatalf("cleanup = %d, %v; want expired session removed", n, err)
	}
	if _, err := st.Get(rot.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired session after cleanup err = %v, want ErrNotFound", err)
	}

	// 过期残留重复分享：删旧重建新周期（不给过期回放借尸还魂）
	stale, err := st.Create(store.Share{
		Kind: store.ShareKindSession, SessionID: "sess-share-stale",
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatalf("create stale: %v", err)
	}
	reborn, err := st.Create(store.Share{Kind: store.ShareKindSession, SessionID: "sess-share-stale"})
	if err != nil {
		t.Fatalf("recreate expired: %v", err)
	}
	if reborn.Token != stale.Token {
		t.Fatalf("same session derives same token even after expiry: %s vs %s", reborn.Token, stale.Token)
	}
	if reborn.Expired(time.Now()) || !reborn.ExpiresAt.After(stale.ExpiresAt) {
		t.Fatalf("recreate must start a fresh TTL window: %+v (old %+v)", reborn, stale)
	}
}

// TestSessionNativeTokenStable 快照目录名锚点的跨调用确定性
func TestSessionNativeTokenStable(t *testing.T) {
	pepper := []byte("unit-test-pepper")
	a := store.SessionNativeToken(pepper, "sess-x")
	if a != store.SessionNativeToken(pepper, "sess-x") {
		t.Fatal("session native token must be deterministic")
	}
	if len(a) != 16 {
		t.Fatalf("session native token len = %d, want 16", len(a))
	}
	if a == store.SessionNativeToken(pepper, "sess-y") {
		t.Fatal("different sessions must derive different native tokens")
	}
	if a == store.CastNativeToken(pepper, "sess-x") {
		t.Fatal("session namespace must not collide with cast")
	}
}
