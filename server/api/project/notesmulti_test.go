package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
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
	return putNoteOrigin(r, path, body, "")
}

// putNoteOrigin PUT 附带本窗 nonce 头（回声抑制链路用例；origin 空串 = 不携头）
func putNoteOrigin(r *gin.Engine, path, body, origin string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set(notesOriginHeader, origin)
	}
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

	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v2","tags":["proj-a"]}`); w.Code != http.StatusOK {
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
	// currentTags 随件（P-20261112-7 S2 冲突裁决链：载入服务端版本放弃本地标签
	// 编辑后编辑面回落服务端真值——409 快照三字段自洽）
	if !strings.Contains(w.Body.String(), `"currentTags":["proj-a"]`) {
		t.Errorf("conflict payload missing currentTags: %s", w.Body.String())
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

// TestNotesMulti_OriginEchoRoundTrip 回声抑制 nonce 链路（P-20261111-4 S1）：
// 写请求 X-Notes-Origin 头经广播 payload.origin 原样回带（前端 onExternalUpdate
// 收到同 nonce 跳过——本窗防抖自动保存的回声不触发整篇重读）；无头请求（agent
// /curl 直调、旧客户端）广播不带 origin 字段（JSON omitempty——前端按外部更新
// 处理向后兼容）；超长头 rune 边界截断（载荷尺寸有界，最坏退化为一次多余重拉）
func TestNotesMulti_OriginEchoRoundTrip(t *testing.T) {
	r := setupNotesGlobalTest(t)
	n := createGlobalNote(t, r, "", "v1")

	var mu sync.Mutex
	var got []notesActionPayload
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type != opschannel.EventNotesUpdated {
			return
		}
		if p, ok := ev.Payload.(notesActionPayload); ok {
			mu.Lock()
			got = append(got, p)
			mu.Unlock()
		}
	})
	t.Cleanup(unsub)

	// 带本窗 nonce 的保存：origin 原样回带（作用域键/篇 id/动作随行）
	if w := putNoteOrigin(r, "/api/notes/"+n.ID, `{"content":"v2"}`, "win-a"); w.Code != http.StatusOK {
		t.Fatalf("put with origin: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	mu.Lock()
	if len(got) != 1 || got[0].Origin != "win-a" || got[0].Action != "saved" ||
		got[0].NoteID != n.ID || got[0].ProjectID != store.GlobalNotesScope {
		t.Fatalf("broadcast payload with origin: %+v", got)
	}
	got = got[:0]
	mu.Unlock()

	// 无 nonce 头：广播不带 origin 字段（旧客户端按外部更新处理——宁多刷不漏刷）
	if w := putNote(r, "/api/notes/"+n.ID, `{"content":"v3"}`); w.Code != http.StatusOK {
		t.Fatalf("put without origin: expected 200, got %d", w.Code)
	}
	mu.Lock()
	if len(got) != 1 || got[0].Origin != "" {
		t.Fatalf("broadcast payload without origin: %+v", got)
	}
	if b, err := json.Marshal(got[0]); err != nil || strings.Contains(string(b), `"origin"`) {
		t.Errorf("absent origin must be omitted in payload JSON: %s err=%v", b, err)
	}
	got = got[:0]
	mu.Unlock()

	// 超长 nonce：rune 边界截断到护栏上限
	long := strings.Repeat("窗", notesOriginMaxLen+10)
	if w := putNoteOrigin(r, "/api/notes/"+n.ID, `{"content":"v4"}`, long); w.Code != http.StatusOK {
		t.Fatalf("put with long origin: expected 200, got %d", w.Code)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0].Origin != strings.Repeat("窗", notesOriginMaxLen) {
		t.Fatalf("long origin not truncated to %d runes: got %d runes (%q)",
			notesOriginMaxLen, len([]rune(got[0].Origin)), got[0].Origin)
	}
}

// TestNotesMulti_TagsPutSemantics 标签 PUT 三态（P-20261112-7 S1）：携带即整体
// 替换（标签行是全量编辑面）/显式 [] 清空/省略不动标签——nil=不改动使旧前端/
// 纯改名 PUT 不清空他窗标签；创建携 tags → 201 响应即携
func TestNotesMulti_TagsPutSemantics(t *testing.T) {
	r := setupNotesGlobalTest(t)

	w := postNote(r, "/api/notes", `{"title":"标签篇","content":"c","tags":[" 生涯 ","生涯","项目A"]}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create with tags: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var created struct {
		Data store.MultiNote `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("create body: %v", err)
	}
	if len(created.Data.Tags) != 2 || created.Data.Tags[0] != "生涯" || created.Data.Tags[1] != "项目A" {
		t.Errorf("create should return normalized tags, got %v", created.Data.Tags)
	}
	id := created.Data.ID

	// 携带即整体替换（含归一化）
	if w = putNote(r, "/api/notes/"+id, `{"content":"c2","tags":["新标签","另一枚"]}`); w.Code != http.StatusOK {
		t.Fatalf("put with tags: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got, err := store.Get().MultiNotes.Get(store.GlobalNotesScope, id)
	if err != nil || len(got.Tags) != 2 || got.Tags[0] != "新标签" {
		t.Fatalf("tags whole-replace: %+v err=%v", got, err)
	}

	// 省略 tags（旧前端/纯改名 PUT 形态）→ 不动标签
	if w = putNote(r, "/api/notes/"+id, `{"content":"c3","title":"改名不改标签"}`); w.Code != http.StatusOK {
		t.Fatalf("put without tags: expected 200, got %d", w.Code)
	}
	if got, _ = store.Get().MultiNotes.Get(store.GlobalNotesScope, id); got.Title != "改名不改标签" || len(got.Tags) != 2 {
		t.Errorf("PUT without tags must keep tags: %+v", got)
	}

	// 显式 [] → 清空（空串/空白项同样归一为清空）
	if w = putNote(r, "/api/notes/"+id, `{"content":"c4","tags":[]}`); w.Code != http.StatusOK {
		t.Fatalf("put empty tags: expected 200, got %d", w.Code)
	}
	if got, _ = store.Get().MultiNotes.Get(store.GlobalNotesScope, id); got.Tags != nil {
		t.Errorf("explicit [] must clear tags, got %v", got.Tags)
	}

	// 默认篇 upsert 携 tags：首写落真身即带标签（「打开即可打字」契约的标签面）
	if w = putNote(r, "/api/notes/"+store.DefaultNoteID, `{"content":"首写","tags":["项目A"]}`); w.Code != http.StatusOK {
		t.Fatalf("default upsert with tags: expected 200, got %d", w.Code)
	}
	if got, _ = store.Get().MultiNotes.Get(store.GlobalNotesScope, store.DefaultNoteID); len(got.Tags) != 1 || got.Tags[0] != "项目A" {
		t.Errorf("default upsert should carry tags, got %v", got.Tags)
	}
}

// TestNotesMulti_TagsListFilter 清单按标签内存过滤（?tag= 精确匹配）：
// 在册视图过滤、与 ?trash=1 可叠加（回收站清单同样按标签过滤）、无标签篇省
// tags 字段（清单面轻量）
func TestNotesMulti_TagsListFilter(t *testing.T) {
	r := setupNotesGlobalTest(t)

	tagged := createTaggedNote(t, r, "带标签", "c", "项目A")
	other := createTaggedNote(t, r, "别标签", "c", "项目B")
	createGlobalNote(t, r, "无标签", "c")

	getJSON := func(path string) []map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: expected 200, got %d: %s", path, w.Code, w.Body.String())
		}
		var body struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("list body: %v", err)
		}
		return body.Data
	}

	// ?tag= 只留命中篇（精确匹配）
	names := titlesOf(getJSON("/api/notes?tag=" + urlQueryEscape("项目A")))
	if len(names) != 1 || names[0] != "带标签" {
		t.Errorf("tag filter should keep only matched note, got %v", names)
	}
	// 无标签篇在无过滤清单里不携 tags 字段（omitempty 轻量）
	for _, m := range getJSON("/api/notes") {
		if m["title"] == "无标签" {
			if _, has := m["tags"]; has {
				t.Errorf("untagged note meta must omit tags field: %v", m)
			}
		}
	}

	// 回收站视图叠加 ?tag=：软删篇同样按标签过滤
	if w := deleteNote(r, "/api/notes/"+tagged.ID); w.Code != http.StatusOK {
		t.Fatalf("trash tagged note: expected 200, got %d", w.Code)
	}
	if w := deleteNote(r, "/api/notes/"+other.ID); w.Code != http.StatusOK {
		t.Fatalf("trash other note: expected 200, got %d", w.Code)
	}
	trashNames := titlesOf(getJSON("/api/notes?trash=1&tag=" + urlQueryEscape("项目A")))
	if len(trashNames) != 1 || trashNames[0] != "带标签" {
		t.Errorf("trash view + tag filter must combine, got %v", trashNames)
	}
	allTrash := titlesOf(getJSON("/api/notes?trash=1"))
	if len(allTrash) != 2 {
		t.Errorf("trash view without tag shows both, got %v", allTrash)
	}
}

// createTaggedNote 测试辅助：带单标签新建一篇
func createTaggedNote(t *testing.T, r *gin.Engine, title, content, tag string) store.MultiNote {
	t.Helper()
	w := postNote(r, "/api/notes", `{"title":`+jsonStr(title)+`,"content":`+jsonStr(content)+`,"tags":[`+jsonStr(tag)+`]}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create tagged note: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data store.MultiNote `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("create tagged note body: %v", err)
	}
	return body.Data
}

// titlesOf 清单条目取 title 列表
func titlesOf(items []map[string]any) []string {
	out := make([]string, 0, len(items))
	for _, m := range items {
		if s, ok := m["title"].(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// urlQueryEscape 测试辅助：查询参数转义
func urlQueryEscape(s string) string { return url.QueryEscape(s) }
