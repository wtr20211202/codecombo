package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// TestLockE2E_WSHandshake 验证 WS 握手期 token 校验
//   - 不带 token 且 lock 启用 → 升级后以关闭码 4001 拒绝（浏览器 event.code 可见，
//     与网络故障 1006 区分；此前回 HTTP 423 客户端不可见，只能无限重连）
//   - 带 token 子协议 → 升级成功
//   - 锁定关闭 → 不需 token
func TestLockE2E_WSHandshake(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 启用锁定
	_ = store.Get().Lock.InitDefault()

	// 初始化通知 Hub（生产环境由 main.go 启动时初始化）
	notification.InitHub()

	r := gin.New()
	RegisterRoutes(r)
	srv := httptest.NewServer(r)
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/notifications"

	// 1. 不带 token → 升级成功但立即以 4001 关闭
	dialer := websocket.Dialer{HandshakeTimeout: 2 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	conn, resp, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		t.Fatalf("expected upgrade to succeed (rejection delivered via close 4001), got err=%v", err)
	}
	if resp != nil {
		resp.Body.Close()
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != middleware.CloseCodeLockRejected {
		t.Fatalf("expected close %d without token, got %v", middleware.CloseCodeLockRejected, err)
	}
	conn.Close()

	// 2. 解锁拿 token
	token := unlockAndGetToken(t, srv.URL)

	// 3. 带 token 子协议 → 升级成功
	hdr := http.Header{}
	hdr.Add("Sec-WebSocket-Protocol", token)
	conn, resp, err = dialer.DialContext(ctx, url, hdr)
	if err != nil {
		t.Fatalf("expected dial success with token, got err=%v", err)
	}
	defer conn.Close()
	if resp != nil {
		resp.Body.Close()
	}

	// 应收到 hello 消息
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	if !strings.Contains(string(msg), "hello") {
		t.Errorf("expected hello message, got %s", string(msg))
	}

	// 4. 撤销 token → server 主动断开
	store.Get().Lock.RevokeToken(token)
	// 等待 closer 触发（异步），读取应失败
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Error("expected connection closed after token revoked")
	}
}

// TestLockE2E_WSHandshake_LockDisabled 锁定关闭时不要求 token
func TestLockE2E_WSHandshake_LockDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 锁定关闭
	_ = store.Get().Lock.SaveConfig(store.LockConfig{
		Enabled:         false,
		AutoLockEnabled: true,
		AutoLockMinutes: 120,
		TokenTTLMinutes: 120,
		PasswordHash:    store.DEFAULT_PASSWORD_HASH,
	})

	// 初始化通知 Hub
	notification.InitHub()

	r := gin.New()
	RegisterRoutes(r)
	srv := httptest.NewServer(r)
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/notifications"

	dialer := websocket.Dialer{HandshakeTimeout: 2 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// 无 token 也能连接
	conn, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		t.Fatalf("expected dial success when lock disabled, got err=%v", err)
	}
	conn.Close()
}

// unlockAndGetToken 通过 /api/lock/unlock 获取 token
func unlockAndGetToken(t *testing.T, baseURL string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	body := strings.NewReader(`{"password":"admin"}`)
	req, _ := http.NewRequestWithContext(ctx, "POST", baseURL+"/api/lock/unlock", body)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("unlock: %v", err)
	}
	defer resp.Body.Close()
	data := make([]byte, 1024)
	n, _ := resp.Body.Read(data)
	s := string(data[:n])
	// 简单提取 "token":"scl_xxx"
	idx := strings.Index(s, `"token":"`)
	if idx < 0 {
		t.Fatalf("no token in response: %s", s)
	}
	start := idx + len(`"token":"`)
	end := strings.Index(s[start:], `"`)
	if end < 0 {
		t.Fatalf("malformed token in response: %s", s)
	}
	return s[start : start+end]
}
