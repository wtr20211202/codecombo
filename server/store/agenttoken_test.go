package store_test

import (
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newAgentTokenStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newAgentTokenStoreForTest(t *testing.T) store.AgentTokenStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).AgentToken
}

// TestAgentToken_EnsureValidateRoundTrip 自动播种 → 校验通过 → 非 sca_ 前缀拒绝
func TestAgentToken_EnsureValidateRoundTrip(t *testing.T) {
	s := newAgentTokenStoreForTest(t)
	if s.Meta().Exists {
		t.Fatal("fresh store should have no agent token")
	}
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	meta := s.Meta()
	if !meta.Exists || meta.Prefix == "" {
		t.Fatalf("meta after ensure = %+v, want exists with prefix", meta)
	}
	plain := s.Plain()
	if !strings.HasPrefix(plain, "sca_") || len(plain) < 20 {
		t.Fatalf("plain = %q, want sca_ prefixed long token", plain[:10]+"...")
	}
	if !s.Validate(plain) {
		t.Error("Validate(plain) = false, want true")
	}
	if s.Validate("scl_not-an-agent-token") {
		t.Error("unlock token (scl_) must not validate as agent token")
	}
	if s.Validate("sc_machine-token") {
		t.Error("machine token (sc_) must not validate as agent token")
	}
	if s.Validate("sca_wrong-value") {
		t.Error("Validate(wrong value) = true")
	}
}

// TestAgentToken_EnsureIdempotent 重复 Ensure 不轮换（CreatedAt 不变）
func TestAgentToken_EnsureIdempotent(t *testing.T) {
	s := newAgentTokenStoreForTest(t)
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure 1: %v", err)
	}
	first := s.Meta()
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure 2: %v", err)
	}
	second := s.Meta()
	if first.CreatedAt != second.CreatedAt || first.Prefix != second.Prefix {
		t.Errorf("second ensure changed token: %+v -> %+v", first, second)
	}
}

// TestAgentToken_Rotate 轮换后旧明文失效、新明文有效；CreatedAt 保留
func TestAgentToken_Rotate(t *testing.T) {
	s := newAgentTokenStoreForTest(t)
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	oldPlain := s.Plain()
	oldMeta := s.Meta()

	newPlain, err := s.Rotate()
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if newPlain == oldPlain {
		t.Fatal("rotate returned same plaintext")
	}
	if s.Validate(oldPlain) {
		t.Error("old token still valid after rotate")
	}
	if !s.Validate(newPlain) {
		t.Error("new token invalid after rotate")
	}
	if meta := s.Meta(); meta.CreatedAt != oldMeta.CreatedAt {
		t.Errorf("rotate reset CreatedAt: %s -> %s", oldMeta.CreatedAt, meta.CreatedAt)
	}
}

// TestAgentToken_Revoke 撤销后 Validate/Plain 均失效；Ensure 重新播种
func TestAgentToken_Revoke(t *testing.T) {
	s := newAgentTokenStoreForTest(t)
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	plain := s.Plain()
	if err := s.Revoke(); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if s.Validate(plain) {
		t.Error("revoked token still valid")
	}
	if s.Plain() != "" {
		t.Error("Plain() after revoke should be empty")
	}
	if s.Meta().Exists {
		t.Error("meta exists after revoke")
	}
	// 重新播种得到新令牌
	if err := s.Ensure(); err != nil {
		t.Fatalf("re-ensure: %v", err)
	}
	if s.Plain() == "" || s.Plain() == plain {
		t.Error("re-ensure should provision a fresh token")
	}
}

// TestAgentToken_PersistAcrossReopen 令牌跨 Store 重开存活（docstore 持久化）
func TestAgentToken_PersistAcrossReopen(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s1 := store.New(filestore.New(dir)).AgentToken
	if err := s1.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	plain := s1.Plain()

	s2 := store.New(filestore.New(dir)).AgentToken
	if !s2.Validate(plain) {
		t.Error("token should validate after store reopen")
	}
	if s2.Plain() != plain {
		t.Error("Plain() should survive store reopen (encrypted at rest)")
	}
}
