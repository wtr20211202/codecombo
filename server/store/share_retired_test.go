package store_test

import (
	"encoding/json"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 退役短链台账与外泄观测（P-20261008-2）：rotate 记账、命中计数、反查宿主、
// 旧记录兼容读、上限逐出、宿主消亡摘除、幂等重建保留。

func TestShareStoreRotateRecordsRetiredTokens(t *testing.T) {
	st := newShareStoreForTest(t)
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(s1.RetiredTokens) != 0 {
		t.Fatalf("fresh share has retired tokens: %v", s1.RetiredTokens)
	}

	// 首次轮换：旧 token 进台账（RetiredAt 非零、命中计数零值）
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.RetiredTokens) != 1 {
		t.Fatalf("after first rotate retired tokens = %d, want 1", len(s2.RetiredTokens))
	}
	rt := s2.RetiredTokens[0]
	if rt.Token != s1.Token {
		t.Fatalf("retired token = %s, want %s", rt.Token, s1.Token)
	}
	if rt.RetiredAt.IsZero() {
		t.Fatal("retiredAt must be set at rotate time")
	}
	if rt.Hits != 0 || !rt.LastHitAt.IsZero() {
		t.Fatalf("fresh retired entry has hits: %+v", rt)
	}

	// 再次轮换：台账追加（两条退役链同宿主），记录本身迁键到第三代
	s3, err := st.Rotate(s2.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(s3.RetiredTokens) != 2 {
		t.Fatalf("after second rotate retired tokens = %d, want 2", len(s3.RetiredTokens))
	}
	if s3.RetiredTokens[1].Token != s2.Token {
		t.Fatalf("second retired token = %s, want %s", s3.RetiredTokens[1].Token, s2.Token)
	}

	// 落盘确认（Get 读回而非只看返回值）
	back, err := st.Get(s3.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(back.RetiredTokens) != 2 {
		t.Fatalf("persisted retired tokens = %d, want 2", len(back.RetiredTokens))
	}
}

func TestShareStoreFindRetiredAndRecordHit(t *testing.T) {
	st := newShareStoreForTest(t)
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}

	// 退役 token 反查宿主：返回当前代际记录
	host, ok := st.FindRetired(s1.Token)
	if !ok {
		t.Fatal("rotated-away token must be found via FindRetired")
	}
	if host.Token != s2.Token {
		t.Fatalf("host token = %s, want current generation %s", host.Token, s2.Token)
	}

	// 活 token / 未知 token 不在退役面
	if _, ok := st.FindRetired(s2.Token); ok {
		t.Fatal("live token must not resolve as retired")
	}
	if _, ok := st.FindRetired("nonexistent0000"); ok {
		t.Fatal("unknown token must not resolve as retired")
	}

	// 命中计数：条目 Hits 累加 + LastHitAt 刷新，返回宿主
	at := time.Now()
	host, err = st.RecordRetiredHit(s1.Token, 2, at)
	if err != nil {
		t.Fatal(err)
	}
	if host.Token != s2.Token {
		t.Fatalf("RecordRetiredHit host = %s, want %s", host.Token, s2.Token)
	}
	if host.RetiredTokens[0].Hits != 2 {
		t.Fatalf("retired hits = %d, want 2", host.RetiredTokens[0].Hits)
	}
	if !host.RetiredTokens[0].LastHitAt.Equal(at) {
		t.Fatalf("lastHitAt = %v, want %v", host.RetiredTokens[0].LastHitAt, at)
	}

	// 落盘读回一致
	back, err := st.Get(s2.Token)
	if err != nil {
		t.Fatal(err)
	}
	if back.RetiredTokens[0].Hits != 2 {
		t.Fatalf("persisted retired hits = %d, want 2", back.RetiredTokens[0].Hits)
	}

	// n ≤ 0 防御直通；未知退役 token → ErrNotFound（宿主消亡面）
	if _, err := st.RecordRetiredHit(s1.Token, 0, at); err != nil {
		t.Fatalf("zero-batch must be a no-op, got %v", err)
	}
	if _, err := st.RecordRetiredHit("nonexistent0000", 1, at); err == nil {
		t.Fatal("unknown retired token must return ErrNotFound")
	}
}

func TestShareStoreRetiredIndexRebuildAfterRestart(t *testing.T) {
	// 同一落盘目录两次实例化 = 重启：新实例的索引未构建，首次查询惰性全量
	// 重建（store 是单进程唯一写方，落盘态即索引真相）
	dir := t.TempDir()
	st := store.New(filestore.New(dir)).Share
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}

	reborn := store.New(filestore.New(dir)).Share
	host, ok := reborn.FindRetired(s1.Token)
	if !ok {
		t.Fatal("reborn store must lazily rebuild the retired index")
	}
	if host.Token != s2.Token {
		t.Fatalf("reborn host = %s, want %s", host.Token, s2.Token)
	}
	// 重建后命中计数照常落盘
	if _, err := reborn.RecordRetiredHit(s1.Token, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	back, err := reborn.Get(s2.Token)
	if err != nil {
		t.Fatal(err)
	}
	if back.RetiredTokens[0].Hits != 1 {
		t.Fatalf("reborn retired hits = %d, want 1", back.RetiredTokens[0].Hits)
	}
}

func TestShareStoreRetiredLedgerEndsWithHost(t *testing.T) {
	st := newShareStoreForTest(t)
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RecordRetiredHit(s1.Token, 1, time.Now()); err != nil {
		t.Fatal(err)
	}

	// 撤销宿主：台账随之消亡，退役命中退化为普通 404 观感（FindRetired miss
	// ——观测面与宿主同生命周期，撤销后不再告警）
	if err := st.Delete(s2.Token); err != nil {
		t.Fatal(err)
	}
	if _, ok := st.FindRetired(s1.Token); ok {
		t.Fatal("revoked host must take its retired ledger with it")
	}
	if _, err := st.RecordRetiredHit(s1.Token, 1, time.Now()); err == nil {
		t.Fatal("RecordRetiredHit after revoke must return ErrNotFound")
	}

	// TTL 过期清理同样摘除：过期记录 + 清理 ticker 扫走 → 台账消亡
	st2 := newShareStoreForTest(t)
	a, err := st2.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st2.Rotate(a.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st2.SetExpiry(b.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := st2.CleanupExpired(time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.FindRetired(a.Token); ok {
		t.Fatal("expired host cleanup must take its retired ledger with it")
	}
}

func TestShareStoreRetiredLedgerSurvivesIdempotentRecreate(t *testing.T) {
	st := newShareStoreForTest(t)
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RecordRetiredHit(s1.Token, 3, time.Now()); err != nil {
		t.Fatal(err)
	}

	// 分享者在管理器再点一次分享（幂等 get-or-create 命中当前代际）：
	// 台账同属记录不清零——观测面不得因重复分享丢失
	again, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	if again.Token != s2.Token {
		t.Fatalf("idempotent recreate followed wrong generation: %s, want %s", again.Token, s2.Token)
	}
	if len(again.RetiredTokens) != 1 || again.RetiredTokens[0].Hits != 3 {
		t.Fatalf("idempotent recreate must keep the retired ledger: %+v", again.RetiredTokens)
	}
}

func TestShareStoreRetiredTokensCap(t *testing.T) {
	st := newShareStoreForTest(t)
	// snippet 内容派生链也可轮换，且内容可编程生成——高频轮换造满台账
	content := ""
	s, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: content + "cap-seed"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < store.RetiredTokensMax+3; i++ {
		nx, err := st.Rotate(s.Token)
		if err != nil {
			t.Fatal(err)
		}
		s = nx
	}
	if len(s.RetiredTokens) != store.RetiredTokensMax {
		t.Fatalf("retired ledger = %d, want capped at %d", len(s.RetiredTokens), store.RetiredTokensMax)
	}
	// 逐出最旧：台账首条是最新的退役代际（倒数第一条被逐的是最早退役的）
	oldest := s.RetiredTokens[len(s.RetiredTokens)-1]
	if oldest.Token == "" {
		t.Fatal("oldest retained entry must be a real retired token")
	}
	// 最新的退役 token 仍可反查（最新代际是观测面的生命线）
	if _, ok := st.FindRetired(s.RetiredTokens[0].Token); !ok {
		t.Fatal("newest retired token must remain resolvable after cap eviction")
	}
}

func TestShareStoreRetiredLegacyRecordCompat(t *testing.T) {
	// 旧数据面 + 新二进制：存量记录 JSON 无 retiredTokens 字段 → 反序列化
	// 零值 nil（无退役史），一切读写照常（升级兼容纪律的「旧数据面」形态）
	dir := t.TempDir()
	fs := filestore.New(dir)
	st := store.New(fs).Share
	s1, err := st.Create(store.Share{ProjectID: "p1", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatal(err)
	}
	// 手工把记录改写成无该字段的旧形态（抹掉字段键）
	raw, err := st.Get(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	_ = raw
	doc := map[string]json.RawMessage{}
	blob, err := json.Marshal(map[string]any{
		"token": s1.Token, "projectId": "p1", "path": "docs", "name": "docs",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatal(err)
	}
	legacy, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := fs.Update("shares", s1.Token, legacy); err != nil {
		t.Fatal(err)
	}
	back, err := st.Get(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	if back.RetiredTokens != nil {
		t.Fatalf("legacy record must read as no retired history, got %+v", back.RetiredTokens)
	}
	// 旧记录轮换 → 惰性初始化台账（首个退役条目落进去）
	s2, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.RetiredTokens) != 1 {
		t.Fatalf("legacy record rotate must initialize ledger, got %+v", s2.RetiredTokens)
	}
	if _, ok := st.FindRetired(s1.Token); !ok {
		t.Fatal("legacy record rotate must be observable via FindRetired")
	}
}
