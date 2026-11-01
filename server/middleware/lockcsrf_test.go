package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// P-20261019-2 ④：cookie 载体引入的环境凭据 CSRF 面。SameSite=Strict 挡跨「站」，
// 但站判定不含端口——同主机另一端口（dsh 控制台/端口预览页面，恰是本提案威胁面）
// 对浏览器是 same-site，Strict cookie 照常携带，写方法必须按源（host:port）校验。

// newCSRFTestRouter 写端点 + 读端点，均挂 LockCSRF（不挂锁中间件——本表钉的是
// CSRF 层自身语义，与鉴权正交）
func newCSRFTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(LockCSRF())
	r.POST("/do", func(c *gin.Context) { c.String(200, "ok") })
	r.PUT("/do", func(c *gin.Context) { c.String(200, "ok") })
	r.DELETE("/do", func(c *gin.Context) { c.String(200, "ok") })
	r.PATCH("/do", func(c *gin.Context) { c.String(200, "ok") })
	r.GET("/do", func(c *gin.Context) { c.String(200, "ok") })
	return r
}

func TestLockCSRF(t *testing.T) {
	r := newCSRFTestRouter()

	cases := []struct {
		name    string
		method  string
		origin  string
		fetchPt string
		want    int
	}{
		{"非浏览器客户端（无 Origin/Sec-Fetch-Site）放行", "POST", "", "", 200},
		{"同源 POST 放行", "POST", "http://127.0.0.1:9999", "same-origin", 200},
		{"同源 PUT 放行", "PUT", "http://127.0.0.1:9999", "same-origin", 200},
		{"同源 DELETE 放行", "DELETE", "http://127.0.0.1:9999", "", 200},
		{"同源 PATCH 放行", "PATCH", "http://127.0.0.1:9999", "", 200},
		{"跨源 POST（异主机）拒绝", "POST", "http://evil.example", "cross-site", 403},
		{"同主机异端口（same-site）POST 拒绝——本提案核心威胁面", "POST", "http://127.0.0.1:5173", "same-site", 403},
		{"同主机异端口无 Sec-Fetch-Site 仍按 Origin 拒绝", "POST", "http://127.0.0.1:5173", "", 403},
		{"Origin 缺失但 Sec-Fetch-Site=cross-site 拒绝", "POST", "", "cross-site", 403},
		{"Origin 缺失但 Sec-Fetch-Site=same-site 拒绝", "POST", "", "same-site", 403},
		{"Sec-Fetch-Site=none（用户发起导航表单）放行", "POST", "", "none", 200},
		{"GET 不受 CSRF 校验（读面由 CORS 同源开关闭合）", "GET", "http://evil.example", "cross-site", 200},
		{"scheme 不同的同 host:port 放行（反代终止 TLS 形态，与 ws.SameOrigin 同线）", "POST", "https://127.0.0.1:9999", "same-origin", 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/do", nil)
			req.Host = "127.0.0.1:9999"
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.fetchPt != "" {
				req.Header.Set("Sec-Fetch-Site", tc.fetchPt)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Errorf("%s %s origin=%q sec-fetch-site=%q: expected %d, got %d body=%s",
					tc.method, "/do", tc.origin, tc.fetchPt, tc.want, w.Code, w.Body.String())
			}
		})
	}
}

// TestLockCSRF_OriginHostMismatch 同源校验按 host:port 精确对齐（ws.SameOrigin 同款）
func TestLockCSRF_OriginHostMismatch(t *testing.T) {
	r := newCSRFTestRouter()
	req := httptest.NewRequest("POST", "/do", nil)
	req.Host = "127.0.0.1:9999"
	req.Header.Set("Origin", "http://127.0.0.1:9999/api") // host 不同（多了路径不影响，此处 host 一致）→ 放行由 SameOrigin 判定
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("same host:port origin with path should pass, got %d", w.Code)
	}

	// 畸形 Origin（不可解析）→ 拒绝
	req2 := httptest.NewRequest("POST", "/do", nil)
	req2.Host = "127.0.0.1:9999"
	req2.Header.Set("Origin", "::::")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != 403 {
		t.Errorf("malformed origin should be rejected, got %d", w2.Code)
	}
}
