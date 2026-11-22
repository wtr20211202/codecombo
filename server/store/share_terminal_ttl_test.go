package store_test

import (
	"testing"
	"time"

	"codecombo/server/store"
)

// 终端直播永久挡（P-20261119-5）：零值 ExpiresAt 在 terminal kind 默认不是
// 永久（createTerminal 会强补 30 分钟并钳 24h），显式永久经 Share.Permanent
// 瞬态标记豁免。本组锁定 store 层语义：
//   - Permanent 豁免默认补挂/24h 钳，落库零值（记录与 token 不过期）
//   - 瞬态标记不落库（读回记录不再带标记）
//   - 幂等命中保持既有倒计时（清窗由 handler 经 SetExpiry 完成，store 不越界）
//   - 未过滤×显式永久合法（【用户定向修订】2026-11-19：不再 400 硬禁）——
//     Permanent 置位一并豁免 clampUnfilteredExpiry，落库零值不被静默钳回 24h；
//     非显式路径（未带标记直入）维持既有钳制语义
//   - SetExpiry 双向：零值清窗（unfiltered 记录对称放开）、限时方向钳 24h
//   - CleanupExpired 不碰零值记录（零值=永不过期是既有 Expired 语义）
func TestShareStoreTerminalPermanent(t *testing.T) {
	st := newShareStoreForTest(t)

	// 显式永久：零值落库，无默认补挂
	perm, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-perm", Permanent: true})
	if err != nil {
		t.Fatalf("create permanent: %v", err)
	}
	if !perm.ExpiresAt.IsZero() {
		t.Fatalf("permanent share must keep zero ExpiresAt, got %v", perm.ExpiresAt)
	}
	// 瞬态标记不落库：读回记录不带 Permanent（过期语义只剩 ExpiresAt 一个事实源）
	back, err := st.Get(perm.Token)
	if err != nil {
		t.Fatalf("get permanent: %v", err)
	}
	if back.Permanent {
		t.Fatal("Permanent is create-time only and must not be persisted")
	}
	if !back.ExpiresAt.IsZero() {
		t.Fatalf("persisted permanent share must stay zero, got %v", back.ExpiresAt)
	}
	// 零值 = 永不过期：Expired 恒 false，清理管线不删
	if back.Expired(time.Now()) {
		t.Fatal("zero ExpiresAt must mean never expires")
	}
	if n, err := st.CleanupExpired(time.Now()); err != nil || n != 0 {
		t.Fatalf("cleanup removed permanent record: n=%d err=%v", n, err)
	}
	if _, err := st.Get(perm.Token); err != nil {
		t.Fatalf("permanent record must survive cleanup: %v", err)
	}

	// 瞬态标记缺省（未显式选择）仍落 30 分钟默认：既有语义零变化
	def, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-def"})
	if err != nil {
		t.Fatalf("create default: %v", err)
	}
	if remain := time.Until(def.ExpiresAt); remain < 29*time.Minute || remain > 31*time.Minute {
		t.Fatalf("default ttl = %v, want ~30m", remain)
	}

	// 幂等命中既有倒计时：带 Permanent 重建也不清窗（store 保留旧值；显式永久
	// 的清窗由 handler 经 SetExpiry 落，与文件分享 applyExplicitExpiry 同边界）
	again, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-def", Permanent: true})
	if err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	if again.Token != def.Token || !again.ExpiresAt.Equal(def.ExpiresAt) {
		t.Fatalf("idempotent hit must keep token/expiry: %+v vs %+v", again, def)
	}

	// 未过滤×显式永久合法（【用户定向修订】2026-11-19）：Permanent 置位一并
	// 豁免 clampUnfilteredExpiry——落库零值，不被静默钳回 24h（否则组合在
	// store 层被降级、永久档形同虚设）
	raw, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-raw", Permanent: true, Unfiltered: true})
	if err != nil {
		t.Fatalf("create unfiltered permanent: %v", err)
	}
	if !raw.ExpiresAt.IsZero() {
		t.Fatalf("unfiltered explicit permanent must stay zero, got %v", raw.ExpiresAt)
	}
	// 非显式路径（未带 Permanent 标记的直入调用）：维持既有钳制语义——零值
	// 走默认 30 分钟补挂（unfiltered 钳制只对零值/越界生效，30m 窗内原样）
	noflag, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-noflag", Unfiltered: true})
	if err != nil {
		t.Fatalf("create unfiltered default: %v", err)
	}
	if remain := time.Until(noflag.ExpiresAt); remain < 29*time.Minute || remain > 31*time.Minute {
		t.Fatalf("unfiltered default ttl = %v, want ~30m (existing semantics unchanged)", remain)
	}

	// SetExpiry 双向（P-20261119-5）：限时方向钳 24h、零值清窗、窗内精确落值
	cap48, err := st.SetExpiry(def.Token, time.Now().Add(48*time.Hour))
	if err != nil {
		t.Fatalf("set expiry 48h: %v", err)
	}
	if remain := time.Until(cap48.ExpiresAt); remain > store.TerminalLiveTTLMax+time.Minute {
		t.Fatalf("set expiry must cap to %v, got %v", store.TerminalLiveTTLMax, remain)
	}
	cleared, err := st.SetExpiry(def.Token, time.Time{})
	if err != nil {
		t.Fatalf("set expiry permanent: %v", err)
	}
	if !cleared.ExpiresAt.IsZero() {
		t.Fatalf("zero expiresAt must clear window, got %v", cleared.ExpiresAt)
	}
	twoH := time.Now().Add(2 * time.Hour)
	exact, err := st.SetExpiry(def.Token, twoH)
	if err != nil {
		t.Fatalf("set expiry 2h: %v", err)
	}
	if d := exact.ExpiresAt.Sub(twoH); d > time.Second || d < -time.Second {
		t.Fatalf("within-cap set expiry drifted: %v", d)
	}

	// 未过滤记录的 SetExpiry 零值对称放开（【用户定向修订】：改期是显式用户
	// 动作=用户意志+撤销兜底）——清窗成永久
	rawPerm, err := st.SetExpiry(raw.Token, time.Time{})
	if err != nil {
		t.Fatalf("set unfiltered permanent: %v", err)
	}
	if !rawPerm.ExpiresAt.IsZero() {
		t.Fatalf("unfiltered set-expiry permanent must clear window, got %v", rawPerm.ExpiresAt)
	}
	// 未过滤记录的限时方向仍钳 UnfilteredTTLMax（原样暴露上限是独立安全边界，
	// 不随直播上限未来放宽而放宽）
	rawFar, err := st.SetExpiry(raw.Token, time.Now().Add(48*time.Hour))
	if err != nil {
		t.Fatalf("set unfiltered 48h: %v", err)
	}
	if remain := time.Until(rawFar.ExpiresAt); remain > store.UnfilteredTTLMax+time.Minute {
		t.Fatalf("unfiltered set expiry must cap to %v, got %v", store.UnfilteredTTLMax, remain)
	}
}
