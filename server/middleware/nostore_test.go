package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestNoStore 双头施加（P-20261002-121）：no-store + Pragma 兜底，且
// handler 自行给出错误状态（404）时头同样在——中间件先于 handler 写头
func TestNoStore(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/private", NoStore(), func(c *gin.Context) { c.String(200, "secret") })
	r.GET("/missing", NoStore(), func(c *gin.Context) { c.Status(404) })

	for _, tc := range []struct {
		path string
		code int
	}{
		{"/private", 200},
		{"/missing", 404},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != tc.code {
			t.Errorf("%s: status = %d, want %d", tc.path, w.Code, tc.code)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", tc.path, got)
		}
		if got := w.Header().Get("Pragma"); got != "no-cache" {
			t.Errorf("%s: Pragma = %q, want no-cache", tc.path, got)
		}
	}
}

// TestNoStore_ScopeDiscipline 未挂中间件的路由不带头：静态资源/公共资源
// 的缓存语义（app.go 的 immutable/no-cache 分级）不被波及——作用域纪律护栏
func TestNoStore_ScopeDiscipline(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/public", func(c *gin.Context) { c.String(200, "asset") })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/public", nil))

	if got := w.Header().Get("Cache-Control"); got != "" {
		t.Errorf("Cache-Control = %q on route without NoStore; want empty", got)
	}
	if got := w.Header().Get("Pragma"); got != "" {
		t.Errorf("Pragma = %q on route without NoStore; want empty", got)
	}
}
