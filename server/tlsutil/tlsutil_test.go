package tlsutil

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestEnsureCert_GeneratesAndReuses 首次生成 + 重启复用同一证书
func TestEnsureCert_GeneratesAndReuses(t *testing.T) {
	dir := t.TempDir()

	cert1, key1, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}
	if _, err := os.Stat(cert1); err != nil {
		t.Fatalf("cert file missing: %v", err)
	}
	if _, err := os.Stat(key1); err != nil {
		t.Fatalf("key file missing: %v", err)
	}
	// 私钥权限收紧（同机其他用户不可读）；Windows 的 Go 文件权限位是
	// 模拟值（只读位映射），ACL 语义不同，仅 Unix 断言
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(key1); err == nil && info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("key.pem too open: %v", info.Mode().Perm())
		}
	}

	cert2, key2, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert reuse: %v", err)
	}
	if cert1 != cert2 || key1 != key2 {
		t.Fatal("restart regenerated the certificate — must reuse for stable TOFU fingerprint")
	}
}

// TestEnsureCert_SANs 自签证书 SAN 必须覆盖 localhost/回环/本机主机名，
// 局域网按 IP 访问时浏览器证书提示才不至于连域名都对不上
func TestEnsureCert_SANs(t *testing.T) {
	dir := t.TempDir()
	certPath, _, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}

	data, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read cert: %v", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatal("no PEM block")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}

	hasDNS := func(name string) bool {
		for _, d := range cert.DNSNames {
			if strings.EqualFold(d, name) {
				return true
			}
		}
		return false
	}
	if !hasDNS("localhost") {
		t.Errorf("SAN missing localhost, got %v", cert.DNSNames)
	}
	if h, _ := os.Hostname(); h != "" && !hasDNS(h) {
		t.Errorf("SAN missing hostname %q, got %v", h, cert.DNSNames)
	}
	hasIP := func(ip string) bool {
		for _, v := range cert.IPAddresses {
			if v.String() == ip {
				return true
			}
		}
		return false
	}
	if !hasIP("127.0.0.1") {
		t.Errorf("SAN missing 127.0.0.1, got %v", cert.IPAddresses)
	}
}

// TestEnsureCert_KeyOnlyIsError 只剩 key.pem（cert 被删）必须报错而非静默重签——
// 静默换证书会让客户端固定的指纹悄悄失效
func TestEnsureCert_KeyOnlyIsError(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := EnsureCert(dir); err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "cert.pem")); err != nil {
		t.Fatalf("remove cert: %v", err)
	}
	if _, _, err := EnsureCert(dir); err == nil {
		t.Fatal("expected error when cert.pem is missing but key.pem exists")
	}
}

// TestFingerprint 指纹为 32 字节 SHA-256 的冒号十六进制
func TestFingerprint(t *testing.T) {
	dir := t.TempDir()
	certPath, _, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}
	fp, err := Fingerprint(certPath)
	if err != nil {
		t.Fatalf("Fingerprint: %v", err)
	}
	if got := strings.Count(fp, ":"); got != 31 {
		t.Fatalf("fingerprint %q should have 31 colons (32 bytes), got %d", fp, got)
	}
}

// TestTLSListenerServesAPIAndWSS 集成：生成的证书可直接用于 TLS 监听，
// HTTPS API 与 WSS 握手在同一端口工作（生产形态的等价小样）
func TestTLSListenerServesAPIAndWSS(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux.HandleFunc("/ws/echo", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, msg); err != nil {
				return
			}
		}
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	// 资源边界：慢连接占资源防护（生产 srv 同样配置）
	srv := &http.Server{
		Handler:           mux,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
	}
	go func() { _ = srv.ServeTLS(ln, certPath, keyPath) }()
	defer srv.Close()

	// 信任本目录证书（生产等价：系统信任库装入 cert.pem）
	pemData, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read cert: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pemData)
	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
	}
	resp, err := client.Get("https://" + ln.Addr().String() + "/api/health")
	if err != nil {
		t.Fatalf("https api: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status %d", resp.StatusCode)
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		HandshakeTimeout: 5 * time.Second,
	}
	ws, _, err := dialer.Dial("wss://"+ln.Addr().String()+"/ws/echo", nil)
	if err != nil {
		t.Fatalf("wss dial: %v", err)
	}
	defer ws.Close()
	const payload = "hello-wss"
	if err := ws.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(msg) != payload {
		t.Fatalf("echo mismatch: %s", msg)
	}
}
