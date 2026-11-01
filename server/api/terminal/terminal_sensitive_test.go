package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/shared"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 会话敏感标记与出域闸门（P-20261003-155）单测：
//   - 标记端点：置位/复位幂等往返 + 快照投影「置位携键 / 未标记缺 key」契约
//     + 无 meta 无会话 404 + 非法请求体 400
//   - 导出闸门：标记后无 override 出 JSON warnings（不出附件头），override=1
//     直出附件；复位后恢复直出（未标记零变化）。直播分享闸门同判定函数
//    （shared.IsSessionSensitive），happy path 由定向 e2e 覆盖（shareapi
//     单测惯例：不拉真实 PTY）

func setupSensitiveTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/terminals/:id/sensitive", SetSessionSensitive)
	r.GET("/api/terminals/:id/export", GetTerminalExport)
	return r
}

func postSensitive(t *testing.T, r *gin.Engine, id, body string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/"+id+"/sensitive", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func TestSetSessionSensitive_RoundtripAndSnapshot(t *testing.T) {
	r := setupSensitiveTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-sen-1", Dir: "/tmp/x", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	// 置位：200 且落库
	if code, body := postSensitive(t, r, "agent-sen-1", `{"sensitive":true}`); code != http.StatusOK {
		t.Fatalf("mark status = %d, body = %s", code, body)
	}
	meta, err := store.Get().AgentSession.Get("agent-sen-1")
	if err != nil || meta == nil || !meta.Sensitive {
		t.Fatalf("sensitive not persisted: %v %+v", err, meta)
	}
	// 快照投影：置位携键
	item := gin.H{"id": "agent-sen-1"}
	applySessionMetaSnapshot(item, "agent-sen-1")
	if item["sensitive"] != true {
		t.Fatalf("snapshot should carry sensitive=true: %v", item)
	}

	// 复位：200 且键收回（快照「缺 key = 未标记」契约）
	if code, body := postSensitive(t, r, "agent-sen-1", `{"sensitive":false}`); code != http.StatusOK {
		t.Fatalf("unmark status = %d, body = %s", code, body)
	}
	item2 := gin.H{"id": "agent-sen-1"}
	applySessionMetaSnapshot(item2, "agent-sen-1")
	if _, present := item2["sensitive"]; present {
		t.Fatalf("unmarked session must not carry sensitive key: %v", item2)
	}

	// 非法请求体（缺 sensitive 字段）→ 400
	if code, _ := postSensitive(t, r, "agent-sen-1", `{}`); code != http.StatusBadRequest {
		t.Fatalf("missing field status = %d, want 400", code)
	}
	// 无 meta 且无存活会话 → 404（标记无处可落）
	if code, _ := postSensitive(t, r, "agent-never-existed", `{"sensitive":true}`); code != http.StatusNotFound {
		t.Fatalf("unknown session status = %d, want 404", code)
	}
	// 快照无记录会话零键（契约同 runtime/runtimeVersion）
	item3 := gin.H{"id": "agent-never-existed"}
	applySessionMetaSnapshot(item3, "agent-never-existed")
	if _, present := item3["sensitive"]; present {
		t.Fatalf("no-record session must not carry sensitive key: %v", item3)
	}
}

// TestAgentSessionMeta_SensitiveBackcompat 旧文档缺 sensitive 字段反序列化
// false（升级兼容：旧数据面 + 新二进制零迁移）
func TestAgentSessionMeta_SensitiveBackcompat(t *testing.T) {
	var meta store.AgentSessionMeta
	if err := json.Unmarshal([]byte(`{"id":"old-1","dir":"/tmp/x"}`), &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Sensitive {
		t.Fatalf("legacy doc without sensitive must unmarshal false")
	}
}

// TestTerminalExport_SensitiveGate 导出闸门：真实 PTY 会话（不可用环境跳过，
// idle_realpty_test 同惯例）——顺带覆盖标记端点经 manager 补建 meta 的 upsert
// 分支（创建异步落库窗口期）。
// 平台注记：寻址一律用 CreateSession 返回的 Session.ID——tmux 后端（Linux
// auto 档）下会话 ID 是生成的 tmux 名而非调用方传入 id（manager.go
// finalID=tmuxName），Windows native 下两者相同、Linux 下不同
func TestTerminalExport_SensitiveGate(t *testing.T) {
	r := setupSensitiveTest(t)
	s, err := terminal.DefaultManager.CreateSession("sen-gate-1", "sen-gate", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s.ID) })
	id := s.ID

	// 未标记直出：附件头 + 200（现状零变化）
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("unmarked export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}

	// 标记（meta 缺失 → manager 补建）：无 override 出 JSON warnings、零附件头
	if code, body := postSensitive(t, r, id, `{"sensitive":true}`); code != http.StatusOK {
		t.Fatalf("mark status = %d, body = %s", code, body)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("gated export status = %d", w.Code)
	}
	if disp := w.Header().Get("Content-Disposition"); disp != "" {
		t.Fatalf("gated export must not be an attachment, disp = %q", disp)
	}
	var out struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("gated export body not JSON: %v (%s)", err, w.Body.String())
	}
	if len(out.Warnings) != 1 || out.Warnings[0] != shared.SensitiveSessionWarning {
		t.Fatalf("warnings = %v, want [%s]", out.Warnings, shared.SensitiveSessionWarning)
	}

	// override=1：确认后直出附件
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export?override=1", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("override export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}

	// 复位后恢复直出（标记只管出域，不产生残留行为）
	if code, _ := postSensitive(t, r, id, `{"sensitive":false}`); code != http.StatusOK {
		t.Fatalf("unmark status = %d", code)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("unmarked export after reset: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
}
