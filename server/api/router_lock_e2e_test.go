package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// TestLockE2E_RouteGroup 端到端验证 lockPublic 豁免组 + api 受保护组的协作
// 用例对应 plan Task 2.3 step 4 的 curl 测试场景
func TestLockE2E_RouteGroup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmp := t.TempDir()
	ds := filestore.New(tmp)
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	middleware.ResetLockUnlockRateLimitForTesting()
	t.Cleanup(middleware.ResetLockUnlockRateLimitForTesting)

	// 首次启动 → 写入默认配置（Enabled=true, password=admin）
	_ = store.Get().Lock.InitDefault()

	r := gin.New()
	RegisterRoutes(r)
	srv := httptest.NewServer(r)
	defer srv.Close()
	client := srv.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. GET /api/lock/state（豁免）
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/lock/state", nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("state request: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200 on state, got %d", resp.StatusCode)
	}
	var state gin.H
	_ = json.NewDecoder(resp.Body).Decode(&state)
	resp.Body.Close()
	if state["enabled"] != true {
		t.Errorf("expected enabled=true, got %v", state["enabled"])
	}

	// 2. POST /api/lock/unlock with correct password
	body, _ := json.Marshal(map[string]string{"password": "admin"})
	req, _ = http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("unlock request: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200 on unlock, got %d", resp.StatusCode)
	}
	var unlockResp struct {
		Token     string `json:"token"`
		ExpiresIn int    `json:"expiresIn"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&unlockResp)
	resp.Body.Close()
	if unlockResp.Token == "" {
		t.Fatal("expected token in unlock response")
	}
	if unlockResp.ExpiresIn != 120*60 {
		t.Errorf("expected expiresIn=%d, got %d", 120*60, unlockResp.ExpiresIn)
	}

	// 3. GET /api/lock/config 不带 token → 423
	req, _ = http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/lock/config", nil)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("config without token: %v", err)
	}
	if resp.StatusCode != 423 {
		t.Errorf("expected 423 without token, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 4. GET /api/lock/config 带 token → 200
	req, _ = http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/lock/config", nil)
	req.Header.Set(middleware.LockHeaderName, unlockResp.Token)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("config with token: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200 with token, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 5. GET /api/projects 不带 token → 423（LockMiddleware 保护全 api 组）
	req, _ = http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/projects", nil)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("projects without token: %v", err)
	}
	if resp.StatusCode != 423 {
		t.Errorf("expected 423 on protected route without lock token, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 6. POST /api/lock/unlock 错误密码 → 401
	wrongBody, _ := json.Marshal(map[string]string{"password": "wrong"})
	req, _ = http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/lock/unlock", bytes.NewReader(wrongBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("unlock wrong password: %v", err)
	}
	if resp.StatusCode != 401 {
		t.Errorf("expected 401 wrong password, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
