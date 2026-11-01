package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/claudesessions"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 会话隐藏/恢复 handler 测试（P-20261003-112）：管理视图端点（hidden=1 只回
// 隐藏行）、策展 hidden 部分更新（只带 hidden 不动星标/备注）、隐藏/恢复写
// 审计事件且 Detail 含会话名（自明化）、值不变不记审计。
// fixture 与 SC_CLAUDE_DIR 隔离同 setupPressureTest 惯例。

func setupHideTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/claude/sessions", ListClaudeSessions)
	r.POST("/api/claude/sessions/curation", SetClaudeSessionCuration)
	return r, root
}

func writeHideFixture(t *testing.T, root, id, title string, mod time.Time) {
	t.Helper()
	dir := filepath.Join(root, claudesessions.EncodePath(`D:\p`))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := strings.Join([]string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"` + title + `"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\p"}`,
	}, "\n") + "\n"
	path := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func postCuration(t *testing.T, r *gin.Engine, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/curation", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("curation status = %d: %s", w.Code, w.Body.String())
	}
	var res struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res.Data
}

func TestCurationHiddenRoundtripAndAudit(t *testing.T) {
	r, root := setupHideTest(t)
	writeHideFixture(t, root, "hide-a1b2c3d4", "要隐藏的实验会话", time.Now().Add(-time.Hour))

	// 先拉一次列表（与真实流程一致：隐藏按钮在列表行上，索引已热——
	// LookupTitle 从索引条目取会话名，冷索引才回退 id）
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("list warmup status = %d", w.Code)
	}

	// 隐藏：写审计，Detail 含会话名（索引标题）——隐私操作留痕自明化
	postCuration(t, r, `{"sessionId":"hide-a1b2c3d4","hidden":true}`)
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Action != store.AuditClaudeHide {
		t.Fatalf("hide must audit: %+v", events)
	}
	if !strings.Contains(events[0].Detail, "要隐藏的实验会话") || !strings.Contains(events[0].Detail, "hide-a1b") {
		t.Fatalf("audit detail must carry session name: %q", events[0].Detail)
	}

	// 隐藏态的部分更新不动其他策展字段（只带 starred，hidden 保持）
	data := postCuration(t, r, `{"sessionId":"hide-a1b2c3d4","starred":true}`)
	if data["hidden"] != true || data["starred"] != true {
		t.Fatalf("partial update must preserve hidden: %v", data)
	}

	// 管理视图：只回隐藏行，行带 hidden/starred 字段
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions?hidden=1", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("hidden view status = %d", w.Code)
	}
	var list struct {
		Data struct {
			Sessions []struct {
				ID      string `json:"id"`
				Hidden  bool   `json:"hidden"`
				Starred bool   `json:"starred"`
			} `json:"sessions"`
			Total int `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Data.Total != 1 || len(list.Data.Sessions) != 1 || list.Data.Sessions[0].ID != "hide-a1b2c3d4" || !list.Data.Sessions[0].Hidden || !list.Data.Sessions[0].Starred {
		t.Fatalf("hidden view rows: %+v", list.Data)
	}

	// 恢复：写恢复审计；星标/备注仍在（恢复 ≠ 清策展）——先清备注再恢复，
	// 验证「恢复后条目仍存在」路径
	postCuration(t, r, `{"sessionId":"hide-a1b2c3d4","note":"存档备注"}`)
	postCuration(t, r, `{"sessionId":"hide-a1b2c3d4","hidden":false}`)
	events, _, _ = store.Get().Audit.List(10, 0)
	if events[0].Action != store.AuditClaudeUnhide {
		t.Fatalf("unhide must audit as unhide: %+v", events[0])
	}
	cur, err := store.Get().ClaudeCur.GetBatch(store.ClaudeCurPrefix(root))
	if err != nil || len(cur) != 1 {
		t.Fatalf("unhide must keep curation entry: %v %v", err, cur)
	}
	for _, e := range cur {
		if e.Hidden || e.Note != "存档备注" || !e.Starred {
			t.Fatalf("unhide must preserve starred/note: %+v", e)
		}
	}

	// 默认列表回到可见；管理视图空
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions", nil))
	if !strings.Contains(w.Body.String(), `"total":1`) {
		t.Fatalf("default list must show restored session: %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions?hidden=1", nil))
	if !strings.Contains(w.Body.String(), `"total":0`) {
		t.Fatalf("hidden view must be empty after restore: %s", w.Body.String())
	}
}

// 值不变不记审计（重复提交同一 hidden 不算动作）
func TestCurationHiddenNoopNoAudit(t *testing.T) {
	r, _ := setupHideTest(t)
	postCuration(t, r, `{"sessionId":"noop-a1b2c3d4","hidden":true}`)
	postCuration(t, r, `{"sessionId":"noop-a1b2c3d4","hidden":true}`) // 重复
	events, _, _ := store.Get().Audit.List(10, 0)
	if len(events) != 1 {
		t.Fatalf("noop repeat must not audit twice: %+v", events)
	}
}

// 双清删条目的幂等性：条目不存在时「全部清空」应幂等成功（postcondition 已满足），
// 而非 500 document not found——清理方（e2e 播种前对账/前端重复双清）会打在
// 无残留形态上（fulle2e run7 抓得 500 假失败）
func TestCurationClearMissingEntryIdempotent(t *testing.T) {
	r, _ := setupHideTest(t)

	// 无任何先导写入：对不存在的条目双清（starred=false + note=""）
	req := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/curation", strings.NewReader(`{"sessionId":"ghost-a1b2c3d4","starred":false,"note":""}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("clear on missing entry must be idempotent 200, got %d: %s", w.Code, w.Body.String())
	}
	var res struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data["starred"] != false || res.Data["note"] != "" {
		t.Fatalf("clear response must be all-zero: %v", res.Data)
	}

	// 幂等可重复：同一不存在的条目再清一次仍 200
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/curation", strings.NewReader(`{"sessionId":"ghost-a1b2c3d4","starred":false,"note":""}`))
	req2.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("repeat clear on missing entry must stay 200, got %d: %s", w2.Code, w2.Body.String())
	}
}
