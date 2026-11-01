package sshclient

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"golang.org/x/crypto/ssh"
)

// SSH 主机密钥 TOFU 校验测试（P-20261003-34）：进程内 fakeSSHServer（见
// tunnel_test.go，swapHostKey 支持同端口换钥模拟服务器重装）+ 独立临时
// DocumentStore。覆盖：首录钉扎、一致放行、变更拒绝（含审计留痕）、
// 重置恢复、per-host 关闭开关、显式 callback 不受影响、无 store 失效放行。

// randomHostSigner 生成 ed25519 主机钥（比 fakeSSHServer 旧版 rsa 2048 快一个量级）
func randomHostSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	return signer
}

// initTOFUStore 独立临时数据面（SC_DATA_DIR 隔离 master-key，filestore 隔离文档）
func initTOFUStore(t *testing.T) string {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	dir := t.TempDir()
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })
	return dir
}

// dialTOFU 按默认路径拨号（不传 HostKeyCallback → Dial 装配 TOFU）
func dialTOFU(t *testing.T, srv *fakeSSHServer, skipTOFU bool) (*Client, error) {
	t.Helper()
	return Dial(ConnectOptions{
		Host: "127.0.0.1", Port: srv.port(), User: "e2e",
		Auth:            AuthMethod{Type: AuthTypePassword, Password: "tpass"},
		SkipHostKeyTOFU: skipTOFU,
	})
}

