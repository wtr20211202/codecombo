package update

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/config"
)

// 更新链传输代理支持（P-20261109-12）面测试：
//   - 显式 http 代理走 CONNECT 隧道、socks5 代理走 SOCKS5 握手（测试内自起本地
//     代理——不改本机/WSL 系统代理、持久 env、git/npm 配置，护栏硬性）；
//   - 出站选路三态（显式代理 > 环境变量 > 直连）与代理域白名单守卫；
//   - 直连档守卫回归：回环/内网/坏 IP 仍拒，多 IP 逐试语义保持。

// ── 测试用本地代理（进程内起停，零外部副作用）─────────────────────────────

// targetLog 记录代理看到的 CONNECT/SOCKS5 目标（host:port）
type targetLog struct {
	mu      sync.Mutex
	targets []string
}

func (l *targetLog) add(t string) {
	l.mu.Lock()
	l.targets = append(l.targets, t)
	l.mu.Unlock()
}

func (l *targetLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.targets...)
}

// pipeBoth 双向搬运（非阻塞：goroutine 各自跑到 EOF/错误为止）。隧道连接的
// 生命周期由 tunnelSet 统一管理——被劫持的连接不再归 http.Server 管，也不能
// 在 handler 返回时立刻 Close（会把在途隧道掐断）
func pipeBoth(a, b net.Conn) {
	go func() { _, _ = io.Copy(a, b) }()
	go func() { _, _ = io.Copy(b, a) }()
}

// tunnelSet 测试代理的在途隧道连接注册表：closeProxy 统一断流，
// 拷贝 goroutine 随即退出
type tunnelSet struct {
	mu    sync.Mutex
	conns []net.Conn
}

func (s *tunnelSet) add(c net.Conn) {
	s.mu.Lock()
	s.conns = append(s.conns, c)
	s.mu.Unlock()
}

func (s *tunnelSet) closeAll() {
	s.mu.Lock()
	conns := s.conns
	s.conns = nil
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// startHTTPConnectProxy 起一个最小本地 HTTP CONNECT 代理。代理解析语义：
// CONNECT 目标 host:port 由代理端 Dial（本测试里即回环）
func startHTTPConnectProxy(t *testing.T) (proxyURL string, log *targetLog, done func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	log = &targetLog{}
	tunnels := &tunnelSet{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		log.add(r.Host)
		backend, err := net.Dial("tcp", r.Host)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			_ = backend.Close()
			http.Error(w, "hijack unsupported", http.StatusInternalServerError)
			return
		}
		conn, brw, err := hj.Hijack()
		if err != nil {
			_ = backend.Close()
			return
		}
		tunnels.add(conn)
		tunnels.add(backend)
		_, _ = brw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = brw.Flush()
		pipeBoth(conn, backend)
	})}
	go func() { _ = srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), log, func() {
		_ = srv.Close()
		tunnels.closeAll()
	}
}

// startSOCKS5Proxy 起一个最小 SOCKS5 无鉴权 CONNECT 代理（RFC 1928 子集：
// 方法协商 0x00 + CONNECT + IPv4/域名地址型）。域名原样在代理端解析（socks5h 语义）
func startSOCKS5Proxy(t *testing.T) (proxyURL string, log *targetLog, done func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	log = &targetLog{}
	tunnels := &tunnelSet{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleSOCKS5(conn, log, tunnels)
		}
	}()
	return "socks5://" + ln.Addr().String(), log, func() {
		_ = ln.Close()
		tunnels.closeAll()
	}
}

func handleSOCKS5(conn net.Conn, log *targetLog, tunnels *tunnelSet) {
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(conn, hdr); err != nil || hdr[0] != 5 {
		_ = conn.Close()
		return
	}
	methods := make([]byte, hdr[1])
	if _, err := io.ReadFull(conn, methods); err != nil {
		_ = conn.Close()
		return
	}
	// 无鉴权（net/http transport 会同时提供 0x00/0x02，服务端选 0x00）
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		_ = conn.Close()
		return
	}
	req := make([]byte, 4)
	if _, err := io.ReadFull(conn, req); err != nil || req[1] != 1 { // CONNECT only
		_ = conn.Close()
		return
	}
	var host string
	switch req[3] {
	case 1: // IPv4
		b := make([]byte, 4)
		if _, err := io.ReadFull(conn, b); err != nil {
			_ = conn.Close()
			return
		}
		host = net.IP(b).String()
	case 3: // 域名
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			_ = conn.Close()
			return
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(conn, b); err != nil {
			_ = conn.Close()
			return
		}
		host = string(b)
	default:
		_ = conn.Close()
		return
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(conn, port); err != nil {
		_ = conn.Close()
		return
	}
	target := net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port))))
	log.add(target)
	backend, err := net.Dial("tcp", target)
	if err != nil {
		_, _ = conn.Write([]byte{5, 1, 0, 1, 0, 0, 0, 0, 0, 0}) // general failure
		_ = conn.Close()
		return
	}
	tunnels.add(conn)
	tunnels.add(backend)
	_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}) // success
	pipeBoth(conn, backend)
}

