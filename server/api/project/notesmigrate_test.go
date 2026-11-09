package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/store"
)

// ── 笔记单库化迁移编排测试（P-20261108-3）：滞留计数只读端点 / 手动续迁端点 /
// 满额中止如实回告 / 审计一条汇总（不逐篇）/ 项目删除入口补回项目名前缀。仓储
// 层迁移矩阵（幂等、降级窗口、标题上限、旧单篇键两段链）见 store/notesmigrate_test.go ──

type migrationBody struct {
	Data struct {
		Pending  int  `json:"pending"`
		Migrated int  `json:"migrated"`
		Full     bool `json:"full"`
	} `json:"data"`
}

func getMigration(t *testing.T, r interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}) migrationBody {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/notes/migration", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET migration: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var b migrationBody
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatalf("GET migration body: %v", err)
	}
	return b
}

// countMigratedAudits 审计里 notes.migrated 条数
func countMigratedAudits(t *testing.T) int {
	t.Helper()
	events, _, err := store.Get().Audit.List(500, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	n := 0
	for _, e := range events {
		if e.Action == store.AuditNotesMigrated {
			n++
		}
	}
	return n
}

// TestNotesMigration_StatusThenResume 老项目笔记（项目作用域存量）→ GET 只读
// 计数如实 → POST 续迁并入全局库（「[项目名] 」前缀、内容不丢）→ 计数归零；
// 审计恰一条汇总；只读端点零写盘（GET 后源键仍在）
func TestNotesMigration_StatusThenResume(t *testing.T) {
	r := setupNotesGlobalTest(t) // 项目 p1 名 "t"
	if _, err := store.Get().MultiNotes.Create("p1", "交接说明", "# 老项目笔记\n\n- 待办 A"); err != nil {
		t.Fatalf("seed project note: %v", err)
	}
	if _, err := store.Get().MultiNotes.UpsertDefault("p1", "默认篇正文", nil); err != nil {
		t.Fatalf("seed default note: %v", err)
	}

	st := getMigration(t, r)
	if st.Data.Pending != 2 || st.Data.Full {
		t.Fatalf("status = %+v, want pending=2 full=false", st.Data)
	}
	if left, _ := store.Get().MultiNotes.List("p1"); len(left) != 2 {
		t.Fatalf("GET must be read-only, project notes left = %d", len(left))
	}

	w := postNote(r, "/api/notes/migration", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("POST migration: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var res migrationBody
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Data.Migrated != 2 || res.Data.Pending != 0 || res.Data.Full {
		t.Fatalf("resume = %+v, want migrated=2 pending=0", res.Data)
	}

	list := httptest.NewRecorder()
	r.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/notes", nil))
	if !strings.Contains(list.Body.String(), `"title":"[t] 交接说明"`) || !strings.Contains(list.Body.String(), `"title":"[t]"`) {
		t.Fatalf("migrated notes should carry [project] prefix: %s", list.Body.String())
	}
	var found bool
	notes, _ := store.Get().MultiNotes.List(store.GlobalNotesScope)
	for _, n := range notes {
		if n.Title == "[t] 交接说明" && n.Content == "# 老项目笔记\n\n- 待办 A" {
			found = true
		}
	}
	if !found {
		t.Error("migrated content must be preserved verbatim")
	}
	if st := getMigration(t, r); st.Data.Pending != 0 {
		t.Errorf("pending after resume = %d, want 0", st.Data.Pending)
	}
	if n := countMigratedAudits(t); n != 1 {
		t.Errorf("expected exactly one notes.migrated audit summary, got %d", n)
	}
	// 再调一次：幂等零迁入、不再入账审计
	postNote(r, "/api/notes/migration", `{}`)
	if n := countMigratedAudits(t); n != 1 {
		t.Errorf("idempotent resume must not add audit entries, got %d", n)
	}
}

// TestNotesMigration_FullReportsPending 全局库满额：GET full=true；POST 零迁入、
// 滞留如实回告，源原样保留（零丢弃）
func TestNotesMigration_FullReportsPending(t *testing.T) {
	r := setupNotesGlobalTest(t)
	for i := 0; i < store.NotesMaxGlobal; i++ {
		if _, err := store.Get().MultiNotes.Create(store.GlobalNotesScope, "", "filler"); err != nil {
			t.Fatalf("fill #%d: %v", i, err)
		}
	}
	src, _ := store.Get().MultiNotes.Create("p1", "满额滞留", "keep me")

	if st := getMigration(t, r); st.Data.Pending != 1 || !st.Data.Full {
		t.Fatalf("status = %+v, want pending=1 full=true", st.Data)
	}
	res := MigrateNotesOnStartup()
	if res.Migrated != 0 || res.Pending != 1 || !res.Full {
		t.Fatalf("startup result = %+v, want migrated=0 pending=1 full=true", res)
	}
	if got, err := store.Get().MultiNotes.Get("p1", src.ID); err != nil || got.Content != "keep me" {
		t.Fatalf("source must stay intact when full: %+v err=%v", got, err)
	}
	if n := countMigratedAudits(t); n != 0 {
		t.Errorf("zero-progress round must not audit, got %d", n)
	}
}

// TestNotesMigration_ProjectDeleteEntry 项目删除入口：项目记录已摘除时经 extra
// 补回项目名，残留篇带前缀并入（笔记不随项目删除）
func TestNotesMigration_ProjectDeleteEntry(t *testing.T) {
	setupNotesGlobalTest(t)
	if _, err := store.Get().MultiNotes.Create("p-gone", "遗留交接", "orphan body"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// p-gone 不在项目表（模拟 DeleteProject 已先摘除记录）
	migrateNotesOnProjectDelete(nil, &config.ProjectConfig{ID: "p-gone", Name: "已删项目"})
	notes, _ := store.Get().MultiNotes.List(store.GlobalNotesScope)
	if len(notes) != 1 || notes[0].Title != "[已删项目] 遗留交接" || notes[0].Content != "orphan body" {
		t.Fatalf("project-delete entry should migrate with restored name prefix: %+v", notes)
	}
	if left, _ := store.Get().MultiNotes.List("p-gone"); len(left) != 0 {
		t.Errorf("source should be cleaned, left %d", len(left))
	}
}

// TestProjectLabel 展示名回落：名空取根目录基名（标准库，三平台同语义）
func TestProjectLabel(t *testing.T) {
	if got := projectLabel("  alpha ", "/x/y"); got != "alpha" {
		t.Errorf("projectLabel name = %q", got)
	}
	if got := projectLabel("", "repo-root"); got != "repo-root" {
		t.Errorf("projectLabel basename = %q", got)
	}
	if got := projectLabel("", ""); got != "" {
		t.Errorf("projectLabel empty = %q", got)
	}
}
