package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 提交历史类端点的空仓库语义（P-20261003-300）──
// git init 后零提交的未出生分支：GET /log 等 git log 查询曾裸传 fatal 128 →
// 500，前端提交面板首开即红色报错。语义修正：命中 IsNoCommitsError 时 200 +
// 空列表 + emptyRepo 标志（前端据此渲染引导空态），其余错误照常 500。

// newEmptyRepoFixture git init 后零提交的最小仓库（复用同包 fixtureRepo）
func newEmptyRepoFixture(t *testing.T) *fixtureRepo {
	t.Helper()
	path := t.TempDir()
	f := &fixtureRepo{t: t, path: path}
	f.run("init", "-b", "main")
	f.run("config", "user.email", "t@t")
	f.run("config", "user.name", "t")
	f.run("config", "core.autocrlf", "false")
	return f
}

// setupLogTest store 装配（注册 fixture 项目）+ gin 路由（log 查询族）
func setupLogTest(t *testing.T, f *fixtureRepo) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: f.path}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	api := r.Group("/api/projects/:id")
	{
		api.GET("/log", GetLog)
		api.GET("/log/search", SearchLog)
		api.GET("/log/file", GetFileLog)
		api.GET("/log/directory", GetDirectoryLog)
	}
	return r
}

func get(r *gin.Engine, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v: %s", err, w.Body.String())
	}
	return body
}

// 空仓库四个 log 查询端点：200 + 空列表 + emptyRepo 标志（SearchLog 走 --all
// 在空仓天然成功返回空、不报错，无标志属预期）
func TestLogEndpointsEmptyRepo(t *testing.T) {
	f := newEmptyRepoFixture(t)
	r := setupLogTest(t, f)

	cases := []struct{ name, path string }{
		{"log", "/api/projects/p1/log"},
		{"log?branch=main", "/api/projects/p1/log?branch=main"}, // 显式 ref：ambiguous argument + rev-parse 确认路径
		{"log/file", "/api/projects/p1/log/file?file=a.txt"},
		{"log/directory", "/api/projects/p1/log/directory?path=."},
		{"log/search", "/api/projects/p1/log/search?query=x"},
	}
	for _, tc := range cases {
		w := get(r, tc.path)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body=%s", tc.name, w.Code, w.Body.String())
		}
		body := decodeBody(t, w)
		data, _ := body["data"].([]any)
		if len(data) != 0 {
			t.Fatalf("%s: expected empty data, got %v", tc.name, body["data"])
		}
		if tc.name != "log/search" && body["emptyRepo"] != true {
			t.Fatalf("%s: expected emptyRepo=true, got %v", tc.name, body["emptyRepo"])
		}
	}
}

// 非空仓库正常路径不受影响：200 + 有数据 + 无 emptyRepo 字段（增量兼容）
func TestLogEndpointsNonEmptyRepoNoFlag(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupLogTest(t, f)

	w := get(r, "/api/projects/p1/log")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	body := decodeBody(t, w)
	data, _ := body["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("expected 2 commits, got %v", body["data"])
	}
	if _, has := body["emptyRepo"]; has {
		t.Fatalf("non-empty repo must not carry emptyRepo field: %s", w.Body.String())
	}
}

// 非空仓库传错 ref：ambiguous argument 不误判为空仓（rev-parse 确认 HEAD 存在），仍 500
func TestLogBadRefNonEmptyRepoStillErrors(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupLogTest(t, f)

	w := get(r, "/api/projects/p1/log?branch=no-such-branch")
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("bad ref in non-empty repo should stay 500, got %d: %s", w.Code, w.Body.String())
	}
}