// ── 夹具 ────────────────────────────────────────────────────────────────

// resetOutboundForTest 测试期出站态治理：进出站配置与 env 探询口快照回滚
func resetOutboundForTest(t *testing.T) {
	t.Helper()
	prevState := outbound.Load()
	prevHook := envProxyFor
	t.Cleanup(func() {
		outbound.Store(prevState)
		envProxyFor = prevHook
	})
}

// proxyTLSClient 构造信任 httptest 自签证书的代理档 client（隧道层真实形态：
// CONNECT/SOCKS5 之后照常做 TLS 握手）
func proxyTLSClient(t *testing.T, ts *httptest.Server, proxyURL string) *http.Client {
	t.Helper()
	tr := newProxyTransport(mustParseRaw(t, proxyURL))
	if tc, ok := ts.Client().Transport.(*http.Transport); ok && tc.TLSClientConfig != nil {
		tr.TLSClientConfig = tc.TLSClientConfig
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: tr}
}

func mustParseRaw(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

const stableAssetBody = `{"tag_name":"v0.1.0","assets":[
	{"name":"codecombo-linux-amd64","browser_download_url":"https://example/stable","size":1}]}`

// ── 代理档端到端：CONNECT 隧道 ───────────────────────────────────────────

// TestFetchViaHTTPConnectProxy 显式 http 代理：请求经 CONNECT 隧道到目标 TLS
// 服务，代理记录到 CONNECT 目标；FetchLatest 全程无直连
func TestFetchViaHTTPConnectProxy(t *testing.T) {
	resetOutboundForTest(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(stableAssetBody))
	})
	ts := httptest.NewTLSServer(mux)
	defer ts.Close()

	proxyURL, log, closeProxy := startHTTPConnectProxy(t)
	defer closeProxy()

	s := &GitHubSource{
		RepoURL: ts.URL + "/owner/repo",
		client:  proxyTLSClient(t, ts, proxyURL),
	}
	info, err := s.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("fetch via CONNECT proxy: %v", err)
	}
	if info.Version != "0.1.0" {
		t.Fatalf("version = %q, want 0.1.0", info.Version)
	}
	targets := log.snapshot()
	if len(targets) == 0 {
		t.Fatal("proxy saw no CONNECT target")
	}
	if want := mustParseRaw(t, ts.URL).Host; targets[0] != want {
		t.Fatalf("CONNECT target = %q, want %q", targets[0], want)
	}
}

// ── 代理档端到端：SOCKS5 ─────────────────────────────────────────────────

// TestFetchViaSOCKS5Proxy 显式 socks5 代理：net/http 原生 SOCKS5 握手 + 目标
// 经代理端 Dial（IP 字面量形态），FetchLatest 成功且代理记录到目标
func TestFetchViaSOCKS5Proxy(t *testing.T) {
	resetOutboundForTest(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(stableAssetBody))
	})
	ts := httptest.NewTLSServer(mux)
	defer ts.Close()

	proxyURL, log, closeProxy := startSOCKS5Proxy(t)
	defer closeProxy()

	s := &GitHubSource{
		RepoURL: ts.URL + "/owner/repo",
		client:  proxyTLSClient(t, ts, proxyURL),
	}
	info, err := s.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("fetch via SOCKS5 proxy: %v", err)
	}
	if info.Version != "0.1.0" {
		t.Fatalf("version = %q, want 0.1.0", info.Version)
	}
	targets := log.snapshot()
	if len(targets) == 0 {
		t.Fatal("socks5 proxy saw no CONNECT target")
	}
	if want := mustParseRaw(t, ts.URL).Host; targets[0] != want {
		t.Fatalf("SOCKS5 target = %q, want %q", targets[0], want)
	}
}

// ── 出站选路与守卫 ───────────────────────────────────────────────────────

