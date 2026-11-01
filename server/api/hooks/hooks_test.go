package hooks

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 入站 Hook 端点单测（P-20261003-23）：凭据载体优先级/401 关闭语义/白名单
// 校验/动作分拆/类别归一/限流 429 与审计动作。

func hooksTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(filepath.Join(t.TempDir(), "data"))
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	// 与生产注册同构：两个载体共用同一中间件实例（同一限流器），换载体不能绕过配额
	rateLimit := middleware.RateLimitMiddleware(60, RateLimitKey)
	r.POST("/api/hooks", rateLimit, PostHook)
	r.POST("/api/hooks/:token", rateLimit, PostHook)
	r.GET("/api/hook-token", GetHookToken)
	r.POST("/api/hook-token/rotate", RotateHookToken)
	r.DELETE("/api/hook-token", RevokeHookToken)
	return r
}

func issueHookToken(t *testing.T, r *gin.Engine) string {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/api/hook-token/rotate", nil))
	if w.Code != 200 {
		t.Fatalf("issue hook token: %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode issue response: %v", err)
	}
	if !strings.HasPrefix(body.Data.Token, "sch_") {
		t.Fatalf("unexpected token %q", body.Data.Token)
	}
	return body.Data.Token
}

func postHook(r *gin.Engine, path, headerToken string, payload any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(payload)
	req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if headerToken != "" {
		req.Header.Set(HeaderToken, headerToken)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestPostHook_RequiresValidToken(t *testing.T) {
	r := hooksTestRouter(t)
	payload := map[string]any{"title": "CI failed"}

	// 未签发：入站整体关闭（用户拍板的销毁语义）
	if w := postHook(r, "/api/hooks", "", payload); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401, got %d %s", w.Code, w.Body.String())
	}
	tok := issueHookToken(t, r)

	// 错误凭据：URL 载体与 header 载体均 401
	if w := postHook(r, "/api/hooks/"+strings.Repeat("0", 32), "", payload); w.Code != http.StatusUnauthorized {
		t.Fatalf("bad url token: want 401, got %d", w.Code)
	}
	if w := postHook(r, "/api/hooks", "sch_"+strings.Repeat("0", 32), payload); w.Code != http.StatusUnauthorized {
		t.Fatalf("bad header token: want 401, got %d", w.Code)
	}
	// 两个载体都带时 header 优先：header 正确 + URL 错误 → 200
	if w := postHook(r, "/api/hooks/"+strings.Repeat("0", 32), tok, payload); w.Code != 200 {
		t.Fatalf("header carrier must win: want 200, got %d %s", w.Code, w.Body.String())
	}
	// header 错误 + URL 正确 → 401（header 在场即不回落）
	if w := postHook(r, "/api/hooks/"+tok, "sch_"+strings.Repeat("0", 32), payload); w.Code != http.StatusUnauthorized {
		t.Fatalf("present-but-wrong header must not fall back to URL: got %d", w.Code)
	}
	// URL 载体兼容
	if w := postHook(r, "/api/hooks/"+tok, "", payload); w.Code != 200 {
		t.Fatalf("url carrier: want 200, got %d %s", w.Code, w.Body.String())
	}
}

func TestPostHook_NotificationPayloadAndAction(t *testing.T) {
	r := hooksTestRouter(t)
	tok := issueHookToken(t, r)

	w := postHook(r, "/api/hooks", tok, map[string]any{
		"title":    "  CI build failed  ",
		"body":     "job=build\nreason=compile error",
		"category": "error",
		"action":   "panel:git",
	})
	if w.Code != 200 {
		t.Fatalf("want 200, got %d %s", w.Code, w.Body.String())
	}
	list := store.Get().Notification.List(0)
	if len(list) != 1 {
		t.Fatalf("want 1 notification, got %d", len(list))
	}
	n := list[0]
	if n.Title != "CI build failed" {
		t.Fatalf("title not trimmed: %q", n.Title)
	}
	if n.Category != notification.CategoryError || n.Type != "error" {
		t.Fatalf("category/type mismatch: %+v", n)
	}
	if n.Action != "panel" || n.ActionPayload != "git" {
		t.Fatalf("panel action not split: action=%q payload=%q", n.Action, n.ActionPayload)
	}
	if !strings.Contains(n.Body, "compile error") {
		t.Fatalf("body lost: %q", n.Body)
	}
}

func TestPostHook_Validation(t *testing.T) {
	r := hooksTestRouter(t)
	tok := issueHookToken(t, r)

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"missing title", map[string]any{"body": "x"}, http.StatusBadRequest},
		{"blank title", map[string]any{"title": "   "}, http.StatusBadRequest},
		{"non-panel action", map[string]any{"title": "x", "action": "url:https://evil"}, http.StatusBadRequest},
		{"unknown panel", map[string]any{"title": "x", "action": "panel:dashboard"}, http.StatusBadRequest},
		{"empty panel name", map[string]any{"title": "x", "action": "panel:"}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if w := postHook(r, "/api/hooks", tok, tc.body); w.Code != tc.want {
				t.Fatalf("want %d, got %d %s", tc.want, w.Code, w.Body.String())
			}
		})
	}

	// 未知 category 回落 system；未知 body 字段被忽略（外部胶水整包 POST 兼容）
	postHook(r, "/api/hooks", tok, map[string]any{
		"title": "custom", "category": "ci", "buildId": "123",
	})
	list := store.Get().Notification.List(0)
	if list[0].Category != notification.CategorySystem {
		t.Fatalf("unknown category must fall back to system, got %q", list[0].Category)
	}

	// 超限请求体 413（LimitBody 在解析前置位）
	huge := `{"title":"` + strings.Repeat("a", hookMaxBody) + `"}`
	req := httptest.NewRequest("POST", "/api/hooks", strings.NewReader(huge))
	req.Header.Set(HeaderToken, tok)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: want 413, got %d %s", w.Code, w.Body.String())
	}
}

