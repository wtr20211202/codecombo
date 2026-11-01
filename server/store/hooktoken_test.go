package store_test

import (
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 入站 Hook 凭据存储单测（P-20261003-23）：签发/轮换失效/销毁/No-op 幂等，
// 以及落盘只存哈希（明文绝不持久化）。

func newHookTokenForTest(t *testing.T) (store.HookTokenStore, store.DocumentStore) {
	t.Helper()
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	return store.New(doc).HookToken, doc
}

func TestHookTokenLifecycle(t *testing.T) {
	tok, doc := newHookTokenForTest(t)

	if m := tok.Meta(); m.Exists {
		t.Fatalf("fresh store must have no hook token (inbound closed), got %+v", m)
	}
	if tok.Validate("") || tok.Validate("sch_abc") {
		t.Fatal("validate must fail without a provisioned token")
	}

	plain, err := tok.Rotate()
	if err != nil {
		t.Fatalf("rotate (create): %v", err)
	}
	if !strings.HasPrefix(plain, "sch_") || len(plain) != 4+32 {
		t.Fatalf("unexpected token shape: %q", plain)
	}
	if !tok.Validate(plain) {
		t.Fatal("generated token must validate")
	}
	// 异令牌族不得误伤
	for _, other := range []string{"sca_" + strings.Repeat("0", 32), "scd_" + strings.Repeat("0", 32), "sc_" + strings.Repeat("0", 32)} {
		if tok.Validate(other) {
			t.Fatalf("validate must reject other token family %q", other)
		}
	}

	// 落盘只存哈希：明文与明文中段不得出现在任何 kind 文档里
	keys, _, _ := doc.List("hooktokens", store.ListOpts{})
	if len(keys) != 1 {
		t.Fatalf("expected single singleton doc, got %v", keys)
	}
	data, err := doc.Get("hooktokens", "active")
	if err != nil {
		t.Fatalf("read persisted token: %v", err)
	}
	if strings.Contains(string(data), plain) || strings.Contains(string(data), strings.TrimPrefix(plain, "sch_")) {
		t.Fatalf("persisted doc leaks plaintext token: %s", data)
	}

	first := tok.Meta()
	if !first.Exists || len(first.Prefix) != 4 || first.CreatedAt == "" || first.RotatedAt == "" {
		t.Fatalf("unexpected meta: %+v", first)
	}

	// 轮换：旧值立即失效、新值可用、创建时间保留
	rotated, err := tok.Rotate()
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
	if tok.Meta().CreatedAt != first.CreatedAt {
		t.Fatalf("rotate must preserve createdAt: %q != %q", tok.Meta().CreatedAt, first.CreatedAt)
	}

	// 销毁：即刻 401 语义（Validate false），重复销毁幂等 no-op
	if err := tok.Revoke(); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if tok.Validate(rotated) {
		t.Fatal("revoked token must not validate")
	}
	if tok.Meta().Exists {
		t.Fatal("revoked store must report no token")
	}
	if err := tok.Revoke(); err != nil {
		t.Fatalf("revoke must be idempotent: %v", err)
	}
}
