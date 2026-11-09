package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	mw "codecombo/server/middleware"
	sharecore "codecombo/server/share"
)

// 分享访客面同源入口（P-20261020-2）：/s/* 与三个 vendored 资产在主引擎上
// 匿名可达（不经 Lock/Token 鉴权组）、路径原样直通、分享服务响应头保留，
// 主应用 CSP Report-Only 被剥除；/assets/* 其余路径不被吞掉（Vite 产物）。

func TestShareSameOriginGatewayRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var seen []string
	sharecore.SetSameOriginHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, sharecore.ClientIP(r))
	}))
	t.Cleanup(sharecore.ClearSameOriginHandler)

	r := gin.New()
	RegisterRoutes(r)
	// 可信代理链（P-20261020-1）：XFF 只在对端可信时采信；这里验证同源
	// 入口把 Gin 解析出的真实客户端 IP 注入分享服务（审计/限流同口径）
	if err := mw.ApplyTrustedProxies(r, []string{"127.0.0.1"}); err != nil {
		t.Fatalf("ApplyTrustedProxies: %v", err)
	}
	t.Cleanup(func() { _ = mw.ApplyTrustedProxies(r, nil) })

	cases := []struct {
		method, path string
		wantBody     string
	}{
		{http.MethodGet, "/s/abcd1234efgh5678", "203.0.113.5"},
		{http.MethodGet, "/s/abcd1234efgh5678/meta?path=docs", "203.0.113.5"},
		{http.MethodPost, "/s/abcd1234efgh5678/gate", "203.0.113.5"},
		{http.MethodGet, "/assets/xterm.js", "203.0.113.5"},
		{http.MethodGet, "/assets/addon-fit.js", "203.0.113.5"},
		{http.MethodGet, "/assets/xterm.css", "203.0.113.5"},
		{http.MethodGet, "/assets/addon-unicode11.js", "203.0.113.5"},
		{http.MethodGet, "/assets/JetBrainsMono-Regular.woff2", "203.0.113.5"},
		{http.MethodGet, "/assets/JetBrainsMono-Bold.woff2", "203.0.113.5"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.RemoteAddr = "127.0.0.1:50000"
		req.Header.Set("X-Forwarded-For", "203.0.113.5")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s %s status = %d, body=%s", tc.method, tc.path, w.Code, w.Body.String())
		}
		// 未走 LockMiddleware/TokenAuthMiddleware：锁定态下访客面也必须是 200
		if got := w.Body.String(); got != tc.wantBody {
			t.Fatalf("%s %s body = %q, want trusted client IP %q", tc.method, tc.path, got, tc.wantBody)
		}
		// 分享服务自身头保留；主应用观察期 CSP 不上身（访客页内联脚本会误报）
		if got := w.Header().Get("X-Frame-Options"); got != "DENY" {
			t.Fatalf("%s %s X-Frame-Options = %q, want DENY", tc.method, tc.path, got)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s %s Cache-Control = %q, want no-store", tc.method, tc.path, got)
		}
		if got := w.Header().Get(mw.HeaderCSPReportOnly); got != "" {
			t.Fatalf("%s %s leaked main CSP Report-Only: %q", tc.method, tc.path, got)
		}
	}
	for _, path := range []string{"/s/abcd1234efgh5678", "/assets/xterm.js"} {
		found := false
		for _, got := range seen {
			if got == path {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("gateway handler did not receive %q (seen %v)", path, seen)
		}
	}

	// 主应用 Vite 产物同住 /assets/：未列入白名单的名字不得被分享代理吞掉
	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("main-app asset status = %d, want 404 (must not be proxied to share)", w.Code)
	}
	for _, got := range seen {
		if got == "/assets/index-abc123.js" {
			t.Fatal("main-app asset was forwarded to the share service")
		}
	}
}

// 分享子服务未就绪（模块未启动/监听失败）时同源路径回 503，不落 SPA index。
func TestShareSameOriginGatewayUnavailable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sharecore.ClearSameOriginHandler()
	r := gin.New()
	RegisterRoutes(r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/abcd1234efgh5678", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when share service is not ready", w.Code)
	}
}
