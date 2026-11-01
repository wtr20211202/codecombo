package gitops

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

// ── gitops 高危 handler 测试（C7a）：真实 fixture 仓库走完整请求链 ──
// 覆盖 reset / rebase / reflog-reset / patch-import 四条破坏性最强、
// 此前零测试覆盖的路径。

type fixtureRepo struct {
	t    *testing.T
	path string
}

func (f *fixtureRepo) run(args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", f.path}, args...)...)
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

func (f *fixtureRepo) write(rel, content string) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(f.path, rel)), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.path, rel), []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixtureRepo) read(rel string) string {
	f.t.Helper()
	b, err := os.ReadFile(filepath.Join(f.path, rel))
	if err != nil {
		f.t.Fatal(err)
	}
	return string(b)
}

func (f *fixtureRepo) head() string {
	return strings.TrimSpace(f.run("rev-parse", "HEAD"))
}

// newFixtureRepo 单分支两提交的最小仓库
func newFixtureRepo(t *testing.T) *fixtureRepo {
	t.Helper()
	path := t.TempDir()
	f := &fixtureRepo{t: t, path: path}
	f.run("init", "-b", "main")
	f.run("config", "user.email", "t@t")
	f.run("config", "user.name", "t")
	// Windows 检出换行转换会让断言读到 CRLF——fixture 内固定 LF
	f.run("config", "core.autocrlf", "false")
	f.write("a.txt", "one\n")
	f.run("add", "-A")
	f.run("commit", "-m", "c1")
	f.write("a.txt", "one\ntwo\n")
	f.run("add", "-A")
	f.run("commit", "-m", "c2")
	return f
}

// setupGitopsTest store 装配（注册 fixture 项目）+ gin 路由
func setupGitopsTest(t *testing.T, f *fixtureRepo) *gin.Engine {
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
		api.POST("/reset", ResetRepo)
		api.POST("/rebase", RebaseBranch)
		api.POST("/reflog/reset", ResetToReflog)
		api.POST("/patch/import", ImportPatch)
	}
	return r
}

func post(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestResetRepo_HardMovesWorktree(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	head := f.head()

	// 新提交 c3（改文件）→ hard reset 回 c2 → 工作区文件应回退
	f.write("a.txt", "changed\n")
	f.run("add", "-A")
	f.run("commit", "-m", "c3")

	w := post(r, "/api/projects/p1/reset", `{"mode":"hard","commit":"`+head+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("a.txt"); got != "one\ntwo\n" {
		t.Fatalf("worktree not restored: %q", got)
	}
	if f.head() != head {
		t.Fatalf("HEAD = %s, want %s", f.head(), head)
	}
}

func TestResetRepo_SoftKeepsWorktree(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	head := f.head()
	f.write("b.txt", "staged content\n")
	f.run("add", "-A")
	f.run("commit", "-m", "c3")

	w := post(r, "/api/projects/p1/reset", `{"mode":"soft","commit":"`+head+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	// soft：文件保留且改动回到暂存区
	if got := f.read("b.txt"); got != "staged content\n" {
		t.Fatalf("file lost after soft reset: %q", got)
	}
	out := f.run("status", "--porcelain")
	if !strings.Contains(out, "A  b.txt") && !strings.Contains(out, "AM b.txt") {
		t.Fatalf("change not staged after soft reset: %q", out)
	}
}

func TestResetRepo_UnknownModeFallsBackToMixed(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	head := f.head()
	f.write("b.txt", "untracked-ish\n")
	f.run("add", "-A")
	f.run("commit", "-m", "c3")

	// 未知 mode：git 层白名单（soft/hard 之外回落 mixed）——安全默认的
	// 行为文档化：文件保留、改动落回工作区未暂存
	w := post(r, "/api/projects/p1/reset", `{"mode":"nonsense","commit":"`+head+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("b.txt"); got != "untracked-ish\n" {
		t.Fatalf("file lost: %q", got)
	}
	out := f.run("status", "--porcelain")
	if !strings.Contains(out, "?? b.txt") {
		t.Fatalf("expect unstaged after mixed fallback: %q", out)
	}
}

func TestRebaseBranch_FastForward(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)

	// feature 分支领先 main 一次提交 → main 上 rebase feature = FF
	f.run("checkout", "-b", "feature")
	f.write("f.txt", "feature\n")
	f.run("add", "-A")
	f.run("commit", "-m", "fc1")
	f.run("checkout", "main")

	w := post(r, "/api/projects/p1/rebase", `{"branch":"feature"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("f.txt"); got != "feature\n" {
		t.Fatalf("feature file missing after rebase: %q", got)
	}
}

func TestRebaseBranch_ConflictReported409(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)

	// main 与 feature 各改同一文件 → rebase 冲突 → 409 + output
	f.run("checkout", "-b", "feature")
	f.write("a.txt", "feature side\n")
	f.run("add", "-A")
	f.run("commit", "-m", "fc1")
	f.run("checkout", "main")
	f.write("a.txt", "main side\n")
	f.run("add", "-A")
	f.run("commit", "-m", "mc1")

	w := post(r, "/api/projects/p1/rebase", `{"branch":"feature"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	// 清场：中止 rebase，避免 fixture 残留影响（每测试独立 TempDir，实为防御）
	f.run("rebase", "--abort")
}

func TestResetToReflogEntry_Hard(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)

	target := f.head()
	f.run("commit", "--allow-empty", "-m", "c3")
	// 取 reflog 第 1 条（c3 的前一条 = c2 提交点），reset 后 HEAD 应回到 target
	lines := strings.Split(strings.TrimSpace(f.run("reflog", "--format=%H")), "\n")
	if len(lines) < 2 {
		t.Fatalf("reflog too short: %q", lines)
	}
	prevHash := strings.TrimSpace(lines[1])

	w := post(r, "/api/projects/p1/reflog/reset", `{"hash":"`+prevHash+`","mode":"hard"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if f.head() != target {
		t.Fatalf("HEAD = %s, want %s", f.head(), target)
	}
}

func TestImportPatch_AppliesChange(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)

	// 由真实改动生成 patch → 经 handler 导入（git am 形态）
	f.run("checkout", "-b", "patchsrc")
	f.write("p.txt", "patched\n")
	f.run("add", "-A")
	f.run("commit", "-m", "patch commit")
	patch := f.run("format-patch", "--stdout", "main..patchsrc")
	f.run("checkout", "main")

	w := post(r, "/api/projects/p1/patch/import", `{"content":`+jsonQuote(patch)+`,"apply":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("p.txt"); got != "patched\n" {
		t.Fatalf("patch not applied: %q", got)
	}
	if out := f.run("log", "-1", "--format=%s"); strings.TrimSpace(out) != "patch commit" {
		t.Fatalf("commit subject = %q", out)
	}
}

func TestImportPatch_CRLFNormalized(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)

	f.run("checkout", "-b", "patchsrc")
	f.write("p.txt", "patched\n")
	f.run("add", "-A")
	f.run("commit", "-m", "patch commit")
	patch := strings.ReplaceAll(f.run("format-patch", "--stdout", "main..patchsrc"), "\n", "\r\n")
	f.run("checkout", "main")

	// CRLF 归一后应成功应用（历史缺陷：corrupt patch）
	w := post(r, "/api/projects/p1/patch/import", `{"content":`+jsonQuote(patch)+`,"apply":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("p.txt"); got != "patched\n" {
		t.Fatalf("patch not applied: %q", got)
	}
}

// jsonQuote 字符串转 JSON 字符串字面量（patch 内容含引号/换行）
func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
