package config

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// TestEncryptDecryptRoundTrip 验证基本加解密循环
func TestEncryptDecryptRoundTrip(t *testing.T) {
	// 重置 master-key 进程级缓存
	masterKey = nil
	masterKeyOnce = sync.Once{}

	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)

	plain := "ghp_abc123secret"
	enc, err := EncryptToken(plain)
	if err != nil {
		t.Fatalf("EncryptToken failed: %v", err)
	}
	if !IsEncrypted(enc) {
		t.Errorf("IsEncrypted should be true for %q", enc)
	}

	got, err := DecryptToken(enc)
	if err != nil {
		t.Fatalf("DecryptToken failed: %v", err)
	}
	if got != plain {
		t.Errorf("round-trip mismatch: got %q, want %q", got, plain)
	}
}

// TestMasterKeyFileCreated 验证 master-key 文件自动创建 + 权限 0600
func TestMasterKeyFileCreated(t *testing.T) {
	masterKey = nil
	masterKeyOnce = sync.Once{}

	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)

	_, err := EncryptToken("test")
	if err != nil {
		t.Fatalf("EncryptToken failed: %v", err)
	}

	p := filepath.Join(dir, "data", "master-key")
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("master-key file not created: %v", err)
	}
	// Windows 文件系统不支持 POSIX 权限位，stat 返回的是 NTFS ACL 映射后的近似值（通常 0666）
	// 权限 0600 的强制断言只在 Unix 平台执行
	if perm := info.Mode().Perm(); perm != 0600 && runtime.GOOS != "windows" {
		t.Errorf("master-key file perm = %o, want 0600", perm)
	}
}

// TestMasterKeyNoMachineIDDep 验证加密不依赖 machine-id
// 同一 master-key 文件在不同进程应能解密同一密文（前提：master-key 字节相同）
func TestMasterKeyNoMachineIDDep(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)

	// 进程 A：加密
	masterKey = nil
	masterKeyOnce = sync.Once{}
	enc, _ := EncryptToken("secret-value")

	// 模拟新进程：重置缓存，但 master-key 文件已落盘
	masterKey = nil
	masterKeyOnce = sync.Once{}

	got, err := DecryptToken(enc)
	if err != nil {
		t.Fatalf("DecryptToken in new process failed: %v", err)
	}
	if got != "secret-value" {
		t.Errorf("cross-process decrypt mismatch: got %q", got)
	}
}
