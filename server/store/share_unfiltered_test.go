package store_test

// 未过滤分享（P-20261106-9）store 层语义：
//   - 终端输出直播/冻结两形态才承载 Unfiltered（其余形态兜底清——cast 源已在
//     录制层写盘前遮蔽，无「不过滤」可言）
//   - 冻结快照（含原文落盘）TTL 强制钳 UnfilteredTTLMax，SetExpiry 同钳（恢复
//     永久/越界一律收敛），遮蔽记录的既有 TTL 语义零变化
//   - 遮蔽/未过滤两模式恒不同链：直播派生键加后缀（遮蔽键 = 会话 ID 原值，
//     存量短链零变化）；轮换沿用同一派生键（代际只换链不换模式）
//   - 创建时定死：幂等命中既有直播不覆写模式
//   - 落库 omitempty：遮蔽记录不写字段（旧数据面/旧二进制格式零变化）

import (
	"encoding/json"
	"testing"
	"time"

	"codecombo/server/store"
)

func TestShareUnfilteredOnlyForTerminalForms(t *testing.T) {
	st := newShareStoreForTest(t)

	file, err := st.Create(store.Share{ProjectID: "p1", Path: "a.txt", Name: "a.txt", Unfiltered: true})
	if err != nil {
		t.Fatalf("create file: %v", err)
	}
	if file.Unfiltered {
		t.Fatal("file share must not carry Unfiltered")
	}
	snip, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "hello", Unfiltered: true})
	if err != nil {
		t.Fatalf("create snippet: %v", err)
	}
	if snip.Unfiltered {
		t.Fatal("snippet share must not carry Unfiltered")
	}
	cast, err := st.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "rec-1", Unfiltered: true})
	if err != nil {
		t.Fatalf("create cast: %v", err)
	}
	if cast.Unfiltered {
		t.Fatal("cast share must not carry Unfiltered (source masked at recording write)")
	}
	live, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "s-1", Unfiltered: true})
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	if !live.Unfiltered {
		t.Fatal("terminal live share must keep Unfiltered")
	}
	frozen, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "h1", Unfiltered: true})
	if err != nil {
		t.Fatalf("create term-frozen: %v", err)
	}
	if !frozen.Unfiltered {
		t.Fatal("terminal-frozen share must keep Unfiltered")
	}
}

func TestShareUnfilteredTermFrozenTTLClamp(t *testing.T) {
	st := newShareStoreForTest(t)

	// 未过滤快照：缺省窗口直接取 24h（而非 30 天）
	raw, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "raw", Unfiltered: true})
	if err != nil {
		t.Fatalf("create unfiltered: %v", err)
	}
	if d := time.Until(raw.ExpiresAt); d > store.UnfilteredTTLMax || d < store.UnfilteredTTLMax-time.Minute {
		t.Fatalf("unfiltered default TTL = %v, want ~%v", d, store.UnfilteredTTLMax)
	}
	// 显式越界窗口：钳回上限
	long, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "raw2",
		Unfiltered: true, ExpiresAt: time.Now().Add(7 * 24 * time.Hour)})
	if err != nil {
		t.Fatalf("create unfiltered long: %v", err)
	}
	if d := time.Until(long.ExpiresAt); d > store.UnfilteredTTLMax {
		t.Fatalf("explicit long TTL not clamped: %v", d)
	}
	// 遮蔽快照：既有 30 天默认零变化
	masked, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "masked"})
	if err != nil {
		t.Fatalf("create masked: %v", err)
	}
	if d := time.Until(masked.ExpiresAt); d < store.FrozenTTL-time.Minute {
		t.Fatalf("masked snapshot TTL changed: %v, want ~%v", d, store.FrozenTTL)
	}
}

