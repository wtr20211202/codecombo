package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newSSHKeyTestStore 返回测试 store 与其落盘文档目录
// （filestore.New 的入参再拼一层 data/<kind>，返回拼好的根供测试直读原文）
func newSSHKeyTestStore(t *testing.T) (*store.Store, string) {
	t.Helper()
	dir := t.TempDir()
	return store.New(filestore.New(dir)), filepath.Join(dir, "data")
}

// A7 守护：SSH 私钥必须加密落盘，原始文档中不得出现 PEM 明文；
// 读取侧 GetPrivatePem 返回明文（解密对调用方透明）
func TestSSHKeyEncryptedAtRest(t *testing.T) {
	s, dataDir := newSSHKeyTestStore(t)

	pub, _, err := s.SshKey.Generate("test-key", "ed25519")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if pub.ID == "" {
		t.Fatal("expected ID set")
	}

	raw, err := os.ReadFile(filepath.Join(dataDir, "sshkeys", pub.ID+".json"))
	if err != nil {
		t.Fatalf("read raw doc: %v", err)
	}
	if strings.Contains(string(raw), "BEGIN OPENSSH PRIVATE KEY") ||
		strings.Contains(string(raw), "BEGIN RSA PRIVATE KEY") {
		t.Fatalf("private pem stored in plaintext: %s", raw)
	}
	if !strings.Contains(string(raw), "enc:") {
		t.Fatalf("expected enc: prefixed ciphertext, got: %s", raw)
	}

	pemStr, err := s.SshKey.GetPrivatePem(pub.ID)
	if err != nil {
		t.Fatalf("GetPrivatePem: %v", err)
	}
	if !strings.Contains(pemStr, "BEGIN") {
		t.Fatalf("expected plaintext pem from getter")
	}
}

// Import 的私钥同样加密落盘
func TestSSHKeyImportEncryptedAtRest(t *testing.T) {
	s, dataDir := newSSHKeyTestStore(t)

	imported, err := s.SshKey.Import("imported", testPemFixture(t))
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "sshkeys", imported.ID+".json"))
	if err != nil {
		t.Fatalf("read raw doc: %v", err)
	}
	if strings.Contains(string(raw), "BEGIN OPENSSH PRIVATE KEY") {
		t.Fatalf("imported pem stored in plaintext: %s", raw)
	}
}

// 启动期迁移：历史明文记录经 MigrateLegacyPem 重写为加密落盘；
// 读路径（ListPublic）不再有写盘副作用（持久化纪律：读路径禁止写）
func TestSSHKeyLegacyPlaintextMigrated(t *testing.T) {
	s, dataDir := newSSHKeyTestStore(t)

	// 直接以明文形态写入一份历史记录（模拟 A7 修复前的存量数据）
	fixture := testPemFixture(t)
	legacyID := "sc_legacy_key"
	legacyJSON := `{"id":"` + legacyID + `","name":"legacy","fingerprint":"fp","algo":"ed25519","private_pem":"` + strings.ReplaceAll(string(fixture), "\n", "\\n") + `","created_at":"2026-01-01T00:00:00Z"}`
	if err := os.MkdirAll(filepath.Join(dataDir, "sshkeys"), 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "sshkeys", legacyID+".json"), []byte(legacyJSON), 0600); err != nil {
		t.Fatalf("write legacy doc: %v", err)
	}

	// 读路径不迁移：文档保持明文原样
	if _, err := s.SshKey.ListPublic(); err != nil {
		t.Fatalf("ListPublic: %v", err)
	}
	rawAfterRead, err := os.ReadFile(filepath.Join(dataDir, "sshkeys", legacyID+".json"))
	if err != nil {
		t.Fatalf("read doc after list: %v", err)
	}
	if !strings.Contains(string(rawAfterRead), "BEGIN OPENSSH PRIVATE KEY") {
		t.Fatalf("read path must not rewrite the document (migration belongs to startup): %s", rawAfterRead)
	}

	// 启动期迁移：明文 → enc: 加密态
	n, err := s.SshKey.MigrateLegacyPem()
	if err != nil {
		t.Fatalf("MigrateLegacyPem: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 migration, got %d", n)
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "sshkeys", legacyID+".json"))
	if err != nil {
		t.Fatalf("read migrated doc: %v", err)
	}
	if strings.Contains(string(raw), "BEGIN OPENSSH PRIVATE KEY") {
		t.Fatalf("legacy pem not migrated to encrypted at rest: %s", raw)
	}
	if !strings.Contains(string(raw), "enc:") {
		t.Fatalf("expected enc: prefixed ciphertext after migration, got: %s", raw)
	}
	// 幂等：已加密记录不再计数
	if n, err := s.SshKey.MigrateLegacyPem(); err != nil || n != 0 {
		t.Fatalf("MigrateLegacyPem should be idempotent, got n=%d err=%v", n, err)
	}

	// 迁移后私钥仍可用
	pemStr, err := s.SshKey.GetPrivatePem(legacyID)
	if err != nil {
		t.Fatalf("GetPrivatePem after migration: %v", err)
	}
	if !strings.Contains(pemStr, "BEGIN") {
		t.Fatalf("expected plaintext pem after migration")
	}
}

func testPemFixture(t *testing.T) []byte {
	t.Helper()
	// 现场生成一把 ed25519 密钥作为导入料（不写入任何固定私钥字面量）
	s, _ := newSSHKeyTestStore(t)
	pub, _, err := s.SshKey.Generate("fixture", "ed25519")
	if err != nil {
		t.Fatalf("generate fixture: %v", err)
	}
	pem, err := s.SshKey.GetPrivatePem(pub.ID)
	if err != nil {
		t.Fatalf("get fixture pem: %v", err)
	}
	return []byte(pem)
}