func TestPostHook_URLActionAllowlist(t *testing.T) {
	r := hooksTestRouter(t)
	tok := issueHookToken(t, r)

	// 默认空清单：url 动作整体关闭（仅 panel: 现状零变化）
	if w := postHook(r, "/api/hooks", tok, map[string]any{
		"title": "x", "action": "url:https://ci.example.com/build/1",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("empty allowlist must reject url action: want 400, got %d %s", w.Code, w.Body.String())
	}

	// 注入允许域（注入口单测可换——生产实现现读设置）
	orig := allowedURLHosts
	allowedURLHosts = func() []string { return []string{"ci.example.com", "status.internal"} }
	t.Cleanup(func() { allowedURLHosts = orig })

	cases := []struct {
		name      string
		action    string
		want      int
		wantPaylo string
	}{
		{"allowed host", "url:https://ci.example.com/build/123", 200, "https://ci.example.com/build/123"},
		{"host case-insensitive", "url:https://CI.Example.COM/x", 200, "https://CI.Example.COM/x"},
		{"any port of allowed host", "url:https://ci.example.com:8443/x", 200, "https://ci.example.com:8443/x"},
		{"http scheme allowed", "url:http://status.internal/health", 200, "http://status.internal/health"},
		{"other host rejected", "url:https://evil.example.com/x", 400, ""},
		// @ 混淆：Hostname() 是 evil.com，不命中清单
		{"userinfo confusion rejected", "url:https://ci.example.com@evil.com/", 400, ""},
		{"subdomain not implied", "url:https://evil-ci.example.com/", 400, ""},
		{"non-http scheme rejected", "url:ftp://ci.example.com/x", 400, ""},
		{"javascript scheme rejected", "url:javascript:alert(1)", 400, ""},
		{"relative rejected", "url:/build/123", 400, ""},
		{"empty payload rejected", "url:", 400, ""},
		{"embedded whitespace rejected", "url:https://ci.example.com/a b", 400, ""},
		{"unknown prefix rejected", "route:files", 400, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postHook(r, "/api/hooks", tok, map[string]any{"title": "CI", "action": tc.action})
			if w.Code != tc.want {
				t.Fatalf("action=%q: want %d, got %d %s", tc.action, tc.want, w.Code, w.Body.String())
			}
			if tc.want != 200 {
				return
			}
			list := store.Get().Notification.List(0)
			if len(list) == 0 {
				t.Fatal("notification missing")
			}
			if list[0].Action != "url" || list[0].ActionPayload != tc.wantPaylo {
				t.Fatalf("url action not split: action=%q payload=%q", list[0].Action, list[0].ActionPayload)
			}
		})
	}
}

func TestPostHook_RateLimitPerToken(t *testing.T) {
	r := hooksTestRouter(t)
	tok := issueHookToken(t, r)
	payload := map[string]any{"title": "tick"}

	for i := 0; i < 60; i++ {
		if w := postHook(r, "/api/hooks", tok, payload); w.Code != 200 {
			t.Fatalf("request %d: want 200, got %d %s", i+1, w.Code, w.Body.String())
		}
	}
	w := postHook(r, "/api/hooks", tok, payload)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("61st request: want 429, got %d %s", w.Code, w.Body.String())
	}
	// 换 URL 载体不绕过配额（两载体共用同一限流器）
	if w := postHook(r, "/api/hooks/"+tok, "", payload); w.Code != http.StatusTooManyRequests {
		t.Fatalf("url carrier must share the same bucket: want 429, got %d %s", w.Code, w.Body.String())
	}

	// 轮换出新凭据即新桶（旧桶只影响旧凭据）
	tok2 := issueHookToken(t, r)
	if w := postHook(r, "/api/hooks", tok2, payload); w.Code != 200 {
		t.Fatalf("fresh token should not inherit old bucket: got %d %s", w.Code, w.Body.String())
	}
}

func TestHookTokenManagement_AuditAndRevoke(t *testing.T) {
	r := hooksTestRouter(t)

	// 首次签发：meta exists + 审计 hook.token.rotate detail=created
	tok := issueHookToken(t, r)
	meta := store.Get().HookToken.Meta()
	if !meta.Exists || len(meta.Prefix) != 4 {
		t.Fatalf("unexpected meta after issue: %+v", meta)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/hook-token", nil))
	if w.Code != 200 {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	if store.Get().HookToken.Validate(tok) {
		t.Fatal("revoked token must be invalid")
	}
	if w := postHook(r, "/api/hooks", tok, map[string]any{"title": "x"}); w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token inbound: want 401, got %d", w.Code)
	}

	// 审计：rotate(created) + revoke 两条，明文绝不入账
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	var actions []string
	for _, e := range events {
		actions = append(actions, e.Action)
		if strings.Contains(e.Detail, tok) {
			t.Fatalf("audit event leaks token: %+v", e)
		}
	}
	if !contains(actions, store.AuditHookTokenRotate) || !contains(actions, store.AuditHookTokenRevoke) {
		t.Fatalf("missing audit actions, got %v", actions)
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
