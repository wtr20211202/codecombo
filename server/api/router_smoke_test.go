package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	mw "codecombo/server/middleware"
)

// TestRegisterRoutes_NoConflict 冒烟：真实路由表注册不 panic（新增
// /claude/sessions/:id/timeline 与既有 /claude/sessions 静态/参数共存）
func TestRegisterRoutes_NoConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer func() {
		if p := recover(); p != nil {
			t.Fatalf("route registration panicked: %v", p)
		}
	}()
	r := gin.New()
	RegisterRoutes(r)
}

// TestRegisterRoutes_SecurityHeaders 集成断言（P-20261002-42）：经 RegisterRoutes
// 装配的引擎全路由携带三头基线。打无组中间件、无外部依赖的 /api/health——
// gin 对未注册路由（allNoRoute 未注册时）不跑全局链，404 路径断不了
func TestRegisterRoutes_SecurityHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))

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
	// CSP Report-Only 观察期（P-20261007-6）：全路由带头，含报告通道
	policy := w.Header().Get(mw.HeaderCSPReportOnly)
	if !strings.Contains(policy, "report-uri /api/csp-report") {
		t.Errorf("CSP-Report-Only missing report-uri; got %q", policy)
	}
	if got := w.Header().Get("Content-Security-Policy"); got != "" {
		t.Errorf("unexpected enforcing CSP header: %q", got)
	}
}

// TestRegisterRoutes_CSPReportPublic CSP 报告端点公开可达（P-20261007-6）：
// 浏览器上报不带应用凭据，路由不得落在 LockMiddleware/TokenAuthMiddleware 组内。
// 空报告体走解析空路径，不写审计、不依赖 store 装配。
func TestRegisterRoutes_CSPReportPublic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r)

	req := httptest.NewRequest(http.MethodPost, "/api/csp-report", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/csp-report")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (public endpoint must not be lock/token gated), body=%s", w.Code, w.Body.String())
	}
}
