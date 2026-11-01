package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORS(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORS())
	r.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })

	do := func(origin, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://"+host+"/ping", nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	t.Run("同源请求回显 Origin", func(t *testing.T) {
		w := do("http://127.0.0.1:9999", "127.0.0.1:9999")
		if w.Code != 200 {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:9999" {
			t.Errorf("expected ACAO echo, got %q", got)
		}
	})

	t.Run("无 Origin 不带 CORS 头", func(t *testing.T) {
		w := do("", "127.0.0.1:9999")
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("expected empty ACAO, got %q", got)
		}
	})

	t.Run("跨源请求不授予跨域读取", func(t *testing.T) {
		w := do("http://evil.example.com", "127.0.0.1:9999")
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("expected empty ACAO for cross-origin, got %q", got)
		}
	})

	t.Run("预检请求 204", func(t *testing.T) {
		req := httptest.NewRequest("OPTIONS", "http://127.0.0.1:9999/ping", nil)
		req.Host = "127.0.0.1:9999"
		req.Header.Set("Origin", "http://127.0.0.1:9999")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNoContent {
			t.Errorf("expected 204, got %d", w.Code)
		}
	})
}
