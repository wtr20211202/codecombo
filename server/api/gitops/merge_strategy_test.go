package gitops

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// merge 端点策略面（P-20261007-18）：strategy 白名单枚举校验（非法 400）/
// squash 透传产单条汇总提交 / 冲突 409 契约不变。
// fixture 与路由装配沿 destructive_handlers_test.go 同款（store 装配 +
// 只挂被测路由）
func setupMergeStrategyTest(t *testing.T, f *fixtureRepo) *gin.Engine {
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
		api.POST("/merge", MergeBranch)
	}
	return r
}

func TestMergeBranchInvalidStrategy(t *testing.T) {
	f := newFixtureRepo(t)
	f.run("checkout", "-qb", "feature")
	f.write("n.txt", "feature\n")
	f.run("add", "-A")
	f.run("commit", "-m", "feature")
	f.run("checkout", "main")

	r := setupMergeStrategyTest(t, f)
	w := post(r, "/api/projects/p1/merge", `{"source":"feature","strategy":"rebase"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s, want 400", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid merge strategy") {
		t.Fatalf("body = %s, want invalid merge strategy", w.Body.String())
	}
	// 非法策略不触仓库：feature 独有文件未落 main 工作区
	if _, statErr := os.Stat(filepath.Join(f.path, "n.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("repo touched by invalid strategy request: %v", statErr)
	}
}

func TestMergeBranchSquashStrategy(t *testing.T) {
	f := newFixtureRepo(t)
	head := f.head()
	f.run("checkout", "-qb", "feature")
	f.write("s1.txt", "one\n")
	f.run("add", "-A")
	f.run("commit", "-m", "s1 first")
	f.write("s2.txt", "two\n")
	f.run("add", "-A")
	f.run("commit", "-m", "s2 last")
	f.run("checkout", "main")

	r := setupMergeStrategyTest(t, f)
	w := post(r, "/api/projects/p1/merge", `{"source":"feature","strategy":"squash"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	// 单新提交 + 默认汇总消息「(<source>) N commits: 首末提交标题」
	if cnt := strings.TrimSpace(f.run("rev-list", "--count", head+"..HEAD")); cnt != "1" {
		t.Fatalf("commits since head = %s, want 1", cnt)
	}
	if subj := strings.TrimSpace(f.run("log", "-1", "--format=%s")); subj != "(feature) 2 commits: s1 first .. s2 last" {
		t.Fatalf("subject = %q", subj)
	}
}

func TestMergeBranchConflictShapeUnchanged(t *testing.T) {
	f := newFixtureRepo(t)
	f.run("checkout", "-qb", "feature")
	f.write("a.txt", "feature side\n")
	f.run("add", "-A")
	f.run("commit", "-m", "feature edit")
	f.run("checkout", "main")
	f.write("a.txt", "main side\n")
	f.run("add", "-A")
	f.run("commit", "-m", "main edit")

	r := setupMergeStrategyTest(t, f)
	// 默认策略冲突：409 + error/output 载荷（既有契约）
	w := post(r, "/api/projects/p1/merge", `{"source":"feature"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, body=%s, want 409", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"output"`) {
		t.Fatalf("body missing output field: %s", w.Body.String())
	}
	// squash 冲突同形 409，索引冲突态保留
	w2 := post(r, "/api/projects/p1/merge", `{"source":"feature","strategy":"squash"}`)
	if w2.Code != http.StatusConflict {
		t.Fatalf("squash status = %d, body=%s, want 409", w2.Code, w2.Body.String())
	}
	if status := strings.TrimSpace(f.run("status", "--porcelain")); !strings.Contains(status, "UU") {
		t.Fatalf("status = %q, want UU conflict entry kept", status)
	}
}
