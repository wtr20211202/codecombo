package remoteaccess

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/api/system"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 远程接入 handler 测试（P-20261019-11）：安全门槛（锁定/TLS 显式确认）、
// settings 投影（密码永不回参/编辑留空保持密文）、配置校验、状态形状。
// SSH 拨号/预检全链路在 sshclient/reverse_test.go 的进程内 fake server 覆盖。

func newRemoteAccessTestStore(t *testing.T) *store.Store {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	config.ResetForTest()
	st := store.New(filestore.New(t.TempDir()))
	store.SetDefault(st)
	t.Cleanup(func() {
		manager.Stop()
		store.SetDefault(nil)
		config.ResetForTest()
	})
	return st
}

func newRemoteAccessRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/settings", system.GetSettings)
	r.PUT("/api/settings", system.UpdateSettings)
	r.GET("/api/remoteaccess/tunnel", Status)
	r.POST("/api/remoteaccess/tunnel", Control)
	r.POST("/api/remoteaccess/tunnel/test", Test)
	r.POST("/api/remoteaccess/tunnel/hostkey/reset", ResetHostKey)
	return r
}

func doJSON(t *testing.T, r *gin.Engine, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	if w.Body.Len() > 0 {
		_ = json.Unmarshal(w.Body.Bytes(), &out)
	}
	return w, out
}

func seedRelayProfile(t *testing.T, st *store.Store, password string) string {
	t.Helper()
	cfg := st.Settings.Get()
	norm, err := config.NormalizeRemoteAccess(&config.RemoteAccessConfig{
		Profiles: []config.RemoteAccessProfile{{
			Name: "home-vps", Host: "127.0.0.1", Port: 1, User: "relay",
			AuthType: config.RemoteAccessAuthPassword, Password: password,
			RemoteBindHost: config.RemoteAccessBindPublic, RemotePort: 22022,
		}},
	}, nil)
	if err != nil {
		t.Fatalf("normalize profile: %v", err)
	}
	cfg.Server.RemoteAccess = norm
	if err := st.Settings.Save(); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	return norm.Profiles[0].ID
}

func TestRemoteAccessStatusAndLockGate(t *testing.T) {
	st := newRemoteAccessTestStore(t)
	r := newRemoteAccessRouter()
	profileID := seedRelayProfile(t, st, "relay-pw")

	// 锁定未启用：状态暴露门槛 + 启动硬拒绝
	_, status := doJSON(t, r, http.MethodGet, "/api/remoteaccess/tunnel", nil)
	data, _ := status["data"].(map[string]any)
	if ready, _ := data["lockReady"].(bool); ready {
		t.Fatalf("lockReady should be false without lock config: %v", data)
	}
	w, body := doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel",
		map[string]any{"action": "start", "profileId": profileID})
	if w.Code != http.StatusConflict || body["code"] != "remoteaccess.lock_required" {
		t.Fatalf("start without lock = %d %v", w.Code, body)
	}

	// 启用锁定（默认密码）：门槛通过但红字标记仍在
	if err := st.Lock.InitDefault(); err != nil {
		t.Fatalf("init lock: %v", err)
	}
	_, status = doJSON(t, r, http.MethodGet, "/api/remoteaccess/tunnel", nil)
	data, _ = status["data"].(map[string]any)
	if ready, _ := data["lockReady"].(bool); !ready {
		t.Fatalf("lockReady should be true: %v", data)
	}
	if def, _ := data["lockDefaultPassword"].(bool); !def {
		t.Fatalf("default password flag should be true: %v", data)
	}

	// TLS 未启用：必须显式确认（409 + 稳定 code）
	w, body = doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel",
		map[string]any{"action": "start", "profileId": profileID})
	if w.Code != http.StatusConflict || body["code"] != "remoteaccess.tls_insecure_confirm_required" {
		t.Fatalf("start without TLS confirm = %d %v", w.Code, body)
	}

	// 确认后进入真实拨号（127.0.0.1:1 立即拒绝）→ 502 start_failed + failed 状态
	w, body = doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel",
		map[string]any{"action": "start", "profileId": profileID, "confirmInsecureTls": true})
	if w.Code != http.StatusBadGateway || body["code"] != "remoteaccess.start_failed" {
		t.Fatalf("start dial failure = %d %v", w.Code, body)
	}
	_, status = doJSON(t, r, http.MethodGet, "/api/remoteaccess/tunnel", nil)
	data, _ = status["data"].(map[string]any)
	if data["state"] != "failed" || data["lastError"] == "" {
		t.Fatalf("status after failed start = %v", data)
	}

	// 停止幂等
	w, _ = doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel", map[string]any{"action": "stop"})
	if w.Code != http.StatusOK {
		t.Fatalf("stop = %d", w.Code)
	}
	// 非法 action
	w, body = doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel", map[string]any{"action": "explode"})
	if w.Code != http.StatusBadRequest || body["code"] != "remoteaccess.payload_invalid" {
		t.Fatalf("invalid action = %d %v", w.Code, body)
	}
}

