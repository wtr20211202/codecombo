package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// probeRouter probe 端点测试 router（需实例存储初始化）
func probeRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.POST("/api/instances/probe", ProbeInstance)
	return r
}

// doProbe 发起 probe 请求并返回 (httpStatus, data.status)
func doProbe(t *testing.T, r *gin.Engine, body string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/instances/probe", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		return w.Code, ""
	}
	var resp struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal probe response: %v", err)
	}
	return w.Code, resp.Data.Status
}

// TestProbeInstance_Classification 表单内「测试连接」的服务端探测分类：
// 前端据 status 渲染 success（在线）/ reachable（锁定 423）/ notapp（非本应用）/
// fail（网络不可达）。此前该测试由浏览器直连目标，跨源必撞 CORS 误判失败
func TestProbeInstance_Classification(t *testing.T) {
	r := probeRouter(t)

	// 本应用（200 + data 结构）→ online
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"version":"0.0.1"}}`))
	}))
	defer app.Close()
	if code, status := doProbe(t, r, `{"url":"`+app.URL+`"}`); code != 200 || status != "online" {
		t.Fatalf("app server: got %d/%q, want 200/online", code, status)
	}

	// 锁定实例（423 + locked 特征）→ online（服务在跑）
	locked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusLocked)
		_, _ = w.Write([]byte(`{"err":"locked","msg":"locked"}`))
	}))
	defer locked.Close()
	if code, status := doProbe(t, r, `{"url":"`+locked.URL+`"}`); code != 200 || status != "online" {
		t.Fatalf("locked server: got %d/%q, want 200/online", code, status)
	}

	// 非本应用（200 HTML SPA fallback）→ invalid
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html><body>gitea</body></html>`))
	}))
	defer other.Close()
	if code, status := doProbe(t, r, `{"url":"`+other.URL+`"}`); code != 200 || status != "invalid" {
		t.Fatalf("non-app server: got %d/%q, want 200/invalid", code, status)
	}

	// 网络不可达（关掉的端口）→ offline
	if code, status := doProbe(t, r, `{"url":"http://127.0.0.1:1"}`); code != 200 || status != "offline" {
		t.Fatalf("unreachable: got %d/%q, want 200/offline", code, status)
	}

	// 裸 host:port 自动补协议 + 空参数 400
	if code, _ := doProbe(t, r, `{"url":""}`); code != 400 {
		t.Fatalf("empty url: got %d, want 400", code)
	}
}