func TestShareUnfilteredSetExpiryClamp(t *testing.T) {
	st := newShareStoreForTest(t)

	raw, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "raw", Unfiltered: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// 恢复永久（零值）→ 钳到上限，不允许变相永久
	got, err := st.SetExpiry(raw.Token, time.Time{})
	if err != nil {
		t.Fatalf("set permanent: %v", err)
	}
	if got.ExpiresAt.IsZero() || time.Until(got.ExpiresAt) > store.UnfilteredTTLMax {
		t.Fatalf("permanent not clamped: %v", got.ExpiresAt)
	}
	// 越界延长 → 钳到上限
	got, err = st.SetExpiry(raw.Token, time.Now().Add(30*24*time.Hour))
	if err != nil {
		t.Fatalf("set long: %v", err)
	}
	if time.Until(got.ExpiresAt) > store.UnfilteredTTLMax {
		t.Fatalf("long expiry not clamped: %v", time.Until(got.ExpiresAt))
	}
	// 缩短 → 原样生效
	short := time.Now().Add(time.Hour).Truncate(time.Second)
	got, err = st.SetExpiry(raw.Token, short)
	if err != nil {
		t.Fatalf("set short: %v", err)
	}
	if !got.ExpiresAt.Equal(short) {
		t.Fatalf("short expiry altered: %v, want %v", got.ExpiresAt, short)
	}
	// 落库值即生效值（重读一致）
	reread, err := st.Get(raw.Token)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	if !reread.ExpiresAt.Equal(short) {
		t.Fatalf("persisted expiry = %v, want %v", reread.ExpiresAt, short)
	}

	// 遮蔽记录：恢复永久照旧生效（钳制只作用于未过滤）
	masked, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s-1", ContentHash: "masked"})
	if err != nil {
		t.Fatalf("create masked: %v", err)
	}
	got, err = st.SetExpiry(masked.Token, time.Time{})
	if err != nil {
		t.Fatalf("set masked permanent: %v", err)
	}
	if !got.ExpiresAt.IsZero() {
		t.Fatalf("masked permanent must stay zero, got %v", got.ExpiresAt)
	}
}

func TestShareUnfilteredLiveDistinctLinkAndFixedMode(t *testing.T) {
	st := newShareStoreForTest(t)

	masked, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "s-1"})
	if err != nil {
		t.Fatalf("create masked live: %v", err)
	}
	// 遮蔽键 = 会话 ID 原值：与派生原语逐字节一致（存量短链零变化）
	// 幂等命中：请求改为未过滤 → 返回既有遮蔽记录，模式不覆写（创建时定死）
	again, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "s-1", Unfiltered: true})
	if err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	if again.Token != masked.Token || again.Unfiltered {
		t.Fatalf("idempotent hit must keep existing masked record: token %s→%s unfiltered=%v",
			masked.Token, again.Token, again.Unfiltered)
	}
	reread, err := st.Get(masked.Token)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	if reread.Unfiltered {
		t.Fatal("masked record flipped to unfiltered by idempotent re-create")
	}

	// 撤销后以未过滤重开：短链必须不同——已分发的遮蔽链接接不到原样输出
	if err := st.Delete(masked.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	raw, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "s-1", Unfiltered: true})
	if err != nil {
		t.Fatalf("create unfiltered live: %v", err)
	}
	if !raw.Unfiltered {
		t.Fatal("unfiltered live lost its mode")
	}
	if raw.Token == masked.Token {
		t.Fatal("unfiltered live must derive a token distinct from the masked link of the same session")
	}
	if _, err := st.Get(masked.Token); err == nil {
		t.Fatal("revoked masked link must stay dead after unfiltered re-create")
	}

	// 轮换：模式随记录走，新链仍在未过滤派生键空间（与遮蔽链轮换结果不同）
	rotated, err := st.Rotate(raw.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if !rotated.Unfiltered {
		t.Fatal("rotate must preserve Unfiltered")
	}
	if rotated.Token == raw.Token || rotated.Token == masked.Token {
		t.Fatal("rotate must derive a fresh token")
	}
}

func TestShareUnfilteredOmitEmptyOnDisk(t *testing.T) {
	// 遮蔽记录不写字段：旧数据面 + 新二进制、新数据面 + 旧二进制双向格式零变化
	b, err := json.Marshal(store.Share{Token: "t", Kind: store.ShareKindTerminal, TerminalID: "s"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["unfiltered"]; ok {
		t.Fatalf("masked record must omit the unfiltered field: %s", b)
	}
	// 旧文档（无字段）读入 = 遮蔽（安全默认）
	var old store.Share
	if err := json.Unmarshal([]byte(`{"token":"t","kind":"terminal","terminalId":"s"}`), &old); err != nil {
		t.Fatalf("unmarshal old doc: %v", err)
	}
	if old.Unfiltered {
		t.Fatal("legacy record without the field must read as masked")
	}
}
