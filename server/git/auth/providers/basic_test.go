package providers

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 所有测试共享同一 master-key：master-key 进程级 sync.Once 一旦初始化就锁死
// 第一个调 EncryptToken 的测试固定 SC_DATA_DIR，之后即便 setenv 也无效
// 因此用 init() 在测试 main 之前统一固定 DataDir
var (
	testDataDir     = filepath.Join(os.TempDir(), "simple-coding-test-"+strconv.Itoa(os.Getpid()))
	testDataDirOnce sync.Once
)

func setupTestCrypto(t *testing.T) {
	testDataDirOnce.Do(func() {
		// 首次：固定 SC_DATA_DIR 并触发 master-key 初始化
		if err := os.MkdirAll(testDataDir, 0700); err != nil {
			panic(err)
		}
		os.Setenv("CC_DATA_DIR", testDataDir)
		_, _ = config.EncryptToken("init")
	})
}

// TestBasicAuthProviderResolve 验证 basic 类型 cred 解出 username + decrypt(secret)
func TestBasicAuthProviderResolve(t *testing.T) {
	setupTestCrypto(t)

	enc, err := config.EncryptToken("my-pat-secret")
	if err != nil {
		t.Fatalf("EncryptToken: %v", err)
	}

	p := &BasicAuthProvider{}
	cred := &store.Credential{
		ID:       "1",
		Host:     "github.com",
		AuthType: store.AuthTypeBasic,
		Username: "alice",
		Secret:   enc,
		Status:   store.StatusActive,
	}

	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Username != "alice" {
		t.Errorf("Username = %q, want alice", got.Username)
	}
	if got.Password != "my-pat-secret" {
		t.Errorf("Password = %q, want my-pat-secret", got.Password)
	}
}

// TestBasicAuthProviderTokenUsername 验证 TokenUsername 直接回 cred.Username
func TestBasicAuthProviderTokenUsername(t *testing.T) {
	p := &BasicAuthProvider{}
	cred := &store.Credential{Username: "bob"}
	if u := p.TokenUsername(cred); u != "bob" {
		t.Errorf("TokenUsername = %q, want bob", u)
	}
}

// TestBasicAuthProviderType 验证 Type() 返回 "basic"
func TestBasicAuthProviderType(t *testing.T) {
	p := &BasicAuthProvider{}
	if p.Type() != store.AuthTypeBasic {
		t.Errorf("Type = %q, want basic", p.Type())
	}
}

// TestBasicAuthProviderEmptySecret 验证空 Secret 不崩
func TestBasicAuthProviderEmptySecret(t *testing.T) {
	p := &BasicAuthProvider{}
	cred := &store.Credential{AuthType: store.AuthTypeBasic, Username: "x", Secret: "", Status: store.StatusActive}
	got, err := p.Resolve(context.Background(), cred)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Password != "" {
		t.Errorf("Password should be empty, got %q", got.Password)
	}
	_ = time.Now() // import 占位避免 unused
}
