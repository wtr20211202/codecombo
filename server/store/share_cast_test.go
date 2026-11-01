package store_test

// 会话回放分享（P-20261004-103）的 store 语义：录制 ID 派生/幂等/默认短 TTL/
// 轮换同构/SetExpiry 可调/过期清理同管线。内容面（cast 快照）不属本层，
// 由 share 包单测与 e2e 覆盖。

import (
	"errors"
	"testing"
	"time"

	"codecombo/server/store"
)

func TestShareStoreCast(t *testing.T) {
	st := newShareStoreForTest(t)

	// 缺 recordingId → ErrInvalidArg
	if _, err := st.Create(store.Share{Kind: store.ShareKindCast}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("missing recordingId err = %v, want ErrInvalidArg", err)
	}

	// 创建：默认 1 小时短档、不绑项目、TerminalID 仅来源会话元数据
	before := time.Now()
	s1, err := st.Create(store.Share{
		Kind:        store.ShareKindCast,
		RecordingID: "sc_rec_a",
		TerminalID:  "sess-1",
		Name:        "reset --hard",
		Size:        1024,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s1.Token == "" || len(s1.Token) != 16 {
		t.Fatalf("token = %q, want 16 base36 chars", s1.Token)
	}
	if s1.ProjectID != "" || s1.Path != "" || s1.IsDir || s1.Frozen {
		t.Fatalf("cast must not bind project fs: %+v", s1)
	}
	if s1.Kind != store.ShareKindCast || s1.RecordingID != "sc_rec_a" || s1.TerminalID != "sess-1" {
		t.Fatalf("cast anchors not preserved: %+v", s1)
	}
	if remain := time.Until(s1.ExpiresAt); remain < 59*time.Minute || remain > 61*time.Minute {
		t.Fatalf("default ttl = %v, want ~1h", remain)
	}
	if !s1.CreatedAt.After(before.Add(-time.Minute)) {
		t.Fatalf("createdAt = %v", s1.CreatedAt)
	}

	// 幂等：同一录制重复分享 → 同链，CreatedAt/ExpiresAt 不刷新；名称/大小
	// 随请求刷新（重分享可重写快照跟进录制内容）
	again, err := st.Create(store.Share{
		Kind:        store.ShareKindCast,
		RecordingID: "sc_rec_a",
		TerminalID:  "sess-1",
		Name:        "reset --hard (full)",
		Size:        2048,
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
	if again.Name != "reset --hard (full)" || again.Size != 2048 {
		t.Fatalf("idempotent create should refresh name/size: %+v", again)
	}

	// 不同录制 → 不同链；与 terminal-frozen/terminal 命名空间物理隔离
	s2, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_b"})
	if err != nil {
		t.Fatalf("create second: %v", err)
	}
	if s2.Token == s1.Token {
		t.Fatal("different recordings must derive different tokens")
	}
	tf, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "sess-1", ContentHash: "h1"})
	if err != nil {
		t.Fatalf("create term-frozen: %v", err)
	}
	live, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "sess-1"})
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	if s1.Token == tf.Token || s1.Token == live.Token {
		t.Fatal("cast namespace must not collide with term-frozen/terminal")
	}

	// 一次性字段对回放无意义：store 兜底清
	vo, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_vo", ViewOnce: true})
	if err != nil {
		t.Fatalf("create view-once cast: %v", err)
	}
	if vo.ViewOnce || !vo.ViewedAt.IsZero() {
		t.Fatalf("cast must clear view-once fields: %+v", vo)
	}

	// 轮换同构：新旧链迁移、快照目录锚零代际值（CastNativeToken 确定性）
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
	if rot.RecordingID != s1.RecordingID || !rot.ExpiresAt.Equal(s1.ExpiresAt) {
		t.Fatalf("rotate must keep anchors and expiry: %+v", rot)
	}
	afterRotate, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_a"})
	if err != nil {
		t.Fatalf("recreate after rotate: %v", err)
	}
	if afterRotate.Token != rot.Token {
		t.Fatalf("idempotent after rotate = %s, want current generation %s", afterRotate.Token, rot.Token)
	}

	// TTL 上限钳制：显式超 24h 落回 24h（回放不是持久分享形态）
	clamped, err := st.Create(store.Share{
		Kind: store.ShareKindCast, RecordingID: "sc_rec_ttl",
		ExpiresAt: time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create clamped: %v", err)
	}
	if remain := time.Until(clamped.ExpiresAt); remain > store.CastShareTTLMax+time.Minute {
		t.Fatalf("ttl not clamped: %v", remain)
	}

	// SetExpiry 允许（非 snippet 固定窗口）；过期清理同管线
	if _, err := st.SetExpiry(rot.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("set expiry on cast: %v", err)
	}
	if n, err := st.CleanupExpired(time.Now()); err != nil || n == 0 {
		t.Fatalf("cleanup = %d, %v; want expired cast removed", n, err)
	}
	if _, err := st.Get(rot.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired cast after cleanup err = %v, want ErrNotFound", err)
	}

	// 过期残留重复分享：删旧重建新周期，落回零代际 token（不给过期回放
	// 借尸还魂）
	stale, err := st.Create(store.Share{
		Kind: store.ShareKindCast, RecordingID: "sc_rec_stale",
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatalf("create stale: %v", err)
	}
	reborn, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_stale"})
	if err != nil {
		t.Fatalf("recreate expired: %v", err)
	}
	if reborn.Token != stale.Token {
		t.Fatalf("same recording derives same token even after expiry: %s vs %s", reborn.Token, stale.Token)
	}
	if reborn.Expired(time.Now()) || !reborn.ExpiresAt.After(stale.ExpiresAt) {
		t.Fatalf("recreate must start a fresh TTL window: %+v (old %+v)", reborn, stale)
	}
}

// TestCastNativeTokenStable 快照目录名锚点的跨调用确定性（rotate 换链后
// 装配层从记录字段重算同一目录名）
func TestCastNativeTokenStable(t *testing.T) {
	pepper := []byte("unit-test-pepper")
	a := store.CastNativeToken(pepper, "sc_rec_x")
	if a != store.CastNativeToken(pepper, "sc_rec_x") {
		t.Fatal("cast native token must be deterministic")
	}
	if len(a) != 16 {
		t.Fatalf("cast native token len = %d, want 16", len(a))
	}
	if a == store.CastNativeToken(pepper, "sc_rec_y") {
		t.Fatal("different recordings must derive different native tokens")
	}
	if a == store.TermFrozenNativeToken(pepper, "sc_rec_x", "") {
		t.Fatal("cast namespace must not collide with term-frozen")
	}
}
