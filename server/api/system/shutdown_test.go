package system

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// A8 守护：关机端点仅回环 + 必须携带自定义头；触发已注册的关闭函数
func TestShutdownEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/shutdown", Shutdown)

	newReq := func(remote, header string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/shutdown", nil)
		req.RemoteAddr = remote
		if header != "" {
			req.Header.Set("X-SC-Shutdown", header)
		}
		return req
	}

	// LAN 来源拒绝
	w := httptest.NewRecorder()
	r.ServeHTTP(w, newReq("192.168.1.50:5000", "1"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("LAN source: expected 403, got %d", w.Code)
	}

	// 缺自定义头拒绝（CSRF 约束）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, newReq("127.0.0.1:5000", ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing header: expected 400, got %d", w.Code)
	}

	// 未注册关闭函数：503
	w = httptest.NewRecorder()
	r.ServeHTTP(w, newReq("127.0.0.1:5000", "1"))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("no shutdown fn: expected 503, got %d", w.Code)
	}

	// 注册后：202 + 关闭函数被调用
	var called atomic.Bool
	RegisterShutdown(func() {
		time.Sleep(10 * time.Millisecond)
		called.Store(true)
	})
	t.Cleanup(func() { RegisterShutdown(nil) })

	w = httptest.NewRecorder()
	r.ServeHTTP(w, newReq("127.0.0.1:5000", "1"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("registered: expected 202, got %d", w.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !called.Load() {
		time.Sleep(10 * time.Millisecond)
	}
	if !called.Load() {
		t.Fatal("shutdown function was not invoked")
	}
}
