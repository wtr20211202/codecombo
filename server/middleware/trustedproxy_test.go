package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// 可信代理装配（P-20261020-1）：ApplyTrustedProxies 必须同时收口 Gin 的
// ClientIP 信任面——默认（空清单）忽略 XFF；显式配置后仅直连对端命中清单
// 才采信 XFF/Real-IP，且链式 XFF 的伪造最左值不被采信（Gin 自右向左找
// 第一个非可信跳）。用真实 gin.Engine 驱动，验证的是启动期装配点本身。

func newTrustedProxyTestEngine(t *testing.T, entries []string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := ApplyTrustedProxies(r, entries); err != nil {
		t.Fatalf("ApplyTrustedProxies(%v): %v", entries, err)
	}
	t.Cleanup(func() { _ = ApplyTrustedProxies(gin.New(), nil) })
	r.GET("/ip", func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) })
	return r
}

func clientIPWithHeaders(t *testing.T, r *gin.Engine, remoteAddr string, headers map[string]string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/ip", nil)
	req.RemoteAddr = remoteAddr
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	return w.Body.String()
}

// TestApplyTrustedProxies_DefaultIgnoresForwardedHeaders 默认空清单 = 不信任
// 任何转发头：直连客户端伪造 XFF 应被忽略（修复 Gin 默认信任所有代理）。
func TestApplyTrustedProxies_DefaultIgnoresForwardedHeaders(t *testing.T) {
	r := newTrustedProxyTestEngine(t, nil)
	got := clientIPWithHeaders(t, r, "192.0.2.1:1234", map[string]string{
		"X-Forwarded-For": "203.0.113.9",
	})
	if got != "192.0.2.1" {
		t.Fatalf("ClientIP = %q, want direct peer 192.0.2.1", got)
	}
}

// TestApplyTrustedProxies_TrustedPeerHonorsForwardedHeaders 直连对端命中清单
// 时采信 XFF（反代拿真实客户端 IP）。
func TestApplyTrustedProxies_TrustedPeerHonorsForwardedHeaders(t *testing.T) {
	r := newTrustedProxyTestEngine(t, []string{"192.0.2.1"})
	got := clientIPWithHeaders(t, r, "192.0.2.1:1234", map[string]string{
		"X-Forwarded-For": "203.0.113.9",
	})
	if got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q, want forwarded 203.0.113.9", got)
	}
}

// TestApplyTrustedProxies_SpoofedLeftmostIgnored 追加式 XFF（$proxy_add_
// x_forwarded_for）下最左值可由客户端伪造：Gin 自右向左找第一个非可信代理，
// 返回真实客户端而非伪造值。
func TestApplyTrustedProxies_SpoofedLeftmostIgnored(t *testing.T) {
	r := newTrustedProxyTestEngine(t, []string{"192.0.2.0/24"})
	got := clientIPWithHeaders(t, r, "192.0.2.1:1234", map[string]string{
		"X-Forwarded-For": "1.1.1.1, 203.0.113.9",
	})
	if got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q, want rightmost untrusted hop 203.0.113.9", got)
	}
}

// TestApplyTrustedProxies_InvalidFallsBackToNoTrust 非法条目不得带病放行：
// 返回错误且两处信任面都降级为无信任（伪造 XFF 被忽略）。
func TestApplyTrustedProxies_InvalidFallsBackToNoTrust(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := ApplyTrustedProxies(r, []string{"not-an-ip"}); err == nil {
		t.Fatal("expected validation error for invalid trusted proxy")
	}
	t.Cleanup(func() { _ = ApplyTrustedProxies(gin.New(), nil) })
	r.GET("/ip", func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) })
	got := clientIPWithHeaders(t, r, "192.0.2.1:1234", map[string]string{
		"X-Forwarded-For": "203.0.113.9",
	})
	if got != "192.0.2.1" {
		t.Fatalf("invalid config must disable trust, ClientIP = %q", got)
	}
}
