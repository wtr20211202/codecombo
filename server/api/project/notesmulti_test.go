package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/store"
)

// ── 笔记库 handler 实现体测试（P-20261107-2 多篇 → P-20261108-3 单库化）：
// list 元数据不内联 content、CRUD 主干、baseUpdatedAt 409 载荷、软删/恢复幂等、
// purge 人侧限定、标题/内容/请求体上限、导出 Content-Disposition。实现体只认
// 作用域（notesmulti.go），单库化后唯一端点族是 /api/notes（全局库），故经
// 全局族路由走完整请求链（handler 本体）——原项目族端点已退役 ──

func postNote(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func putNote(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func deleteNote(r *gin.Engine, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, path, nil))
	return w
}

// jsonStr 字符串转 JSON 字面量（含换行/引号的正文也能安全进请求体）
func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestNotesMulti_ListMetaNoContent 清单面只回元数据（id/title/updatedAt/size），
// 绝不内联 content——100 篇×256KB 内联会拖垮面板首开（提案性能两刀之一）
func TestNotesMulti_ListMetaNoContent(t *testing.T) {
	r := setupNotesGlobalTest(t)
	createGlobalNote(t, r, "A", strings.Repeat("a", 1000))
	createGlobalNote(t, r, "B", "b")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", w.Code)
	}
	if strings.Contains(w.Body.String(), strings.Repeat("a", 1000)) {
		t.Fatal("list must not inline content")
	}
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("list body: %v", err)
	}
	if len(body.Data) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(body.Data))
	}
	first := body.Data[0]
	if first["title"] != "B" { // updatedAt 降序：后建的 B 在前
		t.Errorf("expected newest first (B), got %v", first["title"])
	}
	if _, has := first["size"]; !has {
		t.Error("expected size field in list meta")
	}
	if _, has := first["content"]; has {
		t.Error("list meta must not carry content field")
	}
}

// TestNotesMulti_ConflictAndLWW 覆盖保护三件套①：baseUpdatedAt 过期 → 409
// notes.conflict 携 currentContent；不传 → last-writer-wins
func TestNotesMulti_ConflictAndLWW(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "", "v1")
	staleBase := n.UpdatedAt.Format(time.RFC3339Nano)

	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v2"}`); w.Code != http.StatusOK {
		t.Fatalf("external save: expected 200, got %d", w.Code)
	}
	w := putNote(r, "/api/notes/"+n.ID, `{"content":"v3-stale","baseUpdatedAt":`+jsonStr(staleBase)+`}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for stale baseUpdatedAt, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"notes.conflict"`) ||
		!strings.Contains(w.Body.String(), `"currentContent":"v2"`) {
		t.Errorf("conflict payload missing code/currentContent: %s", w.Body.String())
	}
	// 不传基准 → last-writer-wins
	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v3"}`); w.Code != http.StatusOK {
		t.Fatalf("LWW save: expected 200, got %d", w.Code)
	}
}

// TestNotesMulti_RenameViaPut 重命名折叠进 PUT（可选 title 字段）；省略 title 不动标题
func TestNotesMulti_RenameViaPut(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "old", "c")

	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"c2","title":"new"}`); w.Code != http.StatusOK {
		t.Fatalf("rename save: expected 200, got %d", w.Code)
	}
	got, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID)
	if err != nil || got.Title != "new" || got.Content != "c2" {
		t.Errorf("rename failed: %+v err=%v", got, err)
	}
	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"c3"}`); w.Code != http.StatusOK {
		t.Fatalf("save: expected 200, got %d", w.Code)
	}
	if got, _ = store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); got.Title != "new" || got.Content != "c3" {
		t.Errorf("nil-title save must keep title: %+v", got)
	}
}

