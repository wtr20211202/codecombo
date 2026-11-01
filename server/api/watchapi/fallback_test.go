package watchapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// fakeControl 假控制面：翻转/显式开关与状态返回的桩（watch 模块契约由其
// 自身单测覆盖，这里锁 handler 的桥接/解析/响应形状）
type fakeControl struct {
	enabled bool
	source  string
	since   time.Time
	lastSet *bool
}

func (f *fakeControl) FallbackStatus() (bool, string, time.Time) {
	return f.enabled, f.source, f.since
}

func (f *fakeControl) SetFallback(enable *bool) (bool, string, time.Time) {
	f.lastSet = enable
	want := !f.enabled
	if enable != nil {
		want = *enable
	}
	f.enabled = want
	if want {
		f.source, f.since = "manual", time.Now()
	} else {
		f.source, f.since = "", time.Time{}
	}
	return f.enabled, f.source, f.since
}

func setup(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/watch/fallback", GetFallback)
	r.POST("/api/watch/fallback", SetFallback)
	t.Cleanup(func() { SetFallbackControl(nil) }) // 复位注入点，测试间互不渗透
	return r
}

func do(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestGetFallback_NoControlBridge 控制面未装配（模块未注册/直调 handler）：
// GET 宽容回零状态（前端展示「未启用」），POST 明确 503
func TestGetFallback_NoControlBridge(t *testing.T) {
	r := setup(t)
	w := do(r, http.MethodGet, "/api/watch/fallback", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET without bridge status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatalf("GET without bridge body = %s, want zero status", w.Body.String())
	}
	w = do(r, http.MethodPost, "/api/watch/fallback", `{"enabled":true}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST without bridge status = %d, want 503", w.Code)
	}
}

// TestSetFallback_ExplicitAndToggle 显式开关与翻转（通知动作发空翻转载荷 /
// 设置面发显式布尔，两条消费路径同契约），响应 data 恒为开关后的状态
func TestSetFallback_ExplicitAndToggle(t *testing.T) {
	r := setup(t)
	fc := &fakeControl{}
	SetFallbackControl(fc)

	// 显式开启
	w := do(r, http.MethodPost, "/api/watch/fallback", `{"enabled":true}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":true`) {
		t.Fatalf("enable resp = %d %s", w.Code, w.Body.String())
	}
	if fc.lastSet == nil || *fc.lastSet != true {
		t.Fatalf("control received %v, want true", fc.lastSet)
	}
	if !strings.Contains(w.Body.String(), `"source":"manual"`) || !strings.Contains(w.Body.String(), `"since":"`) {
		t.Fatalf("enabled status must carry source/since: %s", w.Body.String())
	}

	// 空翻转（通知动作路径：body {}）
	w = do(r, http.MethodPost, "/api/watch/fallback", `{}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatalf("toggle resp = %d %s", w.Code, w.Body.String())
	}
	if fc.lastSet != nil {
		t.Fatal("toggle must pass nil to control")
	}

	// 无 body 直 POST（curl 风格）也按翻转宽容处理
	w = do(r, http.MethodPost, "/api/watch/fallback", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":true`) {
		t.Fatalf("empty-body toggle resp = %d %s", w.Code, w.Body.String())
	}

	// 坏 JSON 拒绝
	w = do(r, http.MethodPost, "/api/watch/fallback", `{"enabled":`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad json status = %d, want 400", w.Code)
	}
}

// TestGetFallback_WithControlBridge 装配后 GET 反映控制面真实状态
func TestGetFallback_WithControlBridge(t *testing.T) {
	r := setup(t)
	fc := &fakeControl{enabled: true, source: "auto", since: time.Now()}
	SetFallbackControl(fc)
	w := do(r, http.MethodGet, "/api/watch/fallback", "")
	if w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `"enabled":true`) ||
		!strings.Contains(w.Body.String(), `"source":"auto"`) {
		t.Fatalf("GET resp = %d %s", w.Code, w.Body.String())
	}
}
