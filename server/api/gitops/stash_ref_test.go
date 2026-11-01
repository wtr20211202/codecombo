package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// stash hash 稳定引用（P-20261003-264）handler 面：真实 fixture 仓库走完整
// 请求链——列表下发 hash / hash 寻址 diff 与 drop / drop 后旧 hash 明确 409
// 拒绝且不误动相邻条目 / index 入口渐进保留。git 层解析细节在
// server/git/stash_ref_test.go

type stashTestItem struct {
	Index   int    `json:"index"`
	Message string `json:"message"`
	Hash    string `json:"hash"`
}

func setupStashRefTest(t *testing.T, f *fixtureRepo) *gin.Engine {
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
	api.GET("/stashes", ListStashes)
	api.GET("/stashes/:index/diff", StashDiff)
	api.POST("/stash/pop", StashPop)
	api.POST("/stash/apply", StashApply)
	api.POST("/stash/branch", StashBranch)
	api.DELETE("/stash/:index", DeleteStash)
	return r
}

// doJSON 发任意方法请求（delete 无 body 亦走此形态）
func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func listStashItems(t *testing.T, r *gin.Engine) []stashTestItem {
	t.Helper()
	w := doJSON(r, http.MethodGet, "/api/projects/p1/stashes", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list stashes: status = %d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data []stashTestItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal list: %v (%s)", err, w.Body.String())
	}
	return body.Data
}

func mustStash(t *testing.T, f *fixtureRepo, content, message string) {
	t.Helper()
	f.write("a.txt", content)
	f.run("stash", "push", "-m", message)
}

func TestStashHashRef_AddressingAndStaleReject(t *testing.T) {
	f := newFixtureRepo(t)
	// 两条 stash：alpha 先入栈（旧，index 1），beta 后入栈（新，index 0）
	mustStash(t, f, "alpha\n", "alpha")
	mustStash(t, f, "beta\n", "beta")

	r := setupStashRefTest(t, f)
	items := listStashItems(t, r)
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].Index != 0 || items[0].Message != "beta" || items[1].Index != 1 || items[1].Message != "alpha" {
		t.Fatalf("list order/messages = %+v, want beta@0 alpha@1", items)
	}
	alphaHash, betaHash := items[1].Hash, items[0].Hash
	if len(alphaHash) < 40 || len(betaHash) < 40 || alphaHash == betaHash {
		t.Fatalf("hashes = %q/%q, want distinct full OIDs", alphaHash, betaHash)
	}

	// hash 寻址 diff：alpha 的 hash 只看到 alpha 内容（index 1 同样可读，两条通道并存）
	w := doJSON(r, http.MethodGet, "/api/projects/p1/stashes/"+alphaHash+"/diff", "")
	if w.Code != http.StatusOK {
		t.Fatalf("diff by hash: status = %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "alpha") || strings.Contains(w.Body.String(), "beta") {
		t.Fatalf("diff by hash addressed wrong entry: %s", w.Body.String())
	}

	// hash 寻址 drop：删 beta 后 alpha 栈位从 1 前移到 0，旧 alpha hash 仍命中 alpha
	if w := doJSON(r, http.MethodDelete, "/api/projects/p1/stash/"+betaHash, ""); w.Code != http.StatusOK {
		t.Fatalf("drop by hash: status = %d body=%s", w.Code, w.Body.String())
	}
	items = listStashItems(t, r)
	if len(items) != 1 || items[0].Index != 0 || items[0].Message != "alpha" {
		t.Fatalf("after drop by hash: %+v, want alpha@0", items)
	}
	w = doJSON(r, http.MethodGet, "/api/projects/p1/stashes/"+alphaHash+"/diff", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "alpha") {
		t.Fatalf("shifted alpha hash: status = %d body=%s", w.Code, w.Body.String())
	}
	// index 入口渐进保留：DELETE /stash/0 删 alpha
	if w := doJSON(r, http.MethodDelete, "/api/projects/p1/stash/0", ""); w.Code != http.StatusOK {
		t.Fatalf("drop by index: status = %d body=%s", w.Code, w.Body.String())
	}
	if got := listStashItems(t, r); len(got) != 0 {
		t.Fatalf("stash list after index drop = %+v, want empty", got)
	}

	// 留一条哨兵条目：旧 hash 的所有操作必须 409 明确拒绝、绝不按请求体 index 误吃哨兵
	mustStash(t, f, "gamma\n", "gamma")
	if items = listStashItems(t, r); len(items) != 1 || items[0].Message != "gamma" {
		t.Fatalf("sentinel seed = %+v, want gamma only", items)
	}
	staleOps := []struct {
		method, path, body string
	}{
		{http.MethodGet, "/api/projects/p1/stashes/" + alphaHash + "/diff", ""},
		{http.MethodDelete, "/api/projects/p1/stash/" + alphaHash, ""},
		{http.MethodPost, "/api/projects/p1/stash/pop", `{"index":0,"hash":"` + alphaHash + `"}`},
		{http.MethodPost, "/api/projects/p1/stash/apply", `{"index":0,"hash":"` + alphaHash + `"}`},
		{http.MethodPost, "/api/projects/p1/stash/branch", `{"index":0,"hash":"` + alphaHash + `","name":"trial"}`},
	}
	for _, op := range staleOps {
		w := doJSON(r, op.method, op.path, op.body)
		if w.Code != http.StatusConflict {
			t.Fatalf("%s %s: status = %d, want 409 (body=%s)", op.method, op.path, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), errmarkers.StashEntryGone) {
			t.Fatalf("%s %s: body = %s, want stable marker %q", op.method, op.path, w.Body.String(), errmarkers.StashEntryGone)
		}
	}
	// 哨兵原样、工作区未被套用、分支未创建
	if got := listStashItems(t, r); len(got) != 1 || got[0].Message != "gamma" {
		t.Fatalf("sentinel disturbed by stale hash ops: %+v", got)
	}
	if got := strings.TrimSpace(f.run("status", "--porcelain")); got != "" {
		t.Fatalf("worktree = %q, want untouched", got)
	}
	if got := strings.TrimSpace(f.run("branch", "--list", "trial")); got != "" {
		t.Fatalf("trial branch created by stale hash op: %q", got)
	}
}
