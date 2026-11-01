package gitops

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── TODO 扫描 handler 测试（P-20261002-25）：真实 fixture 仓库走完整请求链 ──
// 覆盖：多文件分组、同文件多命中聚合、.gitignore 排除、整词+大小写语义
// （小写 todo / 复数 TODOS 不计入）、500 上限截断、项目不存在 404。

func setupTodosTest(t *testing.T) (*gin.Engine, *fixtureRepo) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	f := newFixtureRepo(t)
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: f.path}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/projects/:id/todos", ProjectTodos)
	return r, f
}

func getTodos(r *gin.Engine, path string) (*httptest.ResponseRecorder, []TodoFileGroup, int, bool) {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	var body struct {
		Data      []TodoFileGroup `json:"data"`
		Total     int             `json:"total"`
		Truncated bool            `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		return w, nil, 0, false
	}
	return w, body.Data, body.Total, body.Truncated
}

// itemCount 按文件路径取命中条数（分组顺序与 rg/git grep 后端输出序解耦）
func itemCount(groups []TodoFileGroup, path string) int {
	for _, g := range groups {
		if g.Path == path {
			return len(g.Items)
		}
	}
	return -1
}

func TestProjectTodos_GroupedByFile(t *testing.T) {
	r, f := setupTodosTest(t)

	// 三个文件五个标记：main.go 3（TODO×2+FIXME×1）、util.go 1（HACK）、readme.md 1（XXX）
	f.write("main.go", "package main\n\n// TODO: implement x\nfunc main() {}\n\n// FIXME: broken path\nvar _ = main\n// TODO: cleanup\n")
	f.write("util.go", "package util\n\n// HACK: temp workaround\n")
	f.write("readme.md", "# readme\n\nXXX: rewrite before release\n")

	w, groups, total, truncated := getTodos(r, "/api/projects/p1/todos")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if len(groups) != 3 || total != 5 || truncated {
		t.Fatalf("groups=%d total=%d truncated=%v, want 3/5/false (body=%s)", len(groups), total, truncated, w.Body.String())
	}
	if n := itemCount(groups, "main.go"); n != 3 {
		t.Fatalf("main.go items = %d, want 3", n)
	}
	if n := itemCount(groups, "util.go"); n != 1 {
		t.Fatalf("util.go items = %d, want 1", n)
	}
	if n := itemCount(groups, "readme.md"); n != 1 {
		t.Fatalf("readme.md items = %d, want 1", n)
	}
	// 组内条目带行号与整行文本（前端展示与跳转依赖）
	for _, g := range groups {
		for _, it := range g.Items {
			if it.Line <= 0 || it.Content == "" {
				t.Fatalf("%s item missing line/content: %+v", g.Path, it)
			}
		}
	}
}

func TestProjectTodos_ExcludesIgnoredDir(t *testing.T) {
	r, f := setupTodosTest(t)

	f.write(".gitignore", "ignored/\n")
	f.run("add", "-A")
	f.run("commit", "-m", "gitignore")
	// 忽略目录内的标记不计入；未跟踪新文件（不在 ignore 内）按工作区语义计入
	f.write("ignored/skip.go", "// TODO: in ignored dir\n")
	f.write("fresh.go", "// TODO: untracked new file\n")

	_, groups, total, _ := getTodos(r, "/api/projects/p1/todos")
	if total != 1 || itemCount(groups, "fresh.go") != 1 {
		t.Fatalf("groups=%+v total=%d, want only fresh.go (ignored dir must be excluded)", groups, total)
	}
	if itemCount(groups, "ignored/skip.go") != -1 {
		t.Fatalf("ignored dir leaked into results: %+v", groups)
	}
}

func TestProjectTodos_WordBoundaryAndCase(t *testing.T) {
	r, f := setupTodosTest(t)

	// 整词+大小写敏感：小写 todo、复数 TODOS、词中 TODOx、普通词 hack 均不计入；
	// 行内 TODO 与 FIXME 同行时按行计 1（后端按行命中）
	f.write("case.go", "package c\n\n// todo lowercase\n// TODOS plural\n// TODOx glued\n// simple hack word\n// TODO: real one\n// FIXME: also real\n")

	_, groups, total, _ := getTodos(r, "/api/projects/p1/todos")
	if total != 2 || itemCount(groups, "case.go") != 2 {
		t.Fatalf("groups=%+v total=%d, want 2 (TODO + FIXME), got noise", groups, total)
	}
}

func TestProjectTodos_TruncatedAtCap(t *testing.T) {
	r, f := setupTodosTest(t)

	// 501 条命中 → 截到 500 + truncated 标记（多取 1 条探测）
	var b strings.Builder
	b.WriteString("package big\n\n")
	for i := 1; i <= maxTodoMarks+1; i++ {
		fmt.Fprintf(&b, "// TODO item %d\n", i)
	}
	f.write("big.go", b.String())

	w, groups, total, truncated := getTodos(r, "/api/projects/p1/todos")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if total != maxTodoMarks || !truncated {
		t.Fatalf("total=%d truncated=%v, want %d/true", total, truncated, maxTodoMarks)
	}
	if len(groups) != 1 || len(groups[0].Items) != maxTodoMarks {
		t.Fatalf("groups=%d items=%d, want 1 group with %d items", len(groups), len(groups[0].Items), maxTodoMarks)
	}
}

func TestProjectTodos_ProjectNotFound(t *testing.T) {
	r, _ := setupTodosTest(t)

	w, _, _, _ := getTodos(r, "/api/projects/ghost/todos")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}
