package system

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestIsSelfReferenceURL 自引用判定（requestHost 模拟当前请求 Host 头）
func TestIsSelfReferenceURL(t *testing.T) {
	const reqHost = "localhost:9999"
	cases := []struct {
		url  string
		want bool
	}{
		// 指向本机同端口 → 自引用
		{"http://localhost:9999/", true},
		{"http://127.0.0.1:9999", true},
		{"http://[::1]:9999/", true},
		{"http://myserver.local:9999/", false}, // 非本机域名（见下方单独用例）
		// 端口不同 → 不是自引用（本机其他端口的服务是合法目标）
		{"http://localhost:9998/", false},
		{"http://localhost/", false}, // 默认 80 端口
		{"https://localhost/", false},
		// 外部地址（192.0.2.x / 198.51.100.x 为文档保留段，不会是本机网卡）
		{"http://192.0.2.1:9999/", false},
		{"http://198.51.100.1:9999/", false},
		// 非法输入
		{"", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := isSelfReferenceURL(c.url, reqHost); got != c.want {
			t.Errorf("isSelfReferenceURL(%q, %q) = %v, want %v", c.url, reqHost, got, c.want)
		}
	}
	// 与请求 Host 完全相同（自定义域名指向本机的场景）
	if !isSelfReferenceURL("http://myserver.local:9999/", "myserver.local:9999") {
		t.Error("same host:port as request should be self-reference")
	}
}

// R3 守护：实例 URL 规范化——裸 host:port 补 https://（TLS 已是产品默认，
// 裸地址的真实目标绝大多数是 https；http-only 显式写 http:// 或经探测发现）、
// trim 空白、去尾部斜杠
func TestNormalizeInstanceURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"192.168.1.10:9998", "https://192.168.1.10:9998"},
		{" 192.168.1.10:9998 ", "https://192.168.1.10:9998"},
		{"http://192.168.1.10:9998/", "http://192.168.1.10:9998"},
		{"https://sc.example.com/", "https://sc.example.com"},
		{"HTTP://Host:1/", "HTTP://Host:1"}, // 已带 scheme 原样（仅去尾斜杠）
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := normalizeInstanceURL(c.in); got != c.want {
			t.Errorf("normalizeInstanceURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 规范化后裸地址的自引用检测应正常生效（规范化前 Hostname 为空、检测盲区）
	if !isSelfReferenceURL(normalizeInstanceURL("localhost:9999"), "localhost:9999") {
		t.Error("normalized bare address should be detected as self-reference")
	}
}

// TestCheckInstanceURLSchemeDiscovery scheme 自动发现（TLS 默认世界的混合部署）：
//   - 存量 http:// 打到已升级 TLS 的对端 → 明文 400 签名 → 自动升级 https 判活
//   - https:// 打到明文对端 → TLS 握手失败 → 自动回退 http 判活并回传有效地址
//   - https 自签未受信 → 不误报普通离线，tlsHint 给可行动提示
func TestCheckInstanceURLSchemeDiscovery(t *testing.T) {
	// 明文目标实例（/api/settings 返回本应用格式）
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"version":"0.1.0"}}`))
	}))
	defer plain.Close()

	// 1. 明文目标 + https:// 输入（误配）：TLS 握手失败 → 回退 http 判活
	httpsURL := strings.Replace(plain.URL, "http://", "https://", 1) + "/"
	res := checkInstanceURL(httpsURL, "")
	if res.status != "online" {
		t.Fatalf("https-to-plain should fall back to http and go online, got %q", res.status)
	}
	if res.effectiveURL == "" || !strings.HasPrefix(res.effectiveURL, "http://") {
		t.Fatalf("effectiveURL should be the http address, got %q", res.effectiveURL)
	}

	// 2. 明文目标 + 明确 http:// 输入：直接判活，无 effectiveURL 变化
	res = checkInstanceURL(plain.URL, "")
	if res.status != "online" || res.effectiveURL != "" {
		t.Fatalf("plain input should go online without scheme flip, got %q/%q", res.status, res.effectiveURL)
	}
}