func TestRoundTripperSelection(t *testing.T) {
	resetOutboundForTest(t)

	official := mustParseRaw(t, "https://api.github.com/repos/o/r/releases/latest")
	nonOfficial := mustParseRaw(t, "https://mirror.example.com/owner/repo/releases/latest")

	// 直连默认（无显式代理 + env 未命中）：directTransport 本体，历史行为零变化
	envProxyFor = func(*url.URL) (*url.URL, error) { return nil, nil }
	rt, err := roundTripperFor(official)
	if err != nil {
		t.Fatal(err)
	}
	if rt != http.RoundTripper(directTransport) {
		t.Fatal("no-proxy selection must return directTransport")
	}

	// 环境变量命中：官方域走代理档；非官方域被白名单拒（代理代解析 → 域守卫）
	envProxy := mustParseRaw(t, "http://envproxy.example:3128")
	envProxyFor = func(*url.URL) (*url.URL, error) { return envProxy, nil }
	rt, err = roundTripperFor(official)
	if err != nil {
		t.Fatal(err)
	}
	if rt != proxyTransportFor(envProxy) {
		t.Fatal("env proxy hit must return proxy transport")
	}
	if _, err := roundTripperFor(nonOfficial); err == nil {
		t.Fatal("env-proxied non-official domain must be rejected")
	}

	// NO_PROXY 豁免形态（env 探询对某 host 返回 nil）：直连档承接，IP 守卫保持
	envProxyFor = func(u *url.URL) (*url.URL, error) {
		if u.Hostname() == "api.github.com" {
			return envProxy, nil
		}
		return nil, nil
	}
	rt, err = roundTripperFor(mustParseRaw(t, "https://objects.githubusercontent.com/a"))
	if err != nil {
		t.Fatal(err)
	}
	if rt != http.RoundTripper(directTransport) {
		t.Fatal("NO_PROXY-exempt host must go direct")
	}

	// 显式设置代理：对更新链全量生效；官方域与显式配置的更新源 host 均放行，
	// 其余域拒
	if err := SetOutbound("http://explicit.example:8080", "gitea.example.com"); err != nil {
		t.Fatal(err)
	}
	rt, err = roundTripperFor(official)
	if err != nil {
		t.Fatal(err)
	}
	explicitProxy := mustParseRaw(t, "http://explicit.example:8080")
	if rt != proxyTransportFor(explicitProxy) {
		t.Fatal("explicit proxy must be used for official domains")
	}
	rt, err = roundTripperFor(mustParseRaw(t, "https://gitea.example.com/owner/repo/releases/latest"))
	if err != nil {
		t.Fatalf("configured source host must pass proxy whitelist: %v", err)
	}
	if rt != proxyTransportFor(explicitProxy) {
		t.Fatal("configured source host must use explicit proxy transport")
	}
	if _, err := roundTripperFor(nonOfficial); err == nil {
		t.Fatal("non-official host under explicit proxy must be rejected")
	}

	// 内网 IP 目标：即使代理代解析使拨号期复查不可用，字面层白名单仍收口
	if err := SetOutbound("socks5://127.0.0.1:1080", ""); err != nil {
		t.Fatal(err)
	}
	_, err = roundTripperFor(mustParseRaw(t, "https://10.0.0.5/steal"))
	if err == nil || !strings.Contains(err.Error(), "not an official trusted domain") {
		t.Fatalf("private IP target under proxy must be rejected, got %v", err)
	}
}

func TestCheckProxyTargetHost(t *testing.T) {
	resetOutboundForTest(t)
	_ = SetOutbound("", "gitea.example.com")

	cases := []struct {
		raw  string
		pass bool
	}{
		{"https://github.com/o/r/releases/download/v1/a", true},
		{"https://www.github.com/o/r", true},
		{"https://api.github.com/repos/o/r/releases/latest", true},
		{"https://objects.githubusercontent.com/x", true},
		{"https://release-assets.githubusercontent.com/x", true},
		{"https://gitea.example.com/o/r/releases/download/v1/a", true}, // 显式配置的更新源
		{"https://mirror.example.com/owner/repo", false},
		{"https://127.0.0.1:9999/x", false}, // 回环
		{"https://10.0.0.5/x", false},       // 内网 IP
		{"https://internal.lan/x", false},   // 内网域名
		{"http://api.github.com/x", false},  // 代理路径同样仅 https
		{"https://localhost:9999/x", false}, // 本机
	}
	for _, c := range cases {
		err := checkProxyTargetHost(mustParseRaw(t, c.raw))
		if c.pass != (err == nil) {
			t.Errorf("checkProxyTargetHost(%q) err=%v, pass=%v", c.raw, err, c.pass)
		}
	}
}

func TestSetOutboundInvalidProxyKeepsState(t *testing.T) {
	resetOutboundForTest(t)
	if err := SetOutbound("http://good.example:3128", ""); err != nil {
		t.Fatal(err)
	}
	if err := SetOutbound("ftp://bad.example", ""); err == nil {
		t.Fatal("invalid scheme must be rejected")
	}
	st := outbound.Load()
	if st == nil || st.proxy == nil || st.proxy.Host != "good.example:3128" {
		t.Fatalf("failed SetOutbound must keep previous state, got %+v", st)
	}
}

