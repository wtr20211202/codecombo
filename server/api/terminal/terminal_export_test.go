package terminal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 导出端点 handler 级测试：DefaultManager 无会话 → 404 路径。
// 内容/文件名/护栏逻辑在 terminal 包单测覆盖（export_test.go）——
// 与 search 端点测试同分工（api 层只验证参数门与错误整形）。

func TestGetTerminalExportUnknownSession404(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/:id/export", GetTerminalExport)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/no-such-session/export", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown session should be 404, got %d", w.Code)
	}
	// 错误路径不得带附件头（半失败下载会让人拿到错误页当存档）
	if disp := w.Header().Get("Content-Disposition"); disp != "" {
		t.Fatalf("404 must not carry Content-Disposition, got %q", disp)
	}
	if !strings.Contains(w.Body.String(), "session not found") {
		t.Fatalf("error body unexpected: %s", w.Body.String())
	}
}

// TestGetTerminalExport_AuditOnEgress 出域记账（P-20261005-186，terminal.export）：
// 真实 PTY 会话（不可用环境跳过，terminal_sensitive_test 同惯例）——成功直出
// 与 override 放行两条出域路径各入账一条（Detail 含会话名/id），敏感闸 warnings
// 分支与 404 分支零入账（未出内容不算出域）。导出族记账对称性的回归防线。
func TestGetTerminalExport_AuditOnEgress(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.GET("/api/terminals/:id/export", GetTerminalExport)

	s, err := terminal.DefaultManager.CreateSession("exp-aud-1", "exp-aud", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s.ID) })
	id := s.ID

	auditCount := func(t *testing.T) int {
		t.Helper()
		events, _, err := store.Get().Audit.List(100, 0)
		if err != nil {
			t.Fatalf("list audit: %v", err)
		}
		return len(events)
	}

	// 成功直出：附件 + 一条 terminal.export（Detail 含会话名与 id）
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(events))
	}
	ev := events[0]
	if ev.Action != store.AuditTerminalExport || ev.Result != store.AuditResultSuccess {
		t.Fatalf("event = %s/%s, want %s/success", ev.Action, ev.Result, store.AuditTerminalExport)
	}
	if !strings.Contains(ev.Detail, "exp-aud") || !strings.Contains(ev.Detail, id) {
		t.Fatalf("detail %q must carry session name and id", ev.Detail)
	}
	if ev.IP == "" {
		t.Fatalf("egress event must record client ip")
	}

	// 404 分支：零入账（未到出域段）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/no-such/export", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown session: status=%d", w.Code)
	}
	if n := auditCount(t); n != 1 {
		t.Fatalf("404 path must not audit, events = %d", n)
	}

	// 敏感闸 warnings 分支：零入账（未出内容不算出域）
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: id, Dir: t.TempDir(), CreatedAt: time.Now(), Sensitive: true}); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("gated export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	if n := auditCount(t); n != 1 {
		t.Fatalf("warnings branch must not audit, events = %d", n)
	}

	// override 放行：真出域，+1 入账
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export?override=1", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("override export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	events, _, err = store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Action != store.AuditTerminalExport {
		t.Fatalf("override path must audit terminal.export, events = %d", len(events))
	}
}
