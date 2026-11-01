package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupTimelineTest 起 gin 路由 + SC_CLAUDE_DIR 指向临时会话根（Root() 走环境
// 变量，无需污染真实 ~/.claude）；返回路由与播种根。P-20261003-122 起回放端点
// 注入轮级书签（claudecur 策展域），须引导全局 store（broadcast_mixed_test 同款）
func setupTimelineTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.GET("/api/claude/sessions/:id/timeline", GetClaudeSessionTimeline)
	r.POST("/api/claude/sessions/curation", SetClaudeSessionCuration)
	return r, root
}

// writeTimelineFixture 播种一个 lineCount 条用户消息的最小会话
func writeTimelineFixture(t *testing.T, root, encodedDir, id string, lineCount int) {
	t.Helper()
	dir := filepath.Join(root, encodedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	now := time.Now()
	for i := 0; i < lineCount; i++ {
		ts := now.Add(-time.Duration(lineCount-i) * time.Minute).UTC().Format(time.RFC3339)
		b.WriteString(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"步骤-` + strconv.Itoa(i) + `"},"timestamp":"` + ts + `","cwd":"D:\\p"}` + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestGetClaudeSessionTimeline_OK 正常回放：data.entries/total 分页字段齐全
func TestGetClaudeSessionTimeline_OK(t *testing.T) {
	r, root := setupTimelineTest(t)
	writeTimelineFixture(t, root, "D--p", "sess-ok", 3)

	req := httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-ok/timeline?limit=2&offset=1", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Entries []struct {
				Kind string `json:"kind"`
				Text string `json:"text"`
			} `json:"entries"`
			Total     int  `json:"total"`
			Truncated bool `json:"truncated"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Total != 3 || len(body.Data.Entries) != 2 {
		t.Fatalf("total=%d entries=%d", body.Data.Total, len(body.Data.Entries))
	}
	if body.Data.Entries[0].Kind != "user" || body.Data.Entries[0].Text != "步骤-1" {
		t.Errorf("offset page entry = %+v, want 步骤-1", body.Data.Entries[0])
	}
}

// TestGetClaudeSessionTimeline_NotFound 不存在/越权 id：404 且不区分暴露文件系统布局
func TestGetClaudeSessionTimeline_NotFound(t *testing.T) {
	r, _ := setupTimelineTest(t)
	for _, id := range []string{"missing", "a.b", "..%5Cevil"} {
		req := httptest.NewRequest(http.MethodGet, "/api/claude/sessions/"+id+"/timeline", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("id %q: status = %d, want 404", id, w.Code)
		}
	}
}

// TestGetClaudeSessionTimeline_LimitClamp 越界 limit 夹紧（防单请求拖爆解析）
func TestGetClaudeSessionTimeline_LimitClamp(t *testing.T) {
	r, root := setupTimelineTest(t)
	writeTimelineFixture(t, root, "D--p", "sess-clamp", 5)

	req := httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-clamp/timeline?limit=99999", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body struct {
		Data struct {
			Entries []json.RawMessage `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Data.Entries) != 5 {
		t.Fatalf("entries = %d, want all 5 (clamped to available)", len(body.Data.Entries))
	}
}

// TestClaudeTimelineBookmarks 轮级书签随回放响应（P-20261003-122）：curation
// bookmarkAdd 落策展 → timeline 响应携书签；bookmarkRemove 后消失；乱序/重复
// add 服务端归一（升序去重）；非法时刻 400；无书签会话不带字段
func TestClaudeTimelineBookmarks(t *testing.T) {
	r, root := setupTimelineTest(t)
	writeTimelineFixture(t, root, "D--p", "sess-bm", 3)
	post := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/curation", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		var res struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &res)
		return w.Code, res.Data
	}
	getBookmarks := func() []string {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-bm/timeline", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("timeline status = %d: %s", w.Code, w.Body.String())
		}
		var body struct {
			Data struct {
				Bookmarks []string `json:"bookmarks"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Data.Bookmarks
	}

	// 无书签：字段缺省（omitempty，旧前端零感知）
	if bm := getBookmarks(); len(bm) != 0 {
		t.Fatalf("fresh session must carry no bookmarks: %v", bm)
	}

	// add 乱序落笔（先晚后早）→ 服务端归一为升序去重集，响应回传权威形态
	if code, data := post(`{"sessionId":"sess-bm","bookmarkAdd":"2026-01-01T00:02:00Z"}`); code != 200 || len(data["bookmarks"].([]any)) != 1 {
		t.Fatalf("add first: code=%d data=%v", code, data)
	}
	code, data := post(`{"sessionId":"sess-bm","bookmarkAdd":"2026-01-01T00:01:00Z"}`)
	if code != 200 {
		t.Fatalf("add second status = %d", code)
	}
	bm, _ := data["bookmarks"].([]any)
	if len(bm) != 2 || bm[0] != "2026-01-01T00:01:00Z" || bm[1] != "2026-01-01T00:02:00Z" {
		t.Fatalf("bookmarks normalized: %v", data)
	}
	if got := getBookmarks(); len(got) != 2 || got[0] != "2026-01-01T00:01:00Z" {
		t.Fatalf("timeline carries bookmarks: %v", got)
	}

	// 部分更新语义：只带 bookmarkRemove 不动其他（本例无其他字段，条目随
	// 最后一个书签移除而整体删除——清空语义）
	if code, data := post(`{"sessionId":"sess-bm","bookmarkRemove":"2026-01-01T00:01:00Z"}`); code != 200 {
		t.Fatalf("remove status = %d data=%v", code, data)
	}
	if got := getBookmarks(); len(got) != 1 || got[0] != "2026-01-01T00:02:00Z" {
		t.Fatalf("after remove: %v", got)
	}

	// 非法时刻：400 拒绝（不写入策展文档）
	if code, _ := post(`{"sessionId":"sess-bm","bookmarkAdd":"not-a-time"}`); code != http.StatusBadRequest {
		t.Fatalf("invalid ts must 400, got %d", code)
	}
	// 带时区偏移的 RFC3339 同属合法形态（timeline At 原串透传，格式不做归一）
	if code, _ := post(`{"sessionId":"sess-bm","bookmarkAdd":"2026-01-01T00:00:00+08:00"}`); code != 200 {
		t.Fatalf("offset-form RFC3339 must pass, got %d", code)
	}

	// 全清空：逐个移除至空 → 条目删除；再移除幂等 200（契约含「无残留可清」
	// 形态，报错会让清理方拿到 500 假失败）
	for _, ts := range []string{"2026-01-01T00:02:00Z", "2026-01-01T00:00:00+08:00"} {
		if code, _ := post(`{"sessionId":"sess-bm","bookmarkRemove":"` + ts + `"}`); code != 200 {
			t.Fatalf("remove %s status = %d", ts, code)
		}
	}
	if code, _ := post(`{"sessionId":"sess-bm","bookmarkRemove":"2026-01-01T00:02:00Z"}`); code != 200 {
		t.Fatalf("idempotent remove must 200, got %d", code)
	}
	if got := getBookmarks(); len(got) != 0 {
		t.Fatalf("after full clear: %v", got)
	}
}

// TestClaudeTimelineTags 轮级语义标签随回放响应（P-20261003-256）：curation
// tagAdd 落策展 → timeline 响应携标签；(At,Tag) 归一（去重/排序）；非法时刻与
// 空标签/超长标签 400；#前缀 hashtag 输入归一为同名（与既有标签同键）；部分
// 更新语义（只带 tagAdd 不动书签）；标签与书签双清后条目删除
func TestClaudeTimelineTags(t *testing.T) {
	r, root := setupTimelineTest(t)
	writeTimelineFixture(t, root, "D--p", "sess-tag", 3)
	post := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/curation", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		var res struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &res)
		return w.Code, res.Data
	}
	getTags := func() []map[string]any {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-tag/timeline", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("timeline status = %d: %s", w.Code, w.Body.String())
		}
		var body struct {
			Data struct {
				Tags []map[string]any `json:"tags"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Data.Tags
	}
	tagStr := func(p map[string]any) string {
		return p["at"].(string) + "|" + p["tag"].(string)
	}

	// 无标签：字段缺省（omitempty，旧前端零感知）
	if tags := getTags(); len(tags) != 0 {
		t.Fatalf("fresh session must carry no tags: %v", tags)
	}

	// add 两对（乱序）+ 同对重复 add 幂等 → 响应回传权威去重形态
	if code, data := post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:02:00Z","tag":"修复"}}`); code != 200 || len(data["tags"].([]any)) != 1 {
		t.Fatalf("add first: code=%d data=%v", code, data)
	}
	code, data := post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"架构"}}`)
	if code != 200 {
		t.Fatalf("add second status = %d", code)
	}
	tags, _ := data["tags"].([]any)
	if len(tags) != 2 || tagStr(tags[0].(map[string]any)) != "2026-01-01T00:01:00Z|架构" {
		t.Fatalf("tags normalized: %v", data)
	}
	if code, data := post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"架构"}}`); code != 200 || len(data["tags"].([]any)) != 2 {
		t.Fatalf("idempotent add: code=%d data=%v", code, data)
	}
	if got := getTags(); len(got) != 2 || tagStr(got[0]) != "2026-01-01T00:01:00Z|架构" {
		t.Fatalf("timeline carries tags: %v", got)
	}

	// hashtag 输入归一：#架构 与既有「架构」同键（add 幂等、remove 命中）
	if code, data := post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"#架构"}}`); code != 200 || len(data["tags"].([]any)) != 2 {
		t.Fatalf("hashtag-normalized add: code=%d data=%v", code, data)
	}
	if code, data := post(`{"sessionId":"sess-tag","tagRemove":{"at":"2026-01-01T00:01:00Z","tag":"#架构"}}`); code != 200 || len(data["tags"].([]any)) != 1 {
		t.Fatalf("hashtag-normalized remove: code=%d data=%v", code, data)
	}

	// 部分更新语义：只带 tagAdd 不动书签（书签先落，标签后加，书签仍在）
	if code, _ := post(`{"sessionId":"sess-tag","bookmarkAdd":"2026-01-01T00:03:00Z"}`); code != 200 {
		t.Fatalf("bookmark add status = %d", code)
	}
	code, data = post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:03:00Z","tag":"发布"}}`)
	if code != 200 {
		t.Fatalf("tag add with bookmark status = %d", code)
	}
	if bms, _ := data["bookmarks"].([]any); len(bms) != 1 {
		t.Fatalf("tagAdd must not touch bookmarks: %v", data)
	}

	// 非法形态：坏时刻 / 空标签 / 纯 # 标签 / 超 32 rune 标签一律 400 不写入
	for _, body := range []string{
		`{"sessionId":"sess-tag","tagAdd":{"at":"not-a-time","tag":"x"}}`,
		`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"  "}}`,
		`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"###"}}`,
		`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:01:00Z","tag":"` + strings.Repeat("长", 33) + `"}}`,
	} {
		if code, _ := post(body); code != http.StatusBadRequest {
			t.Fatalf("invalid tag must 400, got %d body=%s", code, body)
		}
	}
	// 32 rune 边界内合法（含时区偏移 RFC3339 同书签口径）
	if code, _ := post(`{"sessionId":"sess-tag","tagAdd":{"at":"2026-01-01T00:00:00+08:00","tag":"` + strings.Repeat("标", 32) + `"}}`); code != 200 {
		t.Fatalf("32-rune tag with offset ts must pass, got %d", code)
	}

	// 全清空：标签与书签逐个移除至空 → 条目删除；再移除幂等 200
	for _, body := range []string{
		`{"sessionId":"sess-tag","tagRemove":{"at":"2026-01-01T00:02:00Z","tag":"修复"}}`,
		`{"sessionId":"sess-tag","tagRemove":{"at":"2026-01-01T00:03:00Z","tag":"发布"}}`,
		`{"sessionId":"sess-tag","tagRemove":{"at":"2026-01-01T00:00:00+08:00","tag":"` + strings.Repeat("标", 32) + `"}}`,
		`{"sessionId":"sess-tag","bookmarkRemove":"2026-01-01T00:03:00Z"}`,
	} {
		if code, _ := post(body); code != 200 {
			t.Fatalf("clear step status = %d body=%s", code, body)
		}
	}
	if code, _ := post(`{"sessionId":"sess-tag","tagRemove":{"at":"2026-01-01T00:02:00Z","tag":"修复"}}`); code != 200 {
		t.Fatalf("idempotent remove must 200, got %d", code)
	}
	if got := getTags(); len(got) != 0 {
		t.Fatalf("after full clear: %v", got)
	}
}
