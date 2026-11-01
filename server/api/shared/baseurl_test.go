package shared

import (
	"crypto/tls"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// manualContext 构造带指定 Host / 转发头 / TLS 态的请求上下文（helper 三态判定的
// 驱动面；directTLS 模拟 net/http 对 TLS 连接注入的 Request.TLS）
func manualContext(host string, forwarded map[string]string, directTLS bool) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "http://"+host+"/ops-manual", nil)
	for k, v := range forwarded {
		c.Request.Header.Set(k, v)
	}
	if directTLS {
		c.Request.TLS = &tls.ConnectionState{}
	}
	return c
}

// trustPeerForTest 把 httptest.NewRequest 的缺省直连对端（192.0.2.1）列入
// 可信代理；t.Cleanup 清空，避免进程级匹配器污染后续用例
func trustPeerForTest(t *testing.T, entries ...string) {
	t.Helper()
	if err := SetTrustedProxies(entries); err != nil {
		t.Fatalf("SetTrustedProxies(%v): %v", entries, err)
	}
	t.Cleanup(func() { _ = SetTrustedProxies(nil) })
}

// TestRequestBaseURL_Forwarded 双转发头在场且直连对端是可信代理 → 用转发值
// （P-20261004-129 反代形态：TLS 在反代终止，后端看不见 Request.TLS，转发头
// 是手册 scheme 的唯一线索；P-20261020-1 起仅在可信对端下采信）
func TestRequestBaseURL_Forwarded(t *testing.T) {
	trustPeerForTest(t, "192.0.2.1")
	c := manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "sc.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "https://sc.example.com" {
		t.Fatalf("forwarded https expect https://sc.example.com, got %q", got)
	}

	// http 转发值同样如实采用（反代后明文入口不是错误形态）
	c = manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "http",
		"X-Forwarded-Host":  "sc.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "http://sc.example.com" {
		t.Fatalf("forwarded http expect http://sc.example.com, got %q", got)
	}
}

// TestRequestBaseURL_ForwardedChain 链式代理的多段值取首段（首段=最靠近客户端
// 的一跳即真实入口）；proto 大小写规整；坏 proto 兜底 http 而非产出垃圾示例
func TestRequestBaseURL_ForwardedChain(t *testing.T) {
	trustPeerForTest(t, "192.0.2.1")
	c := manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "HTTPS, http",
		"X-Forwarded-Host":  "sc.example.com, internal:8080",
	}, false)
	if got := RequestBaseURL(c); got != "https://sc.example.com" {
		t.Fatalf("chained forwarded expect first hop, got %q", got)
	}

	c = manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "ftp", // 坏值：兜底 http，不产出 ftp:// 示例
		"X-Forwarded-Host":  "sc.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "http://sc.example.com" {
		t.Fatalf("bad proto expect http fallback, got %q", got)
	}
}

// TestRequestBaseURL_SingleForwardedHeader 双在场才采用转发值：单头在场信息
// 不完整（proto 有而 host 无 → host 到底是哪个入口不可知），回落直连判定
func TestRequestBaseURL_SingleForwardedHeader(t *testing.T) {
	trustPeerForTest(t, "192.0.2.1")
	c := manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "https",
	}, false)
	if got := RequestBaseURL(c); got != "http://127.0.0.1:3080" {
		t.Fatalf("proto-only expect direct-state http, got %q", got)
	}

	c = manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Host": "sc.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "http://127.0.0.1:3080" {
		t.Fatalf("host-only expect direct-state http, got %q", got)
	}
}

// TestRequestBaseURL_DirectTLS 直连 TLS（--tls 自带证书形态）→ https + Host
func TestRequestBaseURL_DirectTLS(t *testing.T) {
	c := manualContext("127.0.0.1:3080", nil, true)
	if got := RequestBaseURL(c); got != "https://127.0.0.1:3080" {
		t.Fatalf("direct TLS expect https, got %q", got)
	}
}

// TestRequestBaseURL_Default 缺省回归：明文直连维持 http + Host（既有形态零变化）
func TestRequestBaseURL_Default(t *testing.T) {
	c := manualContext("127.0.0.1:3080", nil, false)
	if got := RequestBaseURL(c); got != "http://127.0.0.1:3080" {
		t.Fatalf("default expect http://127.0.0.1:3080, got %q", got)
	}
}

// TestRequestBaseURL_UntrustedForwardedIgnored（P-20261020-1）直连对端不在
// server.trustedProxies 内时，伪造的 XFP/XFH 一律忽略——否则攻击者可把手册
// 示例地址指到自己域名（agent 被教去连攻击者入口）。默认（未配置）即此形态
func TestRequestBaseURL_UntrustedForwardedIgnored(t *testing.T) {
	c := manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "evil.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "http://127.0.0.1:3080" {
		t.Fatalf("untrusted forwarded headers must be ignored, got %q", got)
	}
}

// TestRequestBaseURL_TrustedProxyCIDR 可信代理按 CIDR 匹配（反代同机回环
// 常配 127.0.0.1/::1，跨网段反代配网段）
func TestRequestBaseURL_TrustedProxyCIDR(t *testing.T) {
	trustPeerForTest(t, "192.0.2.0/24")
	c := manualContext("127.0.0.1:3080", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "sc.example.com",
	}, false)
	if got := RequestBaseURL(c); got != "https://sc.example.com" {
		t.Fatalf("trusted CIDR should honor forwarded headers, got %q", got)
	}
}
