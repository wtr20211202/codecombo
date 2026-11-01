package store_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 快投递存储单测（P-20261006-51）：token 生命周期（生成/校验/轮换失效/撤销）
// + 收件箱 TTL/上限/过期把守/清账/存量文档零迁移读回。

// newQuickdropStoresForTest 独立 DocumentStore 实例（避免污染全局数据目录），
// 连同裸 doc 句柄（过期语义用例需直改落盘文档——repo 无重置出口是刻意的）
func newQuickdropStoresForTest(t *testing.T) (store.QuickdropTokenStore, store.QuickdropStore, store.DocumentStore) {
	t.Helper()
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	st := store.New(doc)
	return st.QuickdropToken, st.Quickdrop, doc
}

func TestQuickdropTokenLifecycle(t *testing.T) {
	tok, _, _ := newQuickdropStoresForTest(t)

	if m := tok.Meta(); m.Exists {
		t.Fatalf("fresh store should have no token, got %+v", m)
	}
	if tok.Validate("scd_abc") || tok.Validate("") {
		t.Fatal("validate must fail without token")
	}

	plain, err := tok.Generate()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.HasPrefix(plain, "scd_") || len(plain) != 4+32 {
		t.Fatalf("unexpected token shape: %q", plain)
	}
	if !tok.Validate(plain) {
		t.Fatal("validate should accept generated token")
	}
	if tok.Validate("scd_" + strings.Repeat("0", 32)) {
		t.Fatal("validate must reject unknown token")
	}
	// 非 scd_ 前缀的令牌族（sca_/sc_/scl_）不得误伤
	if tok.Validate("sca_" + strings.Repeat("0", 32)) {
		t.Fatal("validate must reject other token families")
	}

	m := tok.Meta()
	if !m.Exists || len(m.Prefix) != 4 || m.CreatedAt == "" || m.RotatedAt == "" {
		t.Fatalf("unexpected meta: %+v", m)
	}

	// 轮换：旧令牌立即失效，创建时间保留
	rotated, err := tok.Generate()
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated == plain {
		t.Fatal("rotate must produce a new token")
	}
	if tok.Validate(plain) {
		t.Fatal("old token must be invalid after rotate")
	}
	if !tok.Validate(rotated) {
		t.Fatal("rotated token must validate")
	}
	if tok.Meta().CreatedAt != m.CreatedAt {
		t.Fatalf("rotate must preserve createdAt: %s != %s", tok.Meta().CreatedAt, m.CreatedAt)
	}

	if err := tok.Revoke(); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if tok.Validate(rotated) {
		t.Fatal("revoked token must be invalid")
	}
	// 撤销幂等
	if err := tok.Revoke(); err != nil {
		t.Fatalf("revoke twice: %v", err)
	}
}

func TestQuickdropAddListDelete(t *testing.T) {
	_, drops, _ := newQuickdropStoresForTest(t)

	q, err := drops.Add(store.Quickdrop{Content: "hello drop", From: "10.0.0.1"})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if !strings.HasPrefix(q.ID, "sc_qd_") {
		t.Fatalf("unexpected id: %q", q.ID)
	}
	if q.ExpiresAt.IsZero() || time.Until(q.ExpiresAt) > store.DropTTL {
		t.Fatalf("expiresAt must be now+DropTTL: %v", q.ExpiresAt)
	}

	got, err := drops.Get(q.ID)
	if err != nil || got.Content != "hello drop" {
		t.Fatalf("get: %v %+v", err, got)
	}

	// 空/超限内容拒绝
	if _, err := drops.Add(store.Quickdrop{Content: "  \n"}); err == nil {
		t.Fatal("whitespace-only content must be rejected")
	}
	if _, err := drops.Add(store.Quickdrop{Content: strings.Repeat("a", store.MaxDropBytes+1)}); err == nil {
		t.Fatal("oversize content must be rejected")
	}

	list, err := drops.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %d", err, len(list))
	}

	if err := drops.Delete(q.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := drops.Get(q.ID); err == nil {
		t.Fatal("deleted drop must be not-found")
	}
	// 未知 id 幂等成功（dismiss 语义）
	if err := drops.Delete("sc_qd_missing"); err != nil {
		t.Fatalf("delete unknown id must be idempotent: %v", err)
	}
}

