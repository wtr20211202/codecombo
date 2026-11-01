package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"codecombo/server/claims"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// /api/whoami 令牌自校验端点（P-20261004-15）单测：
//   - tokenKind 判别（agent/unlock/access 三族凭据各归其位）
//   - 无效令牌 401 按令牌族区分（锁定开启时先被 LockMiddleware 423 拦下——
//     同为明确的凭据拒绝；401 自校验路径在锁定关闭时可达，e2e 种子态即此态）
//   - terminalId 仅回显 X-Session-ID 指向的存活会话（正向链路由 e2e 覆盖：
//     单测内造真会话需起 PTY，不稳定）
//   - sessions 配额块（P-20261006-30）：形状恒在与同源对账（current 随真会话
//     增减的正向链路同 terminalId 由 e2e 覆盖，单测不造真 PTY）

// setupWhoamiRouter 独立 store + /api 组同款中间件（LockMiddleware，router.go:55 的
// TokenAuth/AgentGuard 对 GET /whoami 语义无增量——前者无 Authorization 放行、
// 后者仅高危路由生效——不重复装配，见 system/lock_test.go 同款最小面）。
// SC_DATA_DIR 指向临时目录：P-20261004-133 起 instance 块经 claims.InstanceID
// 读数据目录级身份，不能蹭真实用户目录（fleet_test 同款隔离）
func setupWhoamiRouter(t *testing.T) (*gin.Engine, store.LockStore, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	lock := store.Get().Lock
	if err := lock.InitDefault(); err != nil {
		t.Fatalf("lock InitDefault: %v", err)
	}
	if err := store.Get().AgentToken.Ensure(); err != nil {
		t.Fatalf("agent token Ensure: %v", err)
	}
	agentToken := store.Get().AgentToken.Plain()
	if agentToken == "" {
		t.Fatal("agent token not provisioned after Ensure")
	}
	unlockToken, err := lock.IssueToken()
	if err != nil {
		t.Fatalf("issue unlock token: %v", err)
	}

	r := gin.New()
	api := r.Group("/api")
	api.Use(middleware.LockMiddleware())
	api.GET("/whoami", HandleWhoami)
	return r, lock, unlockToken, agentToken
}

func whoamiDo(t *testing.T, r *gin.Engine, set func(*http.Request)) (*httptest.ResponseRecorder, WhoamiResponse) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/whoami", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	set(req)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var resp WhoamiResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp) // 401 路径为 {"error":...}，resp 留零值
	return w, resp
}

func TestHandleWhoami_AgentToken(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.TokenKind != "agent" {
		t.Errorf("tokenKind = %q, want agent", resp.TokenKind)
	}
	if resp.Version == "" {
		t.Error("version empty, want build version (dev in test binary)")
	}
	if resp.Capabilities == nil {
		t.Error("capabilities = null, want []（无内核注入时也必须是数组）")
	}
}

func TestHandleWhoami_UnlockToken(t *testing.T) {
	r, _, unlockToken, _ := setupWhoamiRouter(t)

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", unlockToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.TokenKind != "unlock" {
		t.Errorf("tokenKind = %q, want unlock", resp.TokenKind)
	}
}

func TestHandleWhoami_AccessToken(t *testing.T) {
	r, _, _, _ := setupWhoamiRouter(t)
	plain, _, err := store.Get().Token.Generate("whoami-test", 0)
	if err != nil {
		t.Fatalf("generate access token: %v", err)
	}

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer "+plain)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.TokenKind != "access" {
		t.Errorf("tokenKind = %q, want access", resp.TokenKind)
	}
}

// TestHandleWhoami_InvalidToken_LockEnabled 无效令牌 × 锁定开启：LockMiddleware
// 423 先行（既有语义）——whoami 不越过中间件的凭据拒绝
func TestHandleWhoami_InvalidToken_LockEnabled(t *testing.T) {
	r, _, _, _ := setupWhoamiRouter(t)

	w, _ := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", "sca_deadbeef")
	})
	if w.Code != http.StatusLocked {
		t.Fatalf("status = %d, want 423（锁定开启时无效令牌被 LockMiddleware 拦下）: %s", w.Code, w.Body.String())
	}
}

// TestHandleWhoami_InvalidToken_LockDisabled 锁定关闭：中间件放行，whoami 自校验，
// 无效令牌 401 且按令牌族区分——agent 据此决定重取令牌还是重新解锁
func TestHandleWhoami_InvalidToken_LockDisabled(t *testing.T) {
	r, lock, unlockToken, agentToken := setupWhoamiRouter(t)
	cfg := lock.GetConfig()
	cfg.Enabled = false
	if err := lock.SaveConfig(cfg); err != nil {
		t.Fatalf("disable lock: %v", err)
	}

	cases := []struct {
		name    string
		header  string
		token   string
		wantMsg string
	}{
		{"agent 令牌坏值", "X-Lock-Token", "sca_deadbeef", "agent token invalid"},
		{"解锁令牌坏值", "X-Lock-Token", "scl_bogus", "unlock token invalid"},
		{"无凭据", "", "", "no credential presented"},
		{"access 令牌坏值", "Authorization", "Bearer sc_bogus", "access token invalid"},
	}
	for _, tc := range cases {
		w, _ := whoamiDo(t, r, func(req *http.Request) {
			if tc.header != "" {
				req.Header.Set(tc.header, tc.token)
			}
		})
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401: %s", tc.name, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), tc.wantMsg) {
			t.Errorf("%s: error 未区分令牌族，got %s, want 含 %q", tc.name, w.Body.String(), tc.wantMsg)
		}
	}

	// 锁定关闭但凭据有效：仍按 tokenKind 正常应答（自校验不依赖锁定开关）
	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", unlockToken)
	})
	if w.Code != http.StatusOK || resp.TokenKind != "unlock" {
		t.Errorf("锁定关闭 + 有效解锁令牌: status=%d kind=%q, want 200/unlock", w.Code, resp.TokenKind)
	}
	w, resp = whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK || resp.TokenKind != "agent" {
		t.Errorf("锁定关闭 + 有效 agent 令牌: status=%d kind=%q, want 200/agent", w.Code, resp.TokenKind)
	}
}

