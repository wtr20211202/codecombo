package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// newCredTestStore 构造基于临时目录的 store 用于测试
func newCredTestStore(t *testing.T) store.CredentialStore {
	t.Helper()
	tmpDir := t.TempDir()
	dir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return store.NewCredentialRepo(filestore.New(dir))
}

// TestCredentialV2Fields 验证新模型字段写入读取
func TestCredentialV2Fields(t *testing.T) {
	repo := newCredTestStore(t)

	now := time.Now().Truncate(time.Second)
	c := &store.Credential{
		ID:            "test-1",
		Host:          "github.com",
		Platform:      auth.PlatformGitHub,
		AuthType:      store.AuthTypeOAuthDevice,
		Username:      "x-access-token",
		Secret:        "enc:abc",
		RefreshToken:  "enc:def",
		ExpiresAt:     now.Add(1 * time.Hour),
		Scope:         "repo,workflow",
		OAuthClientID: "client-xxx",
		Status:        store.StatusActive,
		LastError:     "",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := repo.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := repo.FindByHost("github.com")
	if err != nil {
		t.Fatalf("FindByHost: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("FindByHost returned %d creds, want 1", len(got))
	}
	if got[0].AuthType != store.AuthTypeOAuthDevice {
		t.Errorf("AuthType = %q", got[0].AuthType)
	}
	if got[0].Status != store.StatusActive {
		t.Errorf("Status = %q", got[0].Status)
	}
	if !got[0].ExpiresAt.Equal(now.Add(1 * time.Hour)) {
		t.Errorf("ExpiresAt mismatch")
	}
}

// TestFindByHostReturnsSlice 验证 FindByHost 返回 slice
func TestFindByHostReturnsSlice(t *testing.T) {
	repo := newCredTestStore(t)

	// 同 host 配两条 cred
	if err := repo.Save(&store.Credential{ID: "a", Host: "github.com", AuthType: store.AuthTypeBasic, Status: store.StatusActive, CreatedAt: time.Now()}); err != nil {
		t.Fatalf("Save a: %v", err)
	}
	if err := repo.Save(&store.Credential{ID: "b", Host: "github.com", AuthType: store.AuthTypeOAuthDevice, Status: store.StatusActive, CreatedAt: time.Now()}); err != nil {
		t.Fatalf("Save b: %v", err)
	}

	got, _ := repo.FindByHost("github.com")
	if len(got) != 2 {
		t.Errorf("FindByHost returned %d, want 2", len(got))
	}
}

// TestFindEncryptedByHostPicksBest 验证优先级排序：oauth-device > oauth-web > basic
func TestFindEncryptedByHostPicksBest(t *testing.T) {
	repo := newCredTestStore(t)

	now := time.Now()
	// 三个 cred：basic、oauth-web、oauth-device
	_ = repo.Save(&store.Credential{ID: "basic", Host: "github.com", AuthType: store.AuthTypeBasic, Status: store.StatusActive, CreatedAt: now, UpdatedAt: now})
	_ = repo.Save(&store.Credential{ID: "web", Host: "github.com", AuthType: store.AuthTypeOAuthWeb, Status: store.StatusActive, CreatedAt: now, UpdatedAt: now})
	_ = repo.Save(&store.Credential{ID: "device", Host: "github.com", AuthType: store.AuthTypeOAuthDevice, Status: store.StatusActive, CreatedAt: now, UpdatedAt: now})

	best, err := repo.FindEncryptedByHost("github.com")
	if err != nil {
		t.Fatalf("FindEncryptedByHost: %v", err)
	}
	if best == nil {
		t.Fatal("expected best credential, got nil")
	}
	if best.AuthType != store.AuthTypeOAuthDevice {
		t.Errorf("best AuthType = %q, want oauth-device", best.AuthType)
	}
}

// TestFindEncryptedByHostPrefersActive 验证优先级：active > expired
func TestFindEncryptedByHostPrefersActive(t *testing.T) {
	repo := newCredTestStore(t)

	now := time.Now()
	_ = repo.Save(&store.Credential{ID: "expired", Host: "github.com", AuthType: store.AuthTypeOAuthDevice, Status: store.StatusExpired, CreatedAt: now, UpdatedAt: now})
	_ = repo.Save(&store.Credential{ID: "active", Host: "github.com", AuthType: store.AuthTypeBasic, Status: store.StatusActive, CreatedAt: now, UpdatedAt: now})

	best, _ := repo.FindEncryptedByHost("github.com")
	if best == nil {
		t.Fatal("expected best credential, got nil")
	}
	if best.Status != store.StatusActive {
		t.Errorf("best Status = %q, want active", best.Status)
	}
}

// TestSaveRejectsInvalidAuthType 验证 Save 校验 AuthType
func TestSaveRejectsInvalidAuthType(t *testing.T) {
	repo := newCredTestStore(t)

	err := repo.Save(&store.Credential{
		ID:       "x",
		Host:     "github.com",
		AuthType: "bogus",
		Status:   store.StatusActive,
	})
	if err == nil {
		t.Fatal("expected error for invalid auth_type")
	}
}

// TestSaveRejectsInvalidStatus 验证 Save 校验 Status
func TestSaveRejectsInvalidStatus(t *testing.T) {
	repo := newCredTestStore(t)

	err := repo.Save(&store.Credential{
		ID:       "x",
		Host:     "github.com",
		AuthType: store.AuthTypeBasic,
		Status:   "bogus",
	})
	if err == nil {
		t.Fatal("expected error for invalid status")
	}
}

// TestUpdateLastUsedAt 验证 UpdateLastUsedAt 持久化
func TestUpdateLastUsedAt(t *testing.T) {
	repo := newCredTestStore(t)

	now := time.Now()
	if err := repo.Save(&store.Credential{ID: "u1", Host: "github.com", AuthType: store.AuthTypeBasic, Status: store.StatusActive, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	later := now.Add(5 * time.Minute)
	if err := repo.UpdateLastUsedAt("u1", later); err != nil {
		t.Fatalf("UpdateLastUsedAt: %v", err)
	}

	creds, _ := repo.FindByHost("github.com")
	if len(creds) != 1 {
		t.Fatalf("expected 1 cred, got %d", len(creds))
	}
	if !creds[0].LastUsedAt.Equal(later) {
		t.Errorf("LastUsedAt = %v, want %v", creds[0].LastUsedAt, later)
	}
}

// TestUpdateLastUsedAtNotFound 验证 id 不存在时返回 ErrNotFound
func TestUpdateLastUsedAtNotFound(t *testing.T) {
	repo := newCredTestStore(t)

	err := repo.UpdateLastUsedAt("non-existent-id", time.Now())
	if err == nil {
		t.Fatal("expected error for non-existent id, got nil")
	}
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

// TestSaveUpdatesExistingPreservesCreatedAt 验证同 ID 二次 Save 时 CreatedAt 保留、UpdatedAt 更新
func TestSaveUpdatesExistingPreservesCreatedAt(t *testing.T) {
	repo := newCredTestStore(t)

	original := time.Now().Add(-1 * time.Hour).Truncate(time.Second)
	c := &store.Credential{
		ID:        "test-1",
		Host:      "github.com",
		AuthType:  store.AuthTypeBasic,
		Username:  "u",
		Secret:    "plain",
		Status:    store.StatusActive,
		CreatedAt: original,
	}
	if err := repo.Save(c); err != nil {
		t.Fatalf("first Save: %v", err)
	}

	// 二次 Save（更新）
	c.Secret = "new-plain"
	if err := repo.Save(c); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	got, err := repo.FindEncryptedByHost("github.com")
	if err != nil {
		t.Fatalf("FindEncryptedByHost: %v", err)
	}
	if got == nil {
		t.Fatal("expected credential, got nil")
	}
	if !got.CreatedAt.Equal(original) {
		t.Errorf("CreatedAt changed: got %v, want %v", got.CreatedAt, original)
	}
	if !got.UpdatedAt.After(original) {
		t.Errorf("UpdatedAt not advanced: got %v, want after %v", got.UpdatedAt, original)
	}
}

// TestSaveSkipsEncryptionIfAlreadyEncrypted 验证 Secret 已带 enc: 前缀时不二次加密
func TestSaveSkipsEncryptionIfAlreadyEncrypted(t *testing.T) {
	repo := newCredTestStore(t)

	// 预构造一个已加密形态的 Secret（enc: 前缀 + 任意 base64-like payload）
	const encryptedSecret = "enc:YWJjZGVmZ2hpag=="
	c := &store.Credential{
		ID:        "enc-1",
		Host:      "github.com",
		AuthType:  store.AuthTypeBasic,
		Username:  "u",
		Secret:    encryptedSecret,
		Status:    store.StatusActive,
		CreatedAt: time.Now(),
	}
	if err := repo.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := repo.FindEncryptedByHost("github.com")
	if err != nil {
		t.Fatalf("FindEncryptedByHost: %v", err)
	}
	if got == nil {
		t.Fatal("expected credential, got nil")
	}
	// 关键断言：Secret 原样保留，未被再次加密（不会出现 enc:enc:... 双重前缀）
	if got.Secret != encryptedSecret {
		t.Errorf("Secret should be preserved as-is, got %q, want %q", got.Secret, encryptedSecret)
	}
	if strings.HasPrefix(got.Secret, "enc:enc:") {
		t.Errorf("Secret was double-encrypted: %q", got.Secret)
	}
}

// TestSaveGeneratesIDIfEmpty 验证 c.ID == "" 时自动生成非空 ID
func TestSaveGeneratesIDIfEmpty(t *testing.T) {
	repo := newCredTestStore(t)

	c := &store.Credential{
		ID:        "", // 显式留空，触发自动生成
		Host:      "github.com",
		AuthType:  store.AuthTypeBasic,
		Username:  "u",
		Secret:    "plain",
		Status:    store.StatusActive,
		CreatedAt: time.Now(),
	}
	if err := repo.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// 写入完成后，内存对象 c.ID 应被回填为非空
	if c.ID == "" {
		t.Error("expected c.ID to be auto-generated, got empty string")
	}

	// 落盘后的凭据也应能通过回填的 ID 找到
	creds, err := repo.FindByHost("github.com")
	if err != nil {
		t.Fatalf("FindByHost: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("expected 1 cred, got %d", len(creds))
	}
	if creds[0].ID != c.ID {
		t.Errorf("persisted ID = %q, want %q", creds[0].ID, c.ID)
	}
}