func TestQuickdropCapTrimsOldest(t *testing.T) {
	_, drops, _ := newQuickdropStoresForTest(t)
	for i := 0; i < store.MaxDrops+5; i++ {
		if _, err := drops.Add(store.Quickdrop{Content: strings.Repeat("x", 10)}); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	all, err := drops.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != store.MaxDrops {
		t.Fatalf("cap must keep %d, got %d", store.MaxDrops, len(all))
	}
	// 新→旧：最新的在前面
	for i := 1; i < len(all); i++ {
		if all[i-1].CreatedAt.Before(all[i].CreatedAt) {
			t.Fatal("list must be newest-first")
		}
	}
}

func TestQuickdropExpiryGuardAndCleanup(t *testing.T) {
	_, drops, doc := newQuickdropStoresForTest(t)

	q, err := drops.Add(store.Quickdrop{Content: "soon gone"})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	// 直改落盘文档把 ExpiresAt 拨到过去（模拟 TTL 自然流驶；kind 键面与
	// store/quickdrop.go 的常量互为镜像，改动须同步）
	seeded, err := doc.Get("quickdrops", q.ID)
	if err != nil {
		t.Fatalf("seed read: %v", err)
	}
	var fields map[string]any
	if json.Unmarshal(seeded, &fields) != nil {
		t.Fatalf("seed doc not JSON: %s", seeded)
	}
	fields["expiresAt"] = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	backdated, _ := json.Marshal(fields)
	if err := doc.Update("quickdrops", q.ID, backdated); err != nil {
		t.Fatalf("backdate write: %v", err)
	}

	// 过期条目：Get/List 一致拒收（清理 ticker 周期间隙的惰性把守）
	if _, err := drops.Get(q.ID); err == nil {
		t.Fatal("expired drop must be not-found on Get")
	}
	list, _ := drops.List()
	for _, d := range list {
		if d.ID == q.ID {
			t.Fatal("expired drop must be excluded from List")
		}
	}

	n, err := drops.CleanupExpired(time.Now())
	if err != nil || n != 1 {
		t.Fatalf("cleanup: %v removed=%d", err, n)
	}
	if n2, _ := drops.CleanupExpired(time.Now()); n2 != 0 {
		t.Fatalf("cleanup must be idempotent, removed %d", n2)
	}
}

// TestQuickdropLegacyDocRoundTrip 升级兼容面：手写的最小存量文档（字段子集、
// 无 from）在新二进制下照常读回——kind 为全新增量无真存量，此处锁「缺字段
// 零值兼容」的零迁移契约（车道纪律「旧数据面 + 新二进制」形态的最小锚）
func TestQuickdropLegacyDocRoundTrip(t *testing.T) {
	_, drops, doc := newQuickdropStoresForTest(t)
	legacy := `{"id":"sc_qd_legacy","content":"old data","createdAt":"2026-01-01T00:00:00Z","expiresAt":"2999-01-01T00:00:00Z"}`
	if err := doc.Update("quickdrops", "sc_qd_legacy", []byte(legacy)); err == nil {
		t.Fatal("Update on missing key must fail (conformance), test premise broken")
	}
	// filestore 语义：Update 缺失 → ErrNotFound，先 Create 落底
	if err := doc.Create("quickdrops", "sc_qd_legacy", []byte(legacy)); err != nil {
		// 已存在（并行 seed）也可接受
		if _, gerr := doc.Get("quickdrops", "sc_qd_legacy"); gerr != nil {
			t.Fatalf("seed legacy: %v", err)
		}
	}
	list, err := drops.List()
	if err != nil || len(list) != 1 || list[0].Content != "old data" {
		t.Fatalf("legacy doc must read back: %v %+v", err, list)
	}
}
