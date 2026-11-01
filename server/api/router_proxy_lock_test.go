package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// 代理路由必须受全局锁保护（安全 backlog A1）：
// 锁开启时无凭证访问 /proxy 与 /ws/proxy 一律 423；持有效 unlock token 放行。
func TestProxyRoutesRequireLock(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	middleware.ResetLockUnlockRateLimitForTesting()
	t.Cleanup(middleware.ResetLockUnlockRateLimitForTesting)

	_ = store.Get().Lock.InitDefault()

	r := gin.New()
	RegisterRoutes(r)
	srv := httptest.NewServer(r)
	defer srv.Close()
	client := srv.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. 无凭证访问 HTTP 代理 → 423
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/proxy/any-id/any/path", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("proxy request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusLocked {
		t.Fatalf("expected 423 on /proxy without token, got %d", resp.StatusCode)
	}

	// 2. 无凭证访问 WS 代理 → 升级后以关闭码 4001 拒绝（拒绝信号对客户端可见，
	// 浏览器 event.code 可读；此前 HTTP 423 在 WS 通道对前端不可见）
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/proxy/any-id/remote-terminal/x"
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws proxy dial (upgrade should succeed, rejection via close frame): %v", err)
	}
	_ = wsConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, readErr := wsConn.ReadMessage()
	wsConn.Close()
	ce, ok := readErr.(*websocket.CloseError)
	if !ok || ce.Code != middleware.CloseCodeLockRejected {
		t.Fatalf("expected close %d on unauthenticated ws proxy, got %v", middleware.CloseCodeLockRejected, readErr)
	}

	// 3. 持有效 unlock token → 中间件放行（代理 handler 因实例不存在报 404/5xx，但绝非 423）
	body, _ := json.Marshal(map[string]string{"password": "admin"})
	req, _ = http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/lock/unlock", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("unlock: %v", err)
	}
	var unlockResp struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&unlockResp)
	resp.Body.Close()
	if unlockResp.Token == "" {
		t.Fatalf("unlock returned no token: %d", resp.StatusCode)
	}

	req, _ = http.NewRequestWithContext(ctx, "GET", srv.URL+"/proxy/any-id/any/path", nil)
	req.Header.Set("X-Lock-Token", unlockResp.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("proxy with token: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusLocked {
		t.Fatalf("expected middleware to pass with valid token, got 423")
	}
}