// TestHandleWhoami_TerminalID_GhostSession X-Session-ID 指向的会话不存在：
// terminalId 省略（omitempty）——引导期即可发现会话丢失
func TestHandleWhoami_TerminalID_GhostSession(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
		req.Header.Set("X-Session-ID", "sc-not-exist")
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.TerminalID != "" {
		t.Errorf("terminalId = %q, want 省略（幽灵会话）", resp.TerminalID)
	}
	if strings.Contains(w.Body.String(), "sc-not-exist") {
		t.Error("响应体不应包含幽灵会话 id（omitempty 未生效？）")
	}
}

// TestHandleWhoami_InstanceBlock_Fallback instance 块缺省回落（P-20261004-133）：
// 实例注册库无本机条目（store 未建档的裸形态）→ instanceName 缺省 host:port；
// instanceId 与 claims.InstanceID 同源恒在（数据目录级身份，不依赖 claim 文件）。
// 端口/主机断言只做自洽性核对不钉具体值——settings 面裸 store 回落 config.Load，
// 其值随进程内先到的一次性加载而定（fleet selfPort 同款环境耦合，不假设 9999）
func TestHandleWhoami_InstanceBlock_Fallback(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.Instance.InstanceID == "" {
		t.Error("instanceId empty, want 数据目录级持久身份（claims.InstanceID 同源）")
	}
	wantID, err := claims.InstanceID(config.DataDir())
	if err != nil {
		t.Fatalf("claims.InstanceID: %v", err)
	}
	if resp.Instance.InstanceID != wantID {
		t.Errorf("instanceId = %q, want 同源 %q", resp.Instance.InstanceID, wantID)
	}
	if resp.Instance.Port <= 0 {
		t.Errorf("instance.port = %d, want 主端口（>0，缺省 9999 路径）", resp.Instance.Port)
	}
	if resp.Instance.InstanceName == "" ||
		!strings.HasSuffix(resp.Instance.InstanceName, ":"+strconv.Itoa(resp.Instance.Port)) {
		t.Errorf("instanceName = %q, want 缺省 host:port 回落（含端口 %d）",
			resp.Instance.InstanceName, resp.Instance.Port)
	}
}

// TestHandleWhoami_InstanceBlock_RegistryName instanceName 取实例注册库本机
// 条目的登记名（用户在实例面板改名的形态）——登记名的真实载体，claims 注册
// 表只记 instanceId/port 无名字
func TestHandleWhoami_InstanceBlock_RegistryName(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)
	now := time.Now().Format(time.RFC3339)
	if err := store.Get().Instance.Save(config.InstanceConfig{
		ID: "local", Name: "构建机A", IsLocal: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("seed local instance: %v", err)
	}

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.Instance.InstanceName != "构建机A" {
		t.Errorf("instanceName = %q, want 注册库本机登记名 构建机A", resp.Instance.InstanceName)
	}
}

// TestHandleWhoami_SessionsBlock sessions 配额块（P-20261006-30）：块与两字段
// 恒在（零会话也是合法答案，无 omitempty）；max 与创建路径准入同源（terminal.
// MaxSessions 生效值，可配化 P-20261006-12 后随 server.terminalMaxSessions）；
// current 供给方即 manager 存活数（单测环境无真 PTY 会话，对账读数一致性——
// 创建后的增量正向链路由 e2e whoami.spec 锁定）
func TestHandleWhoami_SessionsBlock(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)

	w, resp := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp.Sessions.Max != terminal.MaxSessions() {
		t.Errorf("sessions.max = %d, want 与创建准入同源 %d", resp.Sessions.Max, terminal.MaxSessions())
	}
	if resp.Sessions.Current != terminal.DefaultManager.SessionCount() {
		t.Errorf("sessions.current = %d, want manager 存活数 %d",
			resp.Sessions.Current, terminal.DefaultManager.SessionCount())
	}
	if resp.Sessions.Max < resp.Sessions.Current {
		t.Errorf("sessions.max %d < current %d, want 上限恒不低于存活数", resp.Sessions.Max, resp.Sessions.Current)
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	blk, ok := body["sessions"].(map[string]any)
	if !ok {
		t.Fatalf("sessions block missing or not an object: %s", w.Body.String())
	}
	for _, key := range []string{"max", "current"} {
		if _, has := blk[key]; !has {
			t.Errorf("sessions.%s missing, want 恒在（零会话也是合法答案）", key)
		}
	}
}

// TestHandleWhoami_InstanceShape instance 块序列化形状：三字段恒在（平铺块
// 无 omitempty，无 claim 形态也照回缺省值——引导原语对「我在哪」恒有答案）
func TestHandleWhoami_InstanceShape(t *testing.T) {
	r, _, _, agentToken := setupWhoamiRouter(t)

	w, _ := whoamiDo(t, r, func(req *http.Request) {
		req.Header.Set("X-Lock-Token", agentToken)
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	inst, ok := body["instance"].(map[string]any)
	if !ok {
		t.Fatalf("instance block missing or not an object: %s", w.Body.String())
	}
	for _, key := range []string{"instanceName", "instanceId", "port"} {
		if _, has := inst[key]; !has {
			t.Errorf("instance.%s missing, want 恒在（无 claim 形态也回缺省值）", key)
		}
	}
}
