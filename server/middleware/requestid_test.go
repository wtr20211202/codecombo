package middleware

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/gin-gonic/gin"
)

var hexIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

func newRequestIDEngine() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID())
	r.GET("/ping", func(c *gin.Context) {
		c.String(http.StatusOK, RequestIDFromGin(c))
	})
	return r
}

// 生成 + 响应头 + gin context 三处同值，且逐请求新值（不串号）
func TestRequestID_GeneratesAndPropagates(t *testing.T) {
	r := newRequestIDEngine()

	ids := make(map[string]bool, 2)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ping", nil))

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		id := w.Header().Get(HeaderXRequestID)
		if !hexIDRe.MatchString(id) {
			t.Fatalf("header id = %q, want 16 hex chars", id)
		}
		if got := w.Body.String(); got != id {
			t.Fatalf("handler context id = %q, want %q", got, id)
		}
		if ids[id] {
			t.Fatalf("request id %q repeated across requests", id)
		}
		ids[id] = true
	}
}

// 上游（代理链）带来的合法 id 沿用，不重新生成——代理链两端口径一致
func TestRequestID_HonorsValidIncoming(t *testing.T) {
	r := newRequestIDEngine()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ping", nil)
	req.Header.Set(HeaderXRequestID, "abcd1234abcd1234")
	r.ServeHTTP(w, req)

	if got := w.Header().Get(HeaderXRequestID); got != "abcd1234abcd1234" {
		t.Fatalf("header id = %q, want incoming id echoed", got)
	}
}

// 非法来头（超长/坏字符）丢弃重新生成，防日志注入
func TestRequestID_RegeneratesInvalidIncoming(t *testing.T) {
	r := newRequestIDEngine()
	for _, bad := range []string{
		"",
		"short",
		"has space in id",
		"quote\"id",
		string(make([]byte, 100)), // 超长
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/ping", nil)
		req.Header.Set(HeaderXRequestID, bad)
		r.ServeHTTP(w, req)

		id := w.Header().Get(HeaderXRequestID)
		if id == bad && bad != "" {
			t.Fatalf("invalid incoming id %q was echoed", bad)
		}
		if !hexIDRe.MatchString(id) {
			t.Fatalf("id = %q, want freshly generated 16 hex", id)
		}
	}
}

// 生成器直测：格式合法 + 批量唯一
func TestNewRequestID_UniqueAndFormatted(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		id := NewRequestID()
		if !hexIDRe.MatchString(id) {
			t.Fatalf("id = %q, want 16 hex chars", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q in 1000 draws", id)
		}
		seen[id] = true
	}
}