func TestTOFUFirstPinThenConsistentPass(t *testing.T) {
	dir := initTOFUStore(t)
	srv := newFakeSSHServer(t, "tpass")

	// 首连：TOFU 钉扎并放行
	c1, err := dialTOFU(t, srv, false)
	if err != nil {
		t.Fatalf("first dial should pass (TOFU pin): %v", err)
	}
	fp, algo, ok, err := store.Get().SSHHostKey.Get("127.0.0.1", srv.port())
	if err != nil || !ok {
		t.Fatalf("fingerprint should be pinned on first connect, ok=%v err=%v", ok, err)
	}
	if !strings.HasPrefix(fp, "SHA256:") || algo != "ssh-ed25519" {
		t.Fatalf("unexpected pin: fp=%q algo=%q", fp, algo)
	}
	if fp != fingerprintOf(srv.currentHostSigner().PublicKey()) {
		t.Fatalf("pinned fingerprint mismatch: %s vs %s", fp, fingerprintOf(srv.currentHostSigner().PublicKey()))
	}
	_ = c1.Close()

	// 二连一致放行
	c2, err := dialTOFU(t, srv, false)
	if err != nil {
		t.Fatalf("second dial with same host key should pass: %v", err)
	}
	_ = c2.Close()

	// 指纹加密落盘（EncryptToken 域）：磁盘文档不得含明文指纹
	raw, err := os.ReadFile(filepath.Join(dir, "data", "sshhostkeys", tofuDocKey(t, srv.port())+".json"))
	if err != nil {
		t.Fatalf("read raw doc: %v", err)
	}
	if !strings.Contains(string(raw), "enc:") {
		t.Fatalf("fingerprint should be encrypted at rest, raw=%s", raw)
	}
	var doc struct {
		Fingerprint string `json:"fingerprint"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Fingerprint == fp {
		t.Fatalf("encrypted fingerprint must differ from plaintext, raw fp=%q", doc.Fingerprint)
	}
}

func TestTOFUMismatchRejectAndResetRecovery(t *testing.T) {
	initTOFUStore(t)
	srv := newFakeSSHServer(t, "tpass")

	if _, err := dialTOFU(t, srv, false); err != nil {
		t.Fatalf("first dial: %v", err)
	}
	pinned, _, _, _ := store.Get().SSHHostKey.Get("127.0.0.1", srv.port())

	// 同端口换钥（模拟服务器重装）→ 变更拒绝，错误可操作（含重置指引）
	newSigner := randomHostSigner(t)
	srv.swapHostKey(newSigner)
	_, err := dialTOFU(t, srv, false)
	if err == nil {
		t.Fatal("dial with rotated host key should be rejected")
	}
	if !strings.Contains(err.Error(), hostKeyChangedMarker) || !strings.Contains(err.Error(), "reset the pinned fingerprint") {
		t.Fatalf("rejection error should be actionable, got: %v", err)
	}
	// 拒绝不得覆盖旧钉扎
	fp, _, _, err := store.Get().SSHHostKey.Get("127.0.0.1", srv.port())
	if err != nil || fp != pinned {
		t.Fatalf("pinned fingerprint must survive rejection, got %q err=%v", fp, err)
	}
	// 变更拒绝入审计
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditHostKeyMismatch && strings.Contains(e.Detail, "127.0.0.1") {
			found = true
		}
	}
	if !found {
		t.Fatalf("audit should contain %s event, got %+v", store.AuditHostKeyMismatch, events)
	}

	// 重置（合法迁移）→ 重连放行且钉新钥
	if err := store.Get().SSHHostKey.Delete("127.0.0.1", srv.port()); err != nil {
		t.Fatalf("reset: %v", err)
	}
	c, err := dialTOFU(t, srv, false)
	if err != nil {
		t.Fatalf("dial after reset should re-pin: %v", err)
	}
	_ = c.Close()
	fp, _, ok, err := store.Get().SSHHostKey.Get("127.0.0.1", srv.port())
	if err != nil || !ok {
		t.Fatalf("re-pin after reset: ok=%v err=%v", ok, err)
	}
	if fp != fingerprintOf(newSigner.PublicKey()) {
		t.Fatalf("re-pinned fingerprint should be the new host key: %s", fp)
	}
}

func TestTOFUSkipSwitchBypassesPin(t *testing.T) {
	initTOFUStore(t)
	srv := newFakeSSHServer(t, "tpass")

	// per-host 关闭开关：跳过校验、不落钉扎
	c, err := dialTOFU(t, srv, true)
	if err != nil {
		t.Fatalf("dial with SkipHostKeyTOFU should pass: %v", err)
	}
	_ = c.Close()
	if _, _, ok, _ := store.Get().SSHHostKey.Get("127.0.0.1", srv.port()); ok {
		t.Fatal("skipped TOFU must not pin fingerprint")
	}

	// 换钥后跳过路径依旧放行（对照：不跳过会被拒）
	srv.swapHostKey(randomHostSigner(t))
	c2, err := dialTOFU(t, srv, true)
	if err != nil {
		t.Fatalf("skipped TOFU should pass across host key change: %v", err)
	}
	_ = c2.Close()
}

func TestTOFUExplicitCallbackNotOverridden(t *testing.T) {
	initTOFUStore(t)
	srv := newFakeSSHServer(t, "tpass")

	// 显式指定 HostKeyCallback 的调用方维持原语义（不被 TOFU 接管、不落钉扎）
	c, err := Dial(ConnectOptions{
		Host: "127.0.0.1", Port: srv.port(), User: "e2e",
		Auth:            AuthMethod{Type: AuthTypePassword, Password: "tpass"},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	if err != nil {
		t.Fatalf("explicit callback dial: %v", err)
	}
	_ = c.Close()
	if _, _, ok, _ := store.Get().SSHHostKey.Get("127.0.0.1", srv.port()); ok {
		t.Fatal("explicit HostKeyCallback must bypass TOFU pinning")
	}
}

func TestTOFUStoreUnavailableFailsOpen(t *testing.T) {
	// 无组合根（store 未初始化）：校验失效放行——与 peercert 读库失败的取舍一致
	srv := newFakeSSHServer(t, "tpass")
	c, err := dialTOFU(t, srv, false)
	if err != nil {
		t.Fatalf("dial without store should fail open: %v", err)
	}
	_ = c.Close()
}

// TestSSHHostKeyDeleteIdempotent 重置/级联路径对「从未钉扎」的主机必须幂等成功
// （e2e 首跑即暴露：对未连接过的新主机调 reset 曾把 ErrNotFound 透传成 500）
func TestSSHHostKeyDeleteIdempotent(t *testing.T) {
	initTOFUStore(t)
	if err := store.Get().SSHHostKey.Delete("never-pinned.example", 22); err != nil {
		t.Fatalf("delete on unpinned host should succeed (idempotent), got %v", err)
	}
}

func TestFingerprintOfFormat(t *testing.T) {
	signer := randomHostSigner(t)
	fp := fingerprintOf(signer.PublicKey())
	if !strings.HasPrefix(fp, "SHA256:") || strings.HasSuffix(fp, "=") {
		t.Fatalf("fingerprint format (ssh-keygen -lf style) unexpected: %q", fp)
	}
	if fp != fingerprintOf(signer.PublicKey()) {
		t.Fatal("fingerprint should be deterministic")
	}
}

// tofuDocKey 复算 store 落盘文件名（sha256(host:port) 前 32 hex 字符，
// 与 store.sshHostKeyKey 同构——测试无法访问未导出函数，独立对拍防漂移）
func tofuDocKey(t *testing.T, port int) string {
	t.Helper()
	sum := sha256.Sum256([]byte("127.0.0.1:" + strconv.Itoa(port)))
	return hex.EncodeToString(sum[:16])
}
