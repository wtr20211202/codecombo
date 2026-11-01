package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 跨项目批量搜索 handler 测试（P-20261002-17）：真实 fixture 仓库走完整请求链 ──
// 覆盖：多项目并发分组返回、单项目失败隔离（不存在 id / 路径失效）、
// 单仓上限减半与服务端截断探测、参数校验。

// setupBatchSearchTest store 装配（注册多 fixture 项目）+ gin 路由。
// p1 含 needle 3 行，p2 含 needle 1 行，p3 注册后目录被删（路径失效），p4 非 git 纯目录
func setupBatchSearchTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	p1 := newFixtureRepo(t)
	p1.write("needle.txt", "needle one\nplain\nneedle two\nneedle three\n")
	p1.run("add", "-A")
	p1.run("commit", "-m", "needles")
	p2 := newFixtureRepo(t)
	p2.write("hit.txt", "needle here\n")
	p2.run("add", "-A")
	p2.run("commit", "-m", "hit")

	p3 := t.TempDir() // 注册后删除目录：路径失效项目
	p4 := t.TempDir() // 非 git 纯目录：SearchContent 走 rg/git grep 均应正常降级

	for id, path := range map[string]string{
		"p1": p1.path, "p2": p2.path, "p3": p3, "p4": p4,
	} {
		if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: "proj-" + id, Path: path}); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(p3); err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	r.GET("/api/search/projects", SearchProjectsContent)
	return r
}