func TestRemoteAccessSettingsProjection(t *testing.T) {
	st := newRemoteAccessTestStore(t)
	r := newRemoteAccessRouter()

	w, body := doJSON(t, r, http.MethodPut, "/api/settings", map[string]any{
		"remoteAccess": map[string]any{"profiles": []map[string]any{{
			"name": "relay-a", "host": "vps.example.com", "port": 2222, "user": "relay",
			"authType": "password", "password": "s3cret-pw",
			"remoteBindHost": "0.0.0.0", "remotePort": 22022, "domain": "work.example.com",
		}}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("save settings = %d %v", w.Code, body)
	}

	getRemoteAccess := func() map[string]any {
		_, out := doJSON(t, r, http.MethodGet, "/api/settings", nil)
		d, _ := out["data"].(map[string]any)
		ra, _ := d["remoteAccess"].(map[string]any)
		return ra
	}
	ra := getRemoteAccess()
	profiles, _ := ra["profiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("profiles = %v", ra)
	}
	p, _ := profiles[0].(map[string]any)
	if _, leaked := p["password"]; leaked {
		t.Fatalf("password must never be returned: %v", p)
	}
	if hp, _ := p["hasPassword"].(bool); !hp {
		t.Fatalf("hasPassword should be true: %v", p)
	}
	if p["remoteBindHost"] != "0.0.0.0" || p["remotePort"] != float64(22022) {
		t.Fatalf("profile projection = %v", p)
	}
	// 密文落盘（settings 文档内不出现明文）
	rawCfg := st.Settings.Get()
	if rawCfg.Server.RemoteAccess.Profiles[0].Password == "s3cret-pw" {
		t.Fatalf("password must be encrypted at rest")
	}
	id, _ := p["id"].(string)

	// 编辑留空 = 保持原密文
	w, _ = doJSON(t, r, http.MethodPut, "/api/settings", map[string]any{
		"remoteAccess": map[string]any{"profiles": []map[string]any{{
			"id": id, "name": "relay-a", "host": "vps.example.com", "port": 2222, "user": "relay",
			"authType": "password", "remoteBindHost": "127.0.0.1", "remotePort": 22023,
		}}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("update without password = %d", w.Code)
	}
	p = mustProfile(t, getRemoteAccess())
	if hp, _ := p["hasPassword"].(bool); !hp {
		t.Fatalf("blank password must preserve stored one: %v", p)
	}
	if p["remoteBindHost"] != "127.0.0.1" || p["remotePort"] != float64(22023) {
		t.Fatalf("update not applied: %v", p)
	}

	// 新建密码档案留空 → 400 config_invalid
	w, body = doJSON(t, r, http.MethodPut, "/api/settings", map[string]any{
		"remoteAccess": map[string]any{"profiles": []map[string]any{{
			"name": "relay-b", "host": "vps2.example.com", "port": 22, "user": "relay",
			"authType": "password", "remoteBindHost": "0.0.0.0", "remotePort": 22022,
		}}},
	})
	if w.Code != http.StatusBadRequest || body["code"] != "remoteaccess.config_invalid" {
		t.Fatalf("new profile without password = %d %v", w.Code, body)
	}
	// sshkey 引用不存在的密钥 → 400
	w, body = doJSON(t, r, http.MethodPut, "/api/settings", map[string]any{
		"remoteAccess": map[string]any{"profiles": []map[string]any{{
			"name": "relay-c", "host": "vps3.example.com", "port": 22, "user": "relay",
			"authType": "sshkey", "sshKeyId": "missing-key",
			"remoteBindHost": "0.0.0.0", "remotePort": 22022,
		}}},
	})
	if w.Code != http.StatusBadRequest || body["code"] != "remoteaccess.config_invalid" {
		t.Fatalf("missing ssh key = %d %v", w.Code, body)
	}
}

func mustProfile(t *testing.T, ra map[string]any) map[string]any {
	t.Helper()
	profiles, _ := ra["profiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("profiles = %v", ra)
	}
	p, _ := profiles[0].(map[string]any)
	return p
}

func TestRemoteAccessTestEndpointValidation(t *testing.T) {
	newRemoteAccessTestStore(t)
	r := newRemoteAccessRouter()
	// 新档案缺密码：测试连接也走同一校验口径
	w, body := doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel/test", map[string]any{
		"profile": map[string]any{
			"name": "relay-x", "host": "127.0.0.1", "port": 22, "user": "relay",
			"authType": "password", "remoteBindHost": "0.0.0.0", "remotePort": 22022,
		},
	})
	if w.Code != http.StatusBadRequest || body["code"] != "remoteaccess.config_invalid" {
		t.Fatalf("test invalid profile = %d %v", w.Code, body)
	}
	// 不存在的 profileId → 404
	w, body = doJSON(t, r, http.MethodPost, "/api/remoteaccess/tunnel/test",
		map[string]any{"profileId": "sc_ra_0000000000000000"})
	if w.Code != http.StatusNotFound || body["code"] != "remoteaccess.profile_not_found" {
		t.Fatalf("test missing profile = %d %v", w.Code, body)
	}
}
