package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestSecurityHeaders 三头基线：nosniff / Referrer-Policy / 帧嵌入限制（P-20261002-42）
func TestSecurityHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(SecurityHeaders())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ping", nil))

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
		"X-Frame-Options":        "SAMEORIGIN",
	}
	for h, v := range want {
		if got := w.Header().Get(h); got != v {
			t.Errorf("%s = %q; want %q", h, got, v)
		}
	}
}

// TestSecurityHeaders_CSPReportOnly CSP 观察期头（P-20261007-6）：初版策略完整
// 挂在 Report-Only（而非 enforcing），报告端点双写 report-uri + report-to；
// 生产策略不放行 'unsafe-eval'
func TestSecurityHeaders_CSPReportOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(SecurityHeaders())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ping", nil))

	policy := w.Header().Get(HeaderCSPReportOnly)
	if policy == "" {
		t.Fatal("Content-Security-Policy-Report-Only missing")
	}
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https: http:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self' blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"report-uri /api/csp-report",
		"report-to csp-endpoint",
	} {
		if !strings.Contains(policy, want) {
			t.Errorf("policy missing %q; got %q", want, policy)
		}
	}
	if strings.Contains(policy, "'unsafe-eval'") {
		t.Errorf("prod policy must not allow 'unsafe-eval'; got %q", policy)
	}
	// 只观察不拦截：不得有 enforcing 的 CSP 头（分享子服务独立，不走本中间件）
	if got := w.Header().Get("Content-Security-Policy"); got != "" {
		t.Errorf("unexpected enforcing CSP header: %q", got)
	}
	wantEndpoints := `csp-endpoint="/api/csp-report"`
	if got := w.Header().Get(HeaderReportingEndpoints); got != wantEndpoints {
		t.Errorf("%s = %q; want %q", HeaderReportingEndpoints, got, wantEndpoints)
	}
}

// TestSecurityHeaders_DevPolicy dev 分支（P-20261007-6）：本地/测试构建额外
// 放行 'unsafe-eval' 供 Vite HMR / Vue devtools，其余指令与生产一致
func TestSecurityHeaders_DevPolicy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(SecurityHeaders(true))
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ping", nil))

	policy := w.Header().Get(HeaderCSPReportOnly)
	if !strings.Contains(policy, "script-src 'self' 'unsafe-eval'") {
		t.Errorf("dev policy should allow 'unsafe-eval'; got %q", policy)
	}
	// dev 分支不改变其他指令（style 仍是如实保留的 unsafe-inline）
	if !strings.Contains(policy, "style-src 'self' 'unsafe-inline'") {
		t.Errorf("dev policy should keep style-src baseline; got %q", policy)
	}
}

// TestSecurityBaselineHeaders_CSP 转发剥除清单（P-20261007-6）：CSP 观察期头与
// Reporting-Endpoints 同属全局施加面，/proxy 需一并剥除防重复头
func TestSecurityBaselineHeaders_CSP(t *testing.T) {
	have := map[string]bool{}
	for _, h := range SecurityBaselineHeaders {
		have[h] = true
	}
	for _, h := range []string{HeaderCSPReportOnly, HeaderReportingEndpoints} {
		if !have[h] {
			t.Errorf("SecurityBaselineHeaders missing %s; got %v", h, SecurityBaselineHeaders)
		}
	}
}

// TestSecurityHeaders_DownstreamOverride Set 语义：下游 handler 可按需覆盖基线值
// （如未来某端点需要更严的 DENY）
func TestSecurityHeaders_DownstreamOverride(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(SecurityHeaders())
	r.GET("/strict", func(c *gin.Context) {
		c.Header("X-Frame-Options", "DENY")
		c.String(200, "ok")
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/strict", nil))

	if got := w.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q; want downstream DENY to win", got)
	}
	// 未被覆盖的头维持基线
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q; want nosniff", got)
	}
}
