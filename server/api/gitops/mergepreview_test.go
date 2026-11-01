package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/git"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// merge 预演端点（P-20261005-174）：真实 fixture 仓库走完整请求链 + 501
// 版本护栏降级桩（旧版 git 环境无法在 CI 固定，注入 false 验证）
// store/gin 装配沿 destructive_handlers_test.go 同款

func setupMergePreviewTest(t *testing.T, f *fixtureRepo) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: f.path}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	api := r.Group("/api/projects/:id")
	{
		api.GET("/merge-preview", MergePreviewBranch)
	}
	return r
}

func getPreview(r *gin.Engine, query string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/projects/p1/merge-preview"+query, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestMergePreviewEndpoint_ConflictShape 红态载荷：冲突清单 + 状态分类 +
// 冲突段摘要 + 干净计数 + 工作区零副作用
func TestMergePreviewEndpoint_ConflictShape(t *testing.T) {
	f := newFixtureRepo(t)
	f.run("checkout", "-qb", "feature")
	f.write("a.txt", "feature side\n")
	f.write("new.txt", "from feature\n")
	f.run("add", "-A")
	f.run("commit", "-m", "feature")
	f.run("checkout", "main")
	f.write("a.txt", "main side\n")
	f.run("add", "-A")
	f.run("commit", "-m", "main")

	r := setupMergePreviewTest(t, f)
	w := getPreview(r, "?branch=feature")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var res struct {
		Data struct {
			Clean     bool `json:"clean"`
			Conflicts []struct {
				Path      string `json:"path"`
				Status    string `json:"status"`
				HunkCount int    `json:"hunkCount"`
				Ours      string `json:"ours"`
				Theirs    string `json:"theirs"`
			} `json:"conflicts"`
			CleanCount int `json:"cleanCount"`
			Stat       *struct {
				Files int `json:"files"`
			} `json:"stat"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, w.Body.String())
	}
	if res.Data.Clean {
		t.Fatal("expected clean=false for diverged edit")
	}
	if len(res.Data.Conflicts) != 1 || res.Data.Conflicts[0].Path != "a.txt" {
		t.Fatalf("conflicts = %+v, want [a.txt]", res.Data.Conflicts)
	}
	cf := res.Data.Conflicts[0]
	if cf.Status != "both-modified" || cf.HunkCount != 1 {
		t.Errorf("a.txt = %+v, want both-modified 1 hunk", cf)
	}
	if cf.Ours != "main side" || cf.Theirs != "feature side" {
		t.Errorf("sections: ours=%q theirs=%q", cf.Ours, cf.Theirs)
	}
	// 干净计数：new.txt 干净并入（a.txt 带标记是冲突面）
	if res.Data.CleanCount != 1 {
		t.Errorf("cleanCount = %d, want 1", res.Data.CleanCount)
	}
	// 预演零副作用：工作区仍停在 main 侧内容、无脏面、无进行中合并
	if f.read("a.txt") != "main side\n" {
		t.Fatalf("worktree must stay on main side, got %q", f.read("a.txt"))
	}
	if status := strings.TrimSpace(f.run("status", "--porcelain")); status != "" {
		t.Fatalf("worktree dirty after preview: %q", status)
	}
}

// TestMergePreviewEndpoint_CleanShape 绿态载荷：conflicts 恒为数组 + stat 聚合
func TestMergePreviewEndpoint_CleanShape(t *testing.T) {
	f := newFixtureRepo(t)
	f.write("side.txt", "s1\ns2\n")
	f.run("checkout", "-qb", "cleanb")
	f.run("add", "-A")
	f.run("commit", "-m", "clean side")
	f.run("checkout", "main")

	r := setupMergePreviewTest(t, f)
	w := getPreview(r, "?branch=cleanb")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var res struct {
		Data struct {
			Clean     bool  `json:"clean"`
			Conflicts []any `json:"conflicts"`
			Stat      *struct {
				Files      int `json:"files"`
				Insertions int `json:"insertions"`
				Deletions  int `json:"deletions"`
			} `json:"stat"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.Data.Clean || len(res.Data.Conflicts) != 0 {
		t.Fatalf("clean=true + empty conflicts expected, got %+v", res.Data)
	}
	if res.Data.Stat == nil || res.Data.Stat.Files != 1 || res.Data.Stat.Insertions != 2 {
		t.Errorf("stat = %+v, want 1 file +2", res.Data.Stat)
	}
}

// TestMergePreviewEndpoint_501Degraded 版本护栏：git <2.38（注入 false）
// 端点诚实 501 而非误入旧式 merge-tree 错解析
func TestMergePreviewEndpoint_501Degraded(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupMergePreviewTest(t, f)
	git.SetMergeTreeProbeForTest(func() bool { return false })
	t.Cleanup(func() { git.SetMergeTreeProbeForTest(nil) })

	w := getPreview(r, "?branch=main")
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "2.38") {
		t.Errorf("501 body must name required version, got %s", w.Body.String())
	}
}

// TestMergePreviewEndpoint_RequiresBranch 缺参 400
func TestMergePreviewEndpoint_RequiresBranch(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupMergePreviewTest(t, f)
	if w := getPreview(r, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
