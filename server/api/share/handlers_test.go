package shareapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// newSnippetRouter gin 测试路由（仅片段创建；store 换成临时目录实例）
func newSnippetRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/share/snippet", CreateSnippet)
	return r
}

// postSnippet 发一次创建请求并解包响应
func postSnippet(t *testing.T, r *gin.Engine, body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/share/snippet", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// TestCreateSnippetHandler 创建/上限/校验：200 data.kind=snippet、413 超
// 32KB、400 空内容；响应不含 Content（管理面只回元数据）
func TestCreateSnippetHandler(t *testing.T) {
	r := newSnippetRouter(t)

	// 正常创建：缺省名取内容首行
	code, out := postSnippet(t, r, `{"content":"panic: boom\n  at main()"}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("missing data: %v", out)
	}
	if data["kind"] != string(store.ShareKindSnippet) {
		t.Fatalf("kind = %v, want snippet", data["kind"])
	}
	if data["name"] != "panic: boom" {
		t.Fatalf("default name = %v, want first content line", data["name"])
	}
	if _, has := data["expiresAt"]; !has {
		t.Fatal("snippet response should carry expiresAt")
	}
	if _, has := data["content"]; has {
		t.Fatal("response must not carry snippet content")
	}
	// size = 内容字节数（JSON \n 解转义后的真实换行）
	if s, _ := data["size"].(float64); int(s) != len("panic: boom\n  at main()") {
		t.Fatalf("size = %v", data["size"])
	}

	// 超上限 → 413
	big := `{"content":"` + strings.Repeat("a", store.MaxSnippetBytes+1) + `"}`
	code, _ = postSnippet(t, r, big)
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d, want 413", code)
	}

	// 空内容 → 400（binding required）
	code, _ = postSnippet(t, r, `{"content":""}`)
	if code != http.StatusBadRequest {
		t.Fatalf("empty content status = %d, want 400", code)
	}

	// 显式名 + 控制字符折叠为空格
	code, out = postSnippet(t, r, `{"content":"x","name":"my\ttitle"}`)
	if code != http.StatusOK {
		t.Fatalf("named create status = %d", code)
	}
	if data, _ := out["data"].(map[string]any); data["name"] != "my title" {
		t.Fatalf("control chars should fold to spaces in name: %v", data["name"])
	}
}

// newAdminRouter gin 测试路由（管理面全量：创建/列表/轮换/撤销；store 换成
// 临时目录实例）。附种子项目：临时目录里落一个真实文件供 StatTarget 与
// 敏感扫描（返回路径供用例构造分享目标）
func newAdminRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "demo", Path: dir}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	r := gin.New()
	r.POST("/api/share", CreateShare)
	r.GET("/api/share", ListShares)
	r.POST("/api/share/snippet", CreateSnippet)
	r.POST("/api/share/:token/rotate", RotateShare)
	r.POST("/api/share/:token/refresh", RefreshShare)
	r.DELETE("/api/share/:token", DeleteShare)
	return r
}

// doJSON 发一次请求并解包 JSON 响应（body 为空串时不设 Content-Type）
func doJSON(r *gin.Engine, method, path, body string) (int, map[string]any) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// TestRotateShareHandler 轮换端点（P-20261002-72）：200 带新 token（≠旧）、
// 旧 token 再轮换 404、未知 token 404、轮换后同目标创建幂等跟随当前代际、
// snippet 同构、撤销后轮换 404
func TestRotateShareHandler(t *testing.T) {
	r := newAdminRouter(t)

	// 文件分享创建 → 轮换：200 + 全新 token
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d, body = %v", code, out)
	}
	created, _ := out["data"].(map[string]any)
	if created == nil {
		t.Fatalf("missing created share: %v", out)
	}
	oldToken, _ := created["token"].(string)
	if oldToken == "" {
		t.Fatalf("empty token: %v", out)
	}

	code, out = doJSON(r, http.MethodPost, "/api/share/"+oldToken+"/rotate", "")
	if code != http.StatusOK {
		t.Fatalf("rotate status = %d, body = %v", code, out)
	}
	rotated, _ := out["data"].(map[string]any)
	if rotated == nil {
		t.Fatalf("missing rotated share: %v", out)
	}
	newToken, _ := rotated["token"].(string)
	if newToken == "" || newToken == oldToken {
		t.Fatalf("rotate must return a fresh token: %v", out)
	}

	// 旧 token 立即失效（再轮换 404）；未知 token 404
	if code, _ = doJSON(r, http.MethodPost, "/api/share/"+oldToken+"/rotate", ""); code != http.StatusNotFound {
		t.Fatalf("rotate old token status = %d, want 404", code)
	}
	if code, _ = doJSON(r, http.MethodPost, "/api/share/zzzzzzzzzzzzzzzz/rotate", ""); code != http.StatusNotFound {
		t.Fatalf("rotate unknown token status = %d, want 404", code)
	}

	// 幂等创建跟随当前代际：同目标再分享拿到轮换后的链（不复活旧链），列表恰一条
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("recreate status = %d", code)
	}
	if data, _ := out["data"].(map[string]any); data["token"] != newToken {
		t.Fatalf("recreate must follow rotated token %s, got %v", newToken, data["token"])
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	if list, _ := out["data"].([]any); len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}

	// snippet 同构：创建 → 轮换 → 旧 token 404，新记录保留 expiresAt
	code, out = doJSON(r, http.MethodPost, "/api/share/snippet", `{"content":"panic: boom"}`)
	if code != http.StatusOK {
		t.Fatalf("snippet create status = %d", code)
	}
	snippet, _ := out["data"].(map[string]any)
	sTok, _ := snippet["token"].(string)
	code, out = doJSON(r, http.MethodPost, "/api/share/"+sTok+"/rotate", "")
	if code != http.StatusOK {
		t.Fatalf("snippet rotate status = %d", code)
	}
	sRot, _ := out["data"].(map[string]any)
	if sRot["token"] == sTok {
		t.Fatal("snippet rotate must return a new token")
	}
	if _, has := sRot["expiresAt"]; !has {
		t.Fatal("rotated snippet must keep expiresAt (no TTL extension)")
	}
	if code, _ = doJSON(r, http.MethodPost, "/api/share/"+sTok+"/rotate", ""); code != http.StatusNotFound {
		t.Fatalf("rotate old snippet token status = %d, want 404", code)
	}

	// 撤销后轮换 → 404
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+newToken, ""); code != http.StatusOK {
		t.Fatalf("revoke status = %d", code)
	}
	if code, _ = doJSON(r, http.MethodPost, "/api/share/"+newToken+"/rotate", ""); code != http.StatusNotFound {
		t.Fatalf("rotate after revoke status = %d, want 404", code)
	}
}

// stubWiring liveWiring 桩：记录 Wire/Unwire 调用序列
type stubWiring struct{ calls []string }

func (s *stubWiring) Wire(token, sessionID string) {
	s.calls = append(s.calls, "wire:"+token+"|"+sessionID)
}
func (s *stubWiring) Unwire(token string) { s.calls = append(s.calls, "unwire:"+token) }

// TestCreateTerminalLiveValidation 创建校验：404 未知会话、400 负 TTL。
// happy path（真实 PTY 会话）由定向 e2e 覆盖，单测不拉真进程
func TestCreateTerminalLiveValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/share/terminal", CreateTerminalLive)

	post := func(body string) (int, string) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/share/terminal", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w.Code, w.Body.String()
	}

	// 未知会话 → 404（无可直播的源，不建空直播记录）
	if code, _ := post(`{"sessionId":"no-such-session"}`); code != http.StatusNotFound {
		t.Fatalf("unknown session status = %d, want 404", code)
	}
	// 负 TTL → 400
	if code, _ := post(`{"sessionId":"s","ttlMinutes":-5}`); code != http.StatusBadRequest {
		t.Fatalf("negative ttl status = %d, want 400", code)
	}
	// 缺 sessionId → 400（binding required）
	if code, _ := post(`{}`); code != http.StatusBadRequest {
		t.Fatalf("missing sessionId status = %d, want 400", code)
	}
}

// TestTerminalLiveRewireOnRevokeRotate 撤销/轮换即断流：DELETE 与 rotate
// 都要对终端形态记录触发 Unwire（旧链订阅者收 end 帧）；文件形态不触发
func TestTerminalLiveRewireOnRevokeRotate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	wiring := &stubWiring{}
	setLiveWire(wiring)
	t.Cleanup(func() { setLiveWire(nil) })

	r := gin.New()
	r.DELETE("/api/share/:token", DeleteShare)
	r.POST("/api/share/:token/rotate", RotateShare)

	// 终端形态：撤销 → Unwire
	created, err := store.Get().Share.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-1", Name: "t1"})
	if err != nil {
		t.Fatalf("seed terminal share: %v", err)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/share/"+created.Token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	if len(wiring.calls) != 1 || wiring.calls[0] != "unwire:"+created.Token {
		t.Fatalf("unwire calls = %v, want exactly one unwire of revoked token", wiring.calls)
	}

	// 终端形态：轮换 → 旧 token Unwire
	created2, err := store.Get().Share.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-2", Name: "t2"})
	if err != nil {
		t.Fatalf("seed terminal share 2: %v", err)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/share/"+created2.Token+"/rotate", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate status = %d", w.Code)
	}
	if len(wiring.calls) != 2 || wiring.calls[1] != "unwire:"+created2.Token {
		t.Fatalf("unwire calls = %v, want unwire of old token after rotate", wiring.calls)
	}

	// 文件形态：撤销不触发 Unwire
	created3, err := store.Get().Share.Create(store.Share{Kind: store.ShareKindFile, ProjectID: "p1", Path: "docs"})
	if err != nil {
		t.Fatalf("seed file share: %v", err)
	}
	before := len(wiring.calls)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/share/"+created3.Token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("delete file share status = %d", w.Code)
	}
	if len(wiring.calls) != before {
		t.Fatalf("file share revoke must not unwire: %v", wiring.calls)
	}
}
