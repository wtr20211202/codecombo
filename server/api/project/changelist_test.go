package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 变更列表端点测试（P-20261007-19）：走完整请求链（handler 本体）──
// 覆盖：创建/同作用域重名 409 / 可见集按项目过滤 / 活跃切换同域互斥 /
// 文件移入 / 删除作用域匹配 / shelve 干净仓 created=false / 审计入账。

func setupChangelistTest(t *testing.T) *gin.Engine {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	config.ResetForTest()
	t.Cleanup(config.ResetForTest)
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/changelists", GetChangelists)
	r.POST("/api/changelists", CreateChangelist)
	r.DELETE("/api/changelists/:name", DeleteChangelist)
	r.PUT("/api/changelists/active", SetActiveChangelist)
	r.PUT("/api/changelists/move-file", MoveFileToChangelist)
	r.POST("/api/projects/:id/shelve", ShelveFiles)
	return r
}

func clRequest(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func clLists(r *gin.Engine, projectID string) []config.Changelist {
	w := clRequest(r, http.MethodGet, "/api/changelists?projectId="+projectID, "")
	var body struct {
		Data []config.Changelist `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return body.Data
}

func TestChangelist_CreateGetDelete(t *testing.T) {
	r := setupChangelistTest(t)

	// 创建（带项目归属）
	if w := clRequest(r, http.MethodPost, "/api/changelists", `{"name":"login","projectId":"p1"}`); w.Code != http.StatusCreated {
		t.Fatalf("create code = %d", w.Code)
	}
	// 同作用域重名 409（稳定原文供前端 KNOWN_ERROR_I18N）
	if w := clRequest(r, http.MethodPost, "/api/changelists", `{"name":"login","projectId":"p1"}`); w.Code != http.StatusConflict {
		t.Fatalf("dup create code = %d, want 409", w.Code)
	} else if !strings.Contains(w.Body.String(), "changelist already exists") {
		t.Fatalf("dup create body missing stable marker: %s", w.Body.String())
	}
	// 可见集：p1 看到种子 Default（全局）+ login；不含其他项目条目
	if w := clRequest(r, http.MethodPost, "/api/changelists", `{"name":"p2-only","projectId":"pX"}`); w.Code != http.StatusCreated {
		t.Fatalf("create pX code = %d", w.Code)
	}
	lists := clLists(r, "p1")
	if len(lists) != 2 {
		t.Fatalf("p1 visible lists = %d, want 2 (Default + login)", len(lists))
	}
	// 审计入账（创建）——动作词取 store 常量（P-20261007-19 合入时断言误写下划线
	// 形态，与常量点分形态不符，双平台恒红；常量引用防再次漂移）
	evs, _, _ := store.Get().Audit.List(50, 0)
	found := false
	for _, e := range evs {
		if e.Action == store.AuditGitChangelistCreate && e.Result == store.AuditResultSuccess {
			found = true
		}
	}
	if !found {
		t.Fatal("changelist_create audit event missing")
	}

	// 删除（作用域匹配）：删 p1 的 login
	if w := clRequest(r, http.MethodDelete, "/api/changelists/login?projectId=p1", ""); w.Code != http.StatusOK {
		t.Fatalf("delete code = %d", w.Code)
	}
	for _, l := range clLists(r, "p1") {
		if l.Name == "login" {
			t.Fatal("login should be deleted")
		}
	}
}

func TestChangelist_SetActiveScopeMutex(t *testing.T) {
	r := setupChangelistTest(t)
	clRequest(r, http.MethodPost, "/api/changelists", `{"name":"a","projectId":"p1"}`)
	clRequest(r, http.MethodPost, "/api/changelists", `{"name":"b","projectId":"p1"}`)

	if w := clRequest(r, http.MethodPut, "/api/changelists/active", `{"name":"a","projectId":"p1"}`); w.Code != http.StatusOK {
		t.Fatalf("set active code = %d", w.Code)
	}
	for _, l := range clLists(r, "p1") {
		want := l.Name == "a"
		if l.Active != want {
			t.Fatalf("list %s active=%v, want %v", l.Name, l.Active, want)
		}
	}
}

func TestChangelist_MoveFile(t *testing.T) {
	r := setupChangelistTest(t)
	clRequest(r, http.MethodPost, "/api/changelists", `{"name":"a","projectId":"p1"}`)
	clRequest(r, http.MethodPost, "/api/changelists", `{"name":"b","projectId":"p1"}`)

	if w := clRequest(r, http.MethodPut, "/api/changelists/move-file", `{"changelist":"a","file":"src/x.go","projectId":"p1"}`); w.Code != http.StatusOK {
		t.Fatalf("move code = %d", w.Code)
	}
	// 同域换组：移到 b 后 a 无、b 有
	clRequest(r, http.MethodPut, "/api/changelists/move-file", `{"changelist":"b","file":"src/x.go","projectId":"p1"}`)
	for _, l := range clLists(r, "p1") {
		if l.Name == "a" && len(l.Files) != 0 {
			t.Fatalf("a files = %v, want empty after move", l.Files)
		}
		if l.Name == "b" && (len(l.Files) != 1 || l.Files[0] != "src/x.go") {
			t.Fatalf("b files = %v", l.Files)
		}
	}
}

// runGitCL 测试内 git 调用（fetchall_test runGitAll 同款环境锚定）
func runGitCL(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestShelveFiles_CleanRepoCreatedFalse(t *testing.T) {
	r := setupChangelistTest(t)
	// 项目路径须是真实 git 仓库（shelve 走 git stash push）：就地建仓 + 基线提交
	p, err := store.Get().Project.GetByID("p1")
	if err != nil || p == nil {
		t.Fatalf("get project p1: %v", err)
	}
	repo := p.Path
	writeFileCL(t, filepath.Join(repo, "a.txt"), "base\n")
	runGitCL(t, "-C", repo, "init", "-q", "-b", "master")
	runGitCL(t, "-C", repo, "config", "core.autocrlf", "false")
	runGitCL(t, "-C", repo, "add", ".")
	runGitCL(t, "-C", repo, "commit", "-m", "base")
	// 干净仓（项目目录无变更）：200 + created=false，如实回告
	w := clRequest(r, http.MethodPost, "/api/projects/p1/shelve", `{"files":["a.txt"],"message":"g"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("shelve code = %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"created":false`) {
		t.Fatalf("shelve body missing created=false: %s", w.Body.String())
	}
	// 审计入账（成功形态）——动作词取 store 常量（同创建例的下划线笔误修正）
	evs, _, _ := store.Get().Audit.List(50, 0)
	found := false
	for _, e := range evs {
		if e.Action == store.AuditGitChangelistShelve {
			found = true
		}
	}
	if !found {
		t.Fatal("changelist_shelve audit event missing")
	}
}

func writeFileCL(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
