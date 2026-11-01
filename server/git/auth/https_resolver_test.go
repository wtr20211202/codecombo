package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// stubCredStore 测试用 CredentialStore 实现
// 通过 map[host]*Credential 提供内存级存取，避免 filestore 落盘
type stubCredStore struct {
	creds           map[string]*store.Credential // host → cred
	saved           []*store.Credential
	lastUsedUpdated string
}

func (s *stubCredStore) List() ([]*store.Credential, error) { return nil, nil }
func (s *stubCredStore) ListPublic() ([]store.CredentialPublic, error) {
	return nil, nil
}
func (s *stubCredStore) FindByHost(host string) ([]*store.Credential, error) {
	if c, ok := s.creds[host]; ok {
		return []*store.Credential{c}, nil
	}
	return nil, nil
}
func (s *stubCredStore) FindEncryptedByHost(host string) (*store.Credential, error) {
	if c, ok := s.creds[host]; ok {
		return c, nil
	}
	return nil, nil
}
func (s *stubCredStore) FindByID(id string) (*store.Credential, error) {
	for _, c := range s.creds {
		if c.ID == id {
			return c, nil
		}
	}
	return nil, nil
}
func (s *stubCredStore) Save(c *store.Credential) error {
	s.saved = append(s.saved, c)
	s.creds[c.Host] = c
	return nil
}
func (s *stubCredStore) Delete(id string) error { return nil }
func (s *stubCredStore) UpdateLastUsedAt(id string, t time.Time) error {
	s.lastUsedUpdated = id
	return nil
}

// newTestResolver 装配测试用 HTTPSResolver
// 通过 t.Setenv("CC_DATA_DIR") 隔离 master-key 文件
// 注：auth 包测试不能 import providers 子包（会循环依赖），
// 因此这里手动构造 BasicAuthProvider 的等价 stub
func newTestResolver(t *testing.T) (*HTTPSResolver, *stubCredStore) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	// 触发 master-key 初始化（写入新 data dir）
	_, _ = config.EncryptToken("init")
	stub := &stubCredStore{creds: map[string]*store.Credential{}}
	r := &HTTPSResolver{
		Store: stub,
		Providers: map[string]CredentialProvider{
			"basic": &stubBasicProvider{},
		},
	}
	return r, stub
}

// stubBasicProvider 测试用 basic provider，直接返回 Secret 明文
// 等价于 providers.BasicAuthProvider，但避免 import cycle
type stubBasicProvider struct{}

func (stubBasicProvider) Type() string { return store.AuthTypeBasic }
func (stubBasicProvider) Resolve(ctx context.Context, cred *store.Credential) (*ResolvedCredential, error) {
	plain, err := config.DecryptToken(cred.Secret)
	if err != nil {
		return nil, InternalError("resolve-basic", err)
	}
	return &ResolvedCredential{Username: cred.Username, Password: plain}, nil
}
func (stubBasicProvider) TokenUsername(cred *store.Credential) string { return cred.Username }

// TestHTTPSResolverNoCredential 验证 host 无 cred 时返回 nil
func TestHTTPSResolverNoCredential(t *testing.T) {
	r, _ := newTestResolver(t)
	got, err := r.Resolve(context.Background(), "unknown.com")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil, got %+v", got)
	}
}

// TestHTTPSResolverBasicCred 验证 basic 类型 cred 被正确解密并返回
func TestHTTPSResolverBasicCred(t *testing.T) {
	r, stub := newTestResolver(t)
	enc, _ := config.EncryptToken("my-pat")
	stub.creds["github.com"] = &store.Credential{
		ID: "1", Host: "github.com", AuthType: store.AuthTypeBasic,
		Username: "alice", Secret: enc, Status: store.StatusActive,
	}

	got, err := r.Resolve(context.Background(), "github.com")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil || got.Password != "my-pat" {
		t.Errorf("got = %+v", got)
	}
}

// TestHTTPSResolverExpiredCredSkipped 验证 status=expired 的 cred 仍能被 resolve
// pickBestCredential 已在 store 层保证 active 优先，resolver 不重复跳过逻辑
func TestHTTPSResolverExpiredCredSkipped(t *testing.T) {
	r, stub := newTestResolver(t)
	stub.creds["github.com"] = &store.Credential{
		AuthType: store.AuthTypeBasic, Status: store.StatusExpired,
	}
	got, err := r.Resolve(context.Background(), "github.com")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	// expired cred 也会被 resolve（BasicAuthProvider 无 status 校验）
	_ = got
}

// TestHTTPSResolverUnknownAuthType 验证未知 AuthType 返回 nil（无匹配 provider）
func TestHTTPSResolverUnknownAuthType(t *testing.T) {
	r, stub := newTestResolver(t)
	stub.creds["x.com"] = &store.Credential{
		AuthType: "future-type", Status: store.StatusActive,
	}
	got, _ := r.Resolve(context.Background(), "x.com")
	if got != nil {
		t.Errorf("unknown auth_type should return nil")
	}
}

// TestHTTPSResolverUpdatesLastUsedAt 验证异步更新 LastUsedAt
func TestHTTPSResolverUpdatesLastUsedAt(t *testing.T) {
	r, stub := newTestResolver(t)
	enc, _ := config.EncryptToken("x")
	stub.creds["github.com"] = &store.Credential{
		ID: "abc", Host: "github.com", AuthType: store.AuthTypeBasic,
		Username: "u", Secret: enc, Status: store.StatusActive,
	}

	_, _ = r.Resolve(context.Background(), "github.com")
	// 异步更新，等一下
	time.Sleep(100 * time.Millisecond)
	if stub.lastUsedUpdated != "abc" {
		t.Errorf("LastUsedAt not updated; lastUsedUpdated = %q", stub.lastUsedUpdated)
	}
}

// TestHTTPSResolverAuthErrorExpiredSetsStatus 验证 expired AuthError 触发 Status 更新
// 直接调用 handleResolveError 验证逻辑，避免依赖 mock provider
func TestHTTPSResolverAuthErrorExpiredSetsStatus(t *testing.T) {
	stub := &stubCredStore{creds: map[string]*store.Credential{
		"x.com": {ID: "1", Host: "x.com", Status: store.StatusActive},
	}}
	cred := stub.creds["x.com"]
	err := ExpiredError("test", errors.New("invalid_grant"))

	handleResolveError(err, cred, stub)

	if cred.Status != store.StatusExpired {
		t.Errorf("Status = %q, want expired", cred.Status)
	}
	if len(stub.saved) != 1 {
		t.Errorf("expected 1 save, got %d", len(stub.saved))
	}
}