// TestNotesMulti_TrashLifecycle 软删 → 回收站视图 → 恢复（幂等）；不存在的篇 404
func TestNotesMulti_TrashLifecycle(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "A", "content")

	if w := deleteNote(r, "/api/notes/"+n.ID); w.Code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", w.Code)
	}
	if _, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); err != nil {
		t.Fatalf("soft delete must keep document: %v", err)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes", nil))
	if strings.Contains(w.Body.String(), `"title":"A"`) {
		t.Error("live list must not show trashed note")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes?trash=1", nil))
	if !strings.Contains(w.Body.String(), `"title":"A"`) {
		t.Error("trash view must show trashed note")
	}
	for i := 0; i < 2; i++ {
		if w := postNote(r, "/api/notes/"+n.ID+"/restore", `{}`); w.Code != http.StatusOK {
			t.Fatalf("restore #%d: expected 200, got %d", i, w.Code)
		}
	}
	if got, _ := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); !got.Live() {
		t.Error("expected live after restore")
	}
	if w := deleteNote(r, "/api/notes/ghost"); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "notes.not_found") {
		t.Errorf("expected 404 notes.not_found for ghost, got %d: %s", w.Code, w.Body.String())
	}
}

// TestNotesMulti_PurgeHumanOnly 彻底删除（人侧锁令牌形态）：文档硬删 + 幂等
func TestNotesMulti_PurgeHumanOnly(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "A", "content")

	if w := deleteNote(r, "/api/notes/"+n.ID+"?purge=1"); w.Code != http.StatusOK {
		t.Fatalf("purge: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); err != store.ErrNotFound {
		t.Fatalf("expected purged document gone, got %v", err)
	}
	if w := deleteNote(r, "/api/notes/"+n.ID+"?purge=1"); w.Code != http.StatusOK {
		t.Errorf("idempotent purge: expected 200, got %d", w.Code)
	}
}

// TestNotesMulti_Limits4xx 标题超长 / 内容超限 / 请求体粗上限的错误面
func TestNotesMulti_Limits4xx(t *testing.T) {
	r := setupNotesGlobalTest(t)

	if w := postNote(r, "/api/notes", `{"title":"`+strings.Repeat("标", 67)+`"}`); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "notes.title_too_long") {
		t.Errorf("expected 400 notes.title_too_long, got %d: %s", w.Code, w.Body.String())
	}
	// 恰好 256KB 放行（默认篇直写 upsert 路径）/ +1 字节 413（仓储层精确判定）
	if w := putNote(r, "/api/notes/"+store.DefaultNoteID, `{"content":"`+strings.Repeat("a", store.ProjNotesMaxBytes)+`"}`); w.Code != http.StatusOK {
		t.Errorf("expected exact-256KB accepted, got %d", w.Code)
	}
	if w := postNote(r, "/api/notes", `{"content":"`+strings.Repeat("a", store.ProjNotesMaxBytes+1)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for 256KB+1, got %d", w.Code)
	}
	// 粗上限兜底（>4MB 请求体在解析期拒绝，防超大 JSON 进内存）
	if w := putNote(r, "/api/notes/"+store.DefaultNoteID, `{"content":"`+strings.Repeat("a", 5<<20)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for oversized body, got %d", w.Code)
	}
}

// TestNotesMulti_Export 单篇导出：Content-Disposition 净化链 + md/txt 格式
func TestNotesMulti_Export(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "交接/说明:草稿", "# 内容")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes/"+n.ID+"/export", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("export: expected 200, got %d", w.Code)
	}
	cd := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment;") || strings.Contains(cd, `"交接/说明:草稿.md"`) {
		t.Errorf("Content-Disposition not sanitized: %q", cd)
	}
	if !strings.Contains(cd, ".md") {
		t.Errorf("expected .md filename in %q", cd)
	}
	if w.Body.String() != "# 内容" {
		t.Errorf("export body mismatch: %q", w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes/"+n.ID+"/export?format=txt", nil))
	if !strings.Contains(w.Header().Get("Content-Disposition"), ".txt") {
		t.Errorf("expected .txt filename, got %q", w.Header().Get("Content-Disposition"))
	}
}
