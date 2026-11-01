package auth

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/store"
)

// stubSSHKeyStore 测试用 SshKeyStore 实现
// 通过 map[host]*SSHKey 提供内存级存取，避免 filestore 落盘
// 注意：完整实现 store.SshKeyStore 接口（与 server/store/sshkey.go 中的 SshKeyStore 一致）
type stubSSHKeyStore struct {
	keys map[string]*store.SSHKey // host → key
}

func (s *stubSSHKeyStore) ListPublic() ([]store.SSHKeyPublic, error) {
	out := make([]store.SSHKeyPublic, 0, len(s.keys))
	for _, k := range s.keys {
		out = append(out, k.ToPublic())
	}
	return out, nil
}
func (s *stubSSHKeyStore) Generate(name, algo string) (store.SSHKeyPublic, string, error) {
	return store.SSHKeyPublic{}, "", nil
}
func (s *stubSSHKeyStore) Import(name string, privateKeyPEM []byte) (store.SSHKeyPublic, error) {
	return store.SSHKeyPublic{}, nil
}
func (s *stubSSHKeyStore) Delete(id string) error { return nil }

func (s *stubSSHKeyStore) MigrateLegacyPem() (int, error) { return 0, nil }
func (s *stubSSHKeyStore) GetPub(id string) (string, error) {
	for _, k := range s.keys {
		if k.ID == id {
			return "ssh-ed25519 fake-pub", nil
		}
	}
	return "", nil
}
func (s *stubSSHKeyStore) GetPrivatePem(id string) (string, error) {
	for _, k := range s.keys {
		if k.ID == id {
			return k.PrivatePem, nil
		}
	}
	return "", nil
}
func (s *stubSSHKeyStore) FindByHost(host string) (*store.SSHKey, error) {
	if k, ok := s.keys[host]; ok {
		return k, nil
	}
	return nil, nil
}
func (s *stubSSHKeyStore) GetByID(id string) (*store.SSHKey, error) {
	for _, k := range s.keys {
		if k.ID == id {
			return k, nil
		}
	}
	return nil, store.ErrNotFound
}
func (s *stubSSHKeyStore) FindByFingerprint(fp string) (*store.SSHKey, error) {
	if fp == "" {
		return nil, store.ErrNotFound
	}
	for _, k := range s.keys {
		if k.Fingerprint == fp {
			return k, nil
		}
	}
	return nil, store.ErrNotFound
}