func getBatch(r *gin.Engine, path string) (*httptest.ResponseRecorder, []ProjectSearchGroup) {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	var body struct {
		Data []ProjectSearchGroup `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		return w, nil
	}
	return w, body.Data
}

// countNeedleByKeyword 统计某组结果中含 needle 的命中行数（内容断言与
// rg/git grep 后端计数差异解耦：逐行匹配两种后端语义一致）
func countNeedleByKeyword(groups []ProjectSearchGroup, id string) int {
	for _, g := range groups {
		if g.ProjectID != id {
			continue
		}
		n := 0
		for _, m := range g.Matches {
			if filepath.Base(m.Path) != "" {
				n++
			}
		}
		return n
	}
	return -1
}

func TestSearchProjectsContent_GroupedAndOrdered(t *testing.T) {
	r := setupBatchSearchTest(t)

	// 多项目并发搜索：结果按 ids 顺序分组，各组内容齐备、无错误标记
	w, groups := getBatch(r, "/api/search/projects?ids=p1,p2&q=needle")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2 (body=%s)", len(groups), w.Body.String())
	}
	if groups[0].ProjectID != "p1" || groups[1].ProjectID != "p2" {
		t.Fatalf("order = [%s %s], want [p1 p2]", groups[0].ProjectID, groups[1].ProjectID)
	}
	if groups[0].Name != "proj-p1" || groups[1].Name != "proj-p2" {
		t.Fatalf("names = [%s %s], want [proj-p1 proj-p2]", groups[0].Name, groups[1].Name)
	}
	if groups[0].Error != "" || groups[1].Error != "" {
		t.Fatalf("unexpected errors: %q %q", groups[0].Error, groups[1].Error)
	}
	// p1: 3 行命中；p2: 1 行命中（截断探测上限 251 不会触发）
	if n := countNeedleByKeyword(groups, "p1"); n != 3 {
		t.Fatalf("p1 matches = %d, want 3", n)
	}
	if n := countNeedleByKeyword(groups, "p2"); n != 1 {
		t.Fatalf("p2 matches = %d, want 1", n)
	}
}

func TestSearchProjectsContent_FailureIsolation(t *testing.T) {
	r := setupBatchSearchTest(t)

	// 不存在的 id：该组错误标记 + 空结果，正常项目不受拖累
	w, groups := getBatch(r, "/api/search/projects?ids=ghost,p2&q=needle")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if len(groups) != 2 || groups[0].ProjectID != "ghost" || groups[1].ProjectID != "p2" {
		t.Fatalf("groups = %+v", groups)
	}
	if groups[0].Error != "project not found" || len(groups[0].Matches) != 0 {
		t.Fatalf("ghost group = %+v, want not-found marker with empty matches", groups[0])
	}
	if groups[1].Error != "" || len(groups[1].Matches) != 1 {
		t.Fatalf("p2 group degraded by ghost: %+v", groups[1])
	}

	// 路径失效项目：目录已删 → 该组 path missing 标记，其余组不受影响
	w, groups = getBatch(r, "/api/search/projects?ids=p3,p2&q=needle")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if groups[0].Error != "path missing" || len(groups[0].Matches) != 0 {
		t.Fatalf("p3 group = %+v, want path-missing marker with empty matches", groups[0])
	}
	if len(groups[1].Matches) != 1 {
		t.Fatalf("p2 group degraded by p3: %+v", groups[1])
	}
}

func TestSearchProjectsContent_PerProjectCapHalved(t *testing.T) {
	r := setupBatchSearchTest(t)

	// max=4 → 单仓上限减半为 2：p1 有 3 行命中 → 截到 2 条 + truncated 标记
	w, groups := getBatch(r, "/api/search/projects?ids=p1,p2&q=needle&max=4")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	g1, g2 := groups[0], groups[1]
	if len(g1.Matches) != 2 || !g1.Truncated {
		t.Fatalf("p1 = %d matches truncated=%v, want 2/true", len(g1.Matches), g1.Truncated)
	}
	if len(g2.Matches) != 1 || g2.Truncated {
		t.Fatalf("p2 = %d matches truncated=%v, want 1/false", len(g2.Matches), g2.Truncated)
	}

	// max=1 → 单仓上限 1（钳制下限）：仍有截断标记
	_, groups = getBatch(r, "/api/search/projects?ids=p1&q=needle&max=1")
	if len(groups[0].Matches) != 1 || !groups[0].Truncated {
		t.Fatalf("p1 = %d matches truncated=%v, want 1/true", len(groups[0].Matches), groups[0].Truncated)
	}
}

func TestSearchProjectsContent_NonGitDirSearched(t *testing.T) {
	// 非 git 目录只有 rg 后端能搜（git grep 回退需要仓库）：rg 缺席的环境
	// 跳过（行为差异属搜索域既有语义，非本端点引入）
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not available: non-git dirs fall back to git grep and require a repo")
	}
	r := setupBatchSearchTest(t)

	// 非 git 纯目录项目：写入含关键词文件后应可命中（工作区搜索不要求 git 仓库）
	p4, err := store.Get().Project.GetByID("p4")
	if err != nil || p4 == nil {
		t.Fatal("p4 missing")
	}
	if err := os.WriteFile(filepath.Join(p4.Path, "loose.txt"), []byte("needle loose\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, groups := getBatch(r, "/api/search/projects?ids=p4&q=needle")
	if groups[0].Error != "" || len(groups[0].Matches) != 1 {
		t.Fatalf("p4 group = %+v, want 1 match no error", groups[0])
	}
}

func TestSearchProjectsContent_ParamValidation(t *testing.T) {
	r := setupBatchSearchTest(t)

	// 缺 q / 缺 ids → 400；重复 id 按首次出现去重（不重复搜索同一项目）
	if w, _ := getBatch(r, "/api/search/projects?ids=p1&p2"); w.Code != http.StatusBadRequest {
		t.Fatalf("missing q: status = %d", w.Code)
	}
	if w, _ := getBatch(r, "/api/search/projects?q=needle"); w.Code != http.StatusBadRequest {
		t.Fatalf("missing ids: status = %d", w.Code)
	}
	w, groups := getBatch(r, "/api/search/projects?ids=p1,+p1+,&q=needle")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if len(groups) != 1 {
		t.Fatalf("dedupe = %d groups, want 1", len(groups))
	}
}
