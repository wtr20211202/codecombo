package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 笔记库端点测试（P-20261107-5 /api/notes 族 → P-20261108-3 单库化后唯一
// 笔记族）：本套钉作用域专属语义（哨兵作用域生效 / 额度 notes.global_limit /
// 默认篇 upsert 与 409 / 迁移端点）。实现体主干（list/rename/trash/purge/
// 上限/导出）见 notesmulti_test.go ──

func setupNotesGlobalTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/notes", ListGlobalNotes)
	r.POST("/api/notes", CreateGlobalNote)
	r.GET("/api/notes/migration", GetNotesMigration)
	r.POST("/api/notes/migration", PostNotesMigration)
	r.GET("/api/notes/:noteId", GetGlobalNote)
	r.PUT("/api/notes/:noteId", PutGlobalNote)
	r.DELETE("/api/notes/:noteId", DeleteGlobalNote)
	r.POST("/api/notes/:noteId/restore", RestoreGlobalNote)
	r.GET("/api/notes/:noteId/export", ExportGlobalNote)
	return r
}

func createGlobalNote(t *testing.T, r *gin.Engine, title, content string) store.MultiNote {
	t.Helper()
	w := postNote(r, "/api/notes", `{"title":`+jsonStr(title)+`,"content":`+jsonStr(content)+`}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create global note: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data store.MultiNote `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("create global note body: %v", err)
	}
	if body.Data.ID == "" || body.Data.ID == store.DefaultNoteID {
		t.Fatalf("expected server-generated uuid id, got %q", body.Data.ID)
	}
	return body.Data
}

// TestNotesGlobal_CRUDUnderSentinelScope 端点写出的篇落在 _global-<id> 作用域；
// 保存/软删/恢复同作用域闭环
func TestNotesGlobal_CRUDUnderSentinelScope(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "随手记", "global body")

	if got, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); err != nil || got.Content != "global body" {
		t.Fatalf("global note under sentinel scope: %+v err=%v", got, err)
	}
	// 项目作用域同 id 不可见（键空间隔离——存量项目篇与全局库互不串扰）
	if _, err := store.Get().MultiNotes.Get("p1", n.ID); err != store.ErrNotFound {
		t.Errorf("project scope must not see global note, got %v", err)
	}
	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v2"}`); w.Code != http.StatusOK {
		t.Fatalf("global put: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got, _ := store.Get().MultiNotes.Get(store.GlobalNotesScope, n.ID); got.Content != "v2" {
		t.Errorf("global save misplaced: %+v", got)
	}
	if w := deleteNote(r, "/api/notes/"+n.ID); w.Code != http.StatusOK {
		t.Fatalf("global delete: expected 200, got %d", w.Code)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes?trash=1", nil))
	if !strings.Contains(w.Body.String(), `"title":"随手记"`) {
		t.Error("global trash view must show trashed note")
	}
	if w = postNote(r, "/api/notes/"+n.ID+"/restore", `{}`); w.Code != http.StatusOK {
		t.Fatalf("global restore: expected 200, got %d", w.Code)
	}
}

// TestNotesGlobal_LimitCode 额度：灌满 100 篇后新建 400 notes.global_limit
// （单库化后唯一额度错误码——项目档 notes.limit_reached 随项目族退役）
func TestNotesGlobal_LimitCode(t *testing.T) {
	r := setupNotesGlobalTest(t)
	for i := 0; i < store.NotesMaxGlobal; i++ {
		createGlobalNote(t, r, "", "c")
	}
	w := postNote(r, "/api/notes", `{"content":"overflow"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "notes.global_limit") {
		t.Errorf("expected 400 notes.global_limit, got %d: %s", w.Code, w.Body.String())
	}
}

// TestNotesGlobal_PutDefaultUpsertPut409 默认篇 upsert（空库占位首写落真身，
// title 随建）与 409 冲突面（「打开即可打字」契约）
func TestNotesGlobal_PutDefaultUpsertPut409(t *testing.T) {
	r := setupNotesGlobalTest(t)

	if w := putNote(r, "/api/notes/"+store.DefaultNoteID, `{"content":"# 全局首写","title":"占位改名"}`); w.Code != http.StatusOK {
		t.Fatalf("global default upsert: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, store.DefaultNoteID)
	if err != nil || got.Content != "# 全局首写" || got.Title != "占位改名" {
		t.Fatalf("global default note materialized with title: %+v err=%v", got, err)
	}
	// 篇已在：PUT default 走常规 Update（title 省略不动标题）
	if w := putNote(r, "/api/notes/"+store.DefaultNoteID, `{"content":"v2"}`); w.Code != http.StatusOK {
		t.Fatalf("second save: expected 200, got %d", w.Code)
	}
	if got, _ = store.Get().MultiNotes.Get(store.GlobalNotesScope, store.DefaultNoteID); got.Content != "v2" || got.Title != "占位改名" {
		t.Errorf("nil-title save must keep title: %+v", got)
	}

	n := createGlobalNote(t, r, "", "v1")
	staleBase := n.UpdatedAt.Format(time.RFC3339Nano)
	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v2"}`); w.Code != http.StatusOK {
		t.Fatalf("external save: expected 200, got %d", w.Code)
	}
	w := putNote(r, "/api/notes/"+n.ID, `{"content":"stale","baseUpdatedAt":`+jsonStr(staleBase)+`}`)
	if w.Code != http.StatusConflict ||
		!strings.Contains(w.Body.String(), `"code":"notes.conflict"`) ||
		!strings.Contains(w.Body.String(), `"currentContent":"v2"`) {
		t.Errorf("expected 409 notes.conflict with currentContent, got %d: %s", w.Code, w.Body.String())
	}
}