func TestNormalizeProxyURL(t *testing.T) {
	// 空串 = 清除（合法）：返回空且无错
	if got, err := NormalizeProxyURL(""); err != nil || got != "" {
		t.Fatalf("NormalizeProxyURL(\"\") = %q (%v), want empty cleared", got, err)
	}
	if got, err := NormalizeProxyURL("   "); err != nil || got != "" {
		t.Fatalf("NormalizeProxyURL(blank) = %q (%v), want empty cleared", got, err)
	}
	cases := []struct {
		in   string
		want string // "" = 期望错误
	}{
		{"http://proxy.example:8080", "http://proxy.example:8080"},
		{"https://proxy.example", "https://proxy.example:443"},
		{"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"socks5h://clash.example", "socks5h://clash.example:1080"},
		{"http://user:pass@proxy.example:3128", "http://user:pass@proxy.example:3128"},
		{"  http://proxy.example:8080  ", "http://proxy.example:8080"},
		{"ftp://proxy.example", ""},
		{"proxy.example:8080", ""}, // 无 scheme
		{"http://", ""},            // 无 host
		{"http://proxy.example:8080/path", ""},
		{"http://proxy.example:8080?x=1", ""},
	}
	for _, c := range cases {
		got, err := NormalizeProxyURL(c.in)
		if c.want == "" {
			if err == nil {
				t.Errorf("NormalizeProxyURL(%q) = %q, want error", c.in, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("NormalizeProxyURL(%q) = %q (%v), want %q", c.in, got, err, c.want)
		}
	}
}

// ── 直连档守卫回归（零变化验收）───────────────────────────────────────────

// TestDirectTransportGuardsLoopback 直连档（无任何代理）对回环目标仍拒——
// httptest 目标即回环，选路到 directTransport 后 DialContext 复查解析 IP
func TestDirectTransportGuardsLoopback(t *testing.T) {
	resetOutboundForTest(t)
	envProxyFor = func(*url.URL) (*url.URL, error) { return nil, nil }

	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()

	rt, err := roundTripperFor(mustParseRaw(t, ts.URL))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, ts.URL, nil)
	_, err = rt.RoundTrip(req)
	if err == nil || !strings.Contains(err.Error(), "local/private/reserved") {
		t.Fatalf("direct transport must reject loopback target, got %v", err)
	}
}

// TestCheckResolvedIPsMixed 多 IP 中任一坏 IP 即拒（多 IP/坏 IP 语义保持）
func TestCheckResolvedIPsMixed(t *testing.T) {
	good := net.IPAddr{IP: net.IPv4(1, 2, 3, 4)}
	if err := checkResolvedIPs("h", []net.IPAddr{good, {IP: net.IPv4(5, 6, 7, 8)}}); err != nil {
		t.Fatalf("all-public list must pass: %v", err)
	}
	for _, bad := range []net.IPAddr{
		{IP: net.ParseIP("127.0.0.1")},   // loopback
		{IP: net.ParseIP("10.0.0.5")},    // private
		{IP: net.ParseIP("169.254.1.2")}, // link-local
		{IP: net.ParseIP("224.0.0.1")},   // multicast
		{IP: net.IPv4zero},               // unspecified
	} {
		if err := checkResolvedIPs("h", []net.IPAddr{good, bad}); err == nil {
			t.Fatalf("list with bad IP %v must be rejected", bad.IP)
		}
	}
}

// TestApplySourceOutboundWiring ApplySource 装配出站代理：合法串进状态、非法串
// 回退直连（env 感知仍在）、空串清除；sourceHost 进白名单
func TestApplySourceOutboundWiring(t *testing.T) {
	resetOutboundForTest(t)
	cfg := &config.Config{}

	// 显式代理合法：进出站态，sourceHost=官方源 host（github.com 网页形态）
	cfg.Server.UpdateProxy = "http://proxy.example:8080"
	ApplySource(cfg)
	st := outbound.Load()
	if st == nil || st.proxy == nil || st.proxy.Host != "proxy.example:8080" {
		t.Fatalf("ApplySource must register proxy, got %+v", st)
	}
	if st.sourceHost != "github.com" {
		t.Fatalf("sourceHost = %q, want github.com", st.sourceHost)
	}

	// 非法串：回退直连态（env 感知仍在），不阻断
	cfg.Server.UpdateProxy = "ftp://bad"
	ApplySource(cfg)
	st = outbound.Load()
	if st == nil || st.proxy != nil {
		t.Fatalf("invalid proxy must fall back to direct, got %+v", st)
	}

	// 空串：清除显式代理
	cfg.Server.UpdateProxy = ""
	ApplySource(cfg)
	if st := outbound.Load(); st.proxy != nil {
		t.Fatalf("empty proxy must clear state, got %+v", st)
	}
}
