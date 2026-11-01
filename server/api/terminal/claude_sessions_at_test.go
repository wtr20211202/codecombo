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

	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupSessionsAtTest 起 gin 路由 + fresh store + SC_CLAUDE_DIR 指向临时会话根
func setupSessionsAtTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/projects/:id/sessions-at", GetClaudeSessionsAt)
	return r, root
}

// seedSessionsAtFixture 在编码目录下播种一个会话 transcript：首末用户行时间戳
// 覆盖 [base-1h, base+1h]，返回其 id
func seedSessionsAtFixture(t *testing.T, root, encodedDir, id string, base time.Time) {
	t.Helper()
	dir := filepath.Join(root, encodedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	steps := []time.Duration{-time.Hour, -time.Minute, time.Minute, time.Hour}
	for _, d := range steps {
		ts := base.Add(d).UTC().Format(time.RFC3339)
		b.WriteString(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"溯源-` + id + `"},"timestamp":"` + ts + `","cwd":"x"} ` + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestGetClaudeSessionsAt 参数校验与项目归属：坏 ts 400 / 项目缺失 404 /
// 命中窗口 200 且只含本项目会话（Cwd=存储目录归属）/ 窗口外零命中
func TestGetClaudeSessionsAt(t *testing.T) {
	r, root := setupSessionsAtTest(t)
	base := time.Now()
	projDir := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-at", Name: "AT", Path: projDir}); err != nil {
		t.Fatal(err)
	}
	otherDir := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-other", Name: "Other", Path: otherDir}); err != nil {
		t.Fatal(err)
	}
	seedSessionsAtFixture(t, root, claudesessions.EncodePath(projDir), "sess-in", base)
	seedSessionsAtFixture(t, root, claudesessions.EncodePath(otherDir), "sess-other", base)

	// 坏 ts：400（RFC3339 显式要求）
	req := httptest.NewRequest(http.MethodGet, "/api/projects/p-at/sessions-at?ts=not-a-time", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad ts: status = %d, want 400", w.Code)
	}

	// 项目缺失：404
	req = httptest.NewRequest(http.MethodGet, "/api/projects/nope/sessions-at?ts="+base.UTC().Format(time.RFC3339), nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing project: status = %d, want 404", w.Code)
	}

	// 窗口内：只命中本项目的会话（其他项目的同窗会话不串项目）
	req = httptest.NewRequest(http.MethodGet, "/api/projects/p-at/sessions-at?ts="+base.UTC().Format(time.RFC3339), nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("in-window: status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Sessions []struct {
				ID     string `json:"id"`
				Title  string `json:"title"`
				Active bool   `json:"active"`
			} `json:"sessions"`
			Total     int  `json:"total"`
			Truncated bool `json:"truncated"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Total != 1 || len(body.Data.Sessions) != 1 || body.Data.Sessions[0].ID != "sess-in" {
		t.Fatalf("expect only sess-in, got total=%d sessions=%v", body.Data.Total, body.Data.Sessions)
	}
	if body.Data.Sessions[0].Title == "" {
		t.Fatal("session row should carry title (回放直达与溯源区展示依赖)")
	}

	// 窗口外（早于 FirstAt 2 小时）：零命中空态（诚实缺失）
	early := base.Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	req = httptest.NewRequest(http.MethodGet, "/api/projects/p-at/sessions-at?ts="+early, nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("out-window: status = %d", w.Code)
	}
	var empty struct {
		Data struct {
			Total    int        `json:"total"`
			Sessions []struct{} `json:"sessions"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &empty); err != nil {
		t.Fatal(err)
	}
	if empty.Data.Total != 0 || len(empty.Data.Sessions) != 0 {
		t.Fatalf("expect zero hit outside window, got total=%d", empty.Data.Total)
	}
}
