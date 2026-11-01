package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 项目笔记端点测试（P-20261002-110）：走完整请求链（LockMiddleware 之外的
// handler 本体）──覆盖：空笔记 200、写读回环、256KB 边界（恰好在限内 200 /
// 超限 413）、请求体粗上限、项目不存在 404。

func setupNotesTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/projects/:id/notes", GetProjectNotes)
	r.PUT("/api/projects/:id/notes", PutProjectNotes)
	return r
}

func getNotes(r *gin.Engine, path string) (*httptest.ResponseRecorder, store.ProjectNote) {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	var body struct {
		Data store.ProjectNote `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w, body.Data
}

func putNotes(r *gin.Engine, path, content string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"content":`+jsonStr(content)+`}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

// jsonStr 字符串转 JSON 字面量（含换行/引号的正文也能安全进请求体）
func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestProjectNotes_EmptyIs200 项目从未写过笔记：200 + 空内容（便签空即无，不 404）
func TestProjectNotes_EmptyIs200(t *testing.T) {
	r := setupNotesTest(t)

	w, n := getNotes(r, "/api/projects/p1/notes")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for absent notes, got %d", w.Code)
	}
	if n.Content != "" {
		t.Errorf("expected empty content, got %q", n.Content)
	}

	// 项目不存在：404
	if w := putNotes(r, "/api/projects/ghost/notes", "x"); w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for ghost project, got %d", w.Code)
	}
}

// TestProjectNotes_PutGetRoundtrip 面板写 → agent 读的同源回环
func TestProjectNotes_PutGetRoundtrip(t *testing.T) {
	r := setupNotesTest(t)

	content := "# 交接说明\n\n- 待办：修复登录超时\n"
	if w := putNotes(r, "/api/projects/p1/notes", content); w.Code != http.StatusOK {
		t.Fatalf("expected 200 on save, got %d: %s", w.Code, w.Body.String())
	}
	w, n := getNotes(r, "/api/projects/p1/notes")
	if w.Code != http.StatusOK || n.Content != content {
		t.Fatalf("roundtrip mismatch: code=%d content=%q", w.Code, n.Content)
	}
	if n.UpdatedAt.IsZero() {
		t.Error("expected updatedAt set")
	}
}

// TestProjectNotes_SizeLimit413 256KB 边界：限内 200，超限 413（双层防线：
// 请求体粗上限与仓储精确上限各自可达）
func TestProjectNotes_SizeLimit413(t *testing.T) {
	r := setupNotesTest(t)

	// 恰好 256KB：放行
	if w := putNotes(r, "/api/projects/p1/notes", strings.Repeat("a", store.ProjNotesMaxBytes)); w.Code != http.StatusOK {
		t.Fatalf("expected exact-256KB accepted, got %d: %s", w.Code, w.Body.String())
	}
	// 256KB+1：仓储层精确判定 413
	if w := putNotes(r, "/api/projects/p1/notes", strings.Repeat("a", store.ProjNotesMaxBytes+1)); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for 256KB+1, got %d", w.Code)
	}
	// 粗上限兜底（>4MB 请求体在解析期拒绝，防超大 JSON 进内存）：
	// 用无转义膨胀的 ASCII 构造 5MB body
	if w := putNotes(r, "/api/projects/p1/notes", strings.Repeat("a", 5<<20)); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", w.Code)
	}
}