// 测试用 ed25519 PEM（虚构数据，仅用于验证写入 / 读取 / LRU 路径）
const testEd25519PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAtest0fake1key2for3testing4only5do6not7use8in9prod
-----END OPENSSH PRIVATE KEY-----`

// newTestSSHResolver 装配测试用 KeyPathSSHResolver
// 小容量 LRU（cap=4）便于测试淘汰逻辑
func newTestSSHResolver(t *testing.T) (*KeyPathSSHResolver, *stubSSHKeyStore) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	// 触发 master-key 初始化（写入新 data dir）
	_, _ = config.EncryptToken("init")

	stub := &stubSSHKeyStore{keys: map[string]*store.SSHKey{}}
	r := &KeyPathSSHResolver{
		Store: stub,
		Cache: NewSSHKeyLRU(4), // 小容量便于测试 LRU 淘汰
	}
	return r, stub
}

// TestSSHResolverNoKeyReturnsEmptyInjection 验证无 SSH key 时返回空 injection
// 空 injection 让 git 走系统默认 ssh（依赖 ~/.ssh/config 或 ssh-agent）
func TestSSHResolverNoKeyReturnsEmptyInjection(t *testing.T) {
	r, _ := newTestSSHResolver(t)
	inj, err := r.ResolveForSSH(context.Background(), "github.com", "")
	if err != nil {
		t.Fatalf("ResolveForSSH: %v", err)
	}
	if inj == nil {
		t.Fatal("expected non-nil injection")
	}
	if len(inj.Env) != 0 {
		t.Errorf("expected empty Env, got %v", inj.Env)
	}
}

// TestSSHResolverKeyIDTakesPrecedence 验证 keyID 非空时按 id 精确取钥匙
// （优先于 host 匹配）：同 host 存在绑定钥匙 A，用户显式选 B，应以 B 解析；
// id 不存在时报错而非静默回退
func TestSSHResolverKeyIDTakesPrecedence(t *testing.T) {
	r, stub := newTestSSHResolver(t)
	enc, _ := config.EncryptToken(testEd25519PEM)
	stub.keys["github.com"] = &store.SSHKey{ID: "kA", Host: "github.com", PrivatePem: enc}
	stub.keys["gitlab.com"] = &store.SSHKey{ID: "kB", Host: "gitlab.com", PrivatePem: enc}

	// 选 kB（host 匹配会拿到 kA）→ 应按 id 拿到 kB
	inj, err := r.ResolveForSSH(context.Background(), "github.com", "kB")
	if err != nil {
		t.Fatalf("ResolveForSSH by id: %v", err)
	}
	if len(inj.Env) == 0 {
		t.Fatal("expected non-empty Env for by-id resolution")
	}

	if _, err := r.ResolveForSSH(context.Background(), "github.com", "k-missing"); err == nil {
		t.Error("expected error for unknown key id, got nil")
	}
}

// TestSSHResolverWithKeyReturnsEnv 验证有 key 时构造 GIT_SSH_COMMAND 并包含 -i 路径
func TestSSHResolverWithKeyReturnsEnv(t *testing.T) {
	r, stub := newTestSSHResolver(t)
	enc, _ := config.EncryptToken(testEd25519PEM)
	stub.keys["github.com"] = &store.SSHKey{
		ID: "k1", Host: "github.com", PrivatePem: enc,
	}

	inj, err := r.ResolveForSSH(context.Background(), "github.com", "")
	if err != nil {
		t.Fatalf("ResolveForSSH: %v", err)
	}
	if len(inj.Env) == 0 {
		t.Fatal("expected non-empty Env")
	}
	found := false
	for _, e := range inj.Env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			found = true
			if !strings.Contains(e, "-i ") {
				t.Errorf("GIT_SSH_COMMAND missing -i: %q", e)
			}
			// known_hosts 隔离到应用数据目录（不写服务用户 ~/.ssh）
			if !strings.Contains(e, "UserKnownHostsFile=") {
				t.Errorf("GIT_SSH_COMMAND missing UserKnownHostsFile: %q", e)
			}
			break
		}
	}
	if !found {
		t.Errorf("GIT_SSH_COMMAND not in Env: %v", inj.Env)
	}
}

// TestSSHResolverLRUCacheReusesFile 验证同 host 多次 resolve 复用同一 tmp 文件
func TestSSHResolverLRUCacheReusesFile(t *testing.T) {
	r, stub := newTestSSHResolver(t)
	enc, _ := config.EncryptToken(testEd25519PEM)
	stub.keys["github.com"] = &store.SSHKey{ID: "k1", Host: "github.com", PrivatePem: enc}

	inj1, _ := r.ResolveForSSH(context.Background(), "github.com", "")
	inj2, _ := r.ResolveForSSH(context.Background(), "github.com", "")

	// 两次应指向同一文件（LRU 命中）
	path1 := extractKeyPath(t, inj1.Env)
	path2 := extractKeyPath(t, inj2.Env)
	if path1 != path2 {
		t.Errorf("LRU cache miss: %q vs %q", path1, path2)
	}
}

// TestSSHResolverLRUEviction 验证 LRU 容量超限后淘汰最旧条目
// cacheKey 格式为 "<host>:<id>"；这里 ID 与 host 相同，便于断言
func TestSSHResolverLRUEviction(t *testing.T) {
	r, stub := newTestSSHResolver(t)
	// cache cap = 4；插入 5 个 host 后第 1 个应被淘汰
	hosts := []string{"a.com", "b.com", "c.com", "d.com", "e.com"}
	for _, h := range hosts {
		enc, _ := config.EncryptToken(testEd25519PEM)
		stub.keys[h] = &store.SSHKey{ID: h, Host: h, PrivatePem: enc}
		_, _ = r.ResolveForSSH(context.Background(), h, "")
	}
	if size := r.Cache.Size(); size != 4 {
		t.Errorf("cache size = %d, want 4", size)
	}
	// a.com（最旧）应被淘汰；e.com（最新）应存在
	if _, exists := r.Cache.lookupForTest("a.com:a.com"); exists {
		t.Errorf("a.com should be evicted")
	}
	if _, exists := r.Cache.lookupForTest("e.com:e.com"); !exists {
		t.Errorf("e.com should still be cached")
	}
}

// TestSSHResolverWritesFileWith0600 验证 tmp 文件权限为 0600（Unix only）
// Windows 文件系统不应用 POSIX 权限位，os.WriteFile(0600) stat 回报 0666，故跳过
func TestSSHResolverWritesFileWith0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX perm check skipped on Windows")
	}
	r, stub := newTestSSHResolver(t)
	enc, _ := config.EncryptToken(testEd25519PEM)
	stub.keys["github.com"] = &store.SSHKey{ID: "k1", Host: "github.com", PrivatePem: enc}

	inj, _ := r.ResolveForSSH(context.Background(), "github.com", "")
	path := extractKeyPath(t, inj.Env)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

// TestSSHResolverWritesDecryptedPem 验证 tmp 文件内容是解密后的 PEM（跨平台）
func TestSSHResolverWritesDecryptedPem(t *testing.T) {
	r, stub := newTestSSHResolver(t)
	enc, _ := config.EncryptToken(testEd25519PEM)
	stub.keys["github.com"] = &store.SSHKey{ID: "k1", Host: "github.com", PrivatePem: enc}

	inj, _ := r.ResolveForSSH(context.Background(), "github.com", "")
	path := extractKeyPath(t, inj.Env)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read key file: %v", err)
	}
	if string(data) != testEd25519PEM {
		t.Errorf("file content mismatch: got %q", string(data))
	}
}

// extractKeyPath 从 GIT_SSH_COMMAND 中提取 -i 后的 key 路径
func extractKeyPath(t *testing.T, env []string) string {
	t.Helper()
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			idx := strings.Index(e, "-i ")
			if idx < 0 {
				t.Fatalf("no -i in %q", e)
			}
			rest := e[idx+3:]
			// 去掉可能的前导引号
			rest = strings.TrimLeft(rest, "\"'")
			// 取到下一个空白或引号为止
			end := len(rest)
			for i, ch := range rest {
				if ch == ' ' || ch == '"' || ch == '\'' {
					end = i
					break
				}
			}
			return rest[:end]
		}
	}
	t.Fatalf("no GIT_SSH_COMMAND in env: %v", env)
	return ""
}

// 防止 unused import
var _ = filepath.Join
