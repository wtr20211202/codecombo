package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 未提交变更导出补丁下载（P-20261003-72）：GET /api/projects/:id/patch?scope=… ──
// 三态内容（worktree/staged/head）+ 空 diff 400 + 下载头（分支+日期文件名）。

func setupPatchDownloadTest(t *testing.T, f *fixtureRepo) *gin.Engine {
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
	api.GET("/patch", DownloadPatch)
	api.POST("/patch/export", ExportPatch)
	return r
}

func getPatch(r *gin.Engine, scope string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/projects/p1/patch?scope="+scope, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestDownloadPatch_ThreeScopes(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)

	// 一份混合变更：a.txt 未暂存 + b.txt 已暂存
	f.write("a.txt", "unstaged\n")
	f.write("b.txt", "staged\n")
	f.run("add", "b.txt")

	// worktree：只含未暂存
	w := getPatch(r, "worktree")
	if w.Code != http.StatusOK {
		t.Fatalf("worktree status = %d, body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "+unstaged") || strings.Contains(body, "staged\nindex") {
		t.Fatalf("worktree patch should carry unstaged only: %s", body)
	}
	if strings.Contains(body, "+staged") {
		t.Fatalf("worktree patch must not include staged change: %s", body)
	}

	// staged：只含已暂存
	w = getPatch(r, "staged")
	if w.Code != http.StatusOK {
		t.Fatalf("staged status = %d, body=%s", w.Code, w.Body.String())
	}
	body = w.Body.String()
	if !strings.Contains(body, "+staged") || strings.Contains(body, "+unstaged") {
		t.Fatalf("staged patch should carry staged only: %s", body)
	}

	// head：暂存+未暂存全集
	w = getPatch(r, "head")
	if w.Code != http.StatusOK {
		t.Fatalf("head status = %d, body=%s", w.Code, w.Body.String())
	}
	body = w.Body.String()
	if !strings.Contains(body, "+staged") || !strings.Contains(body, "+unstaged") {
		t.Fatalf("head patch should carry both: %s", body)
	}

	// --binary：二进制变更入补丁（裸 diff 只有 Binary files differ 占位）
	f.write("bin.dat", "\x00\x01\x02binary\n")
	f.run("add", "bin.dat")
	w = getPatch(r, "staged")
	if w.Code != http.StatusOK {
		t.Fatalf("binary staged status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "GIT binary patch") {
		t.Fatalf("binary change must be embedded (--binary): %s", w.Body.String())
	}
}

func TestDownloadPatch_EmptyDiff400(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)

	// 干净工作区：三态全空 → 400 明确报错（含 scope，前端禁用态的兜底契约）
	for _, scope := range []string{"worktree", "staged", "head"} {
		w := getPatch(r, scope)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("clean repo scope=%s status = %d, body=%s", scope, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "no changes to export") {
			t.Fatalf("clean repo scope=%s expect clear error, body=%s", scope, w.Body.String())
		}
	}

	// 只有未跟踪文件（P-20261004-56）：worktree/head 追补 new-file 段可导出，
	// staged 语义不变（暂存区无 untracked 概念）仍 400
	f.write("untracked.txt", "new\n")
	for _, scope := range []string{"worktree", "head"} {
		w := getPatch(r, scope)
		if w.Code != http.StatusOK {
			t.Fatalf("untracked-only scope=%s status = %d, body=%s", scope, w.Code, w.Body.String())
		}
		body := w.Body.String()
		if !strings.Contains(body, "new file mode") || !strings.Contains(body, "+++ b/untracked.txt") {
			t.Fatalf("untracked-only scope=%s should carry new-file segment: %s", scope, body)
		}
	}
	if w := getPatch(r, "staged"); w.Code != http.StatusBadRequest {
		t.Fatalf("untracked-only staged should stay 400, status = %d, body=%s", w.Code, w.Body.String())
	}
}

func TestDownloadPatch_ScopeValidation(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)
	f.write("a.txt", "changed\n")

	// 非法 scope → 400
	if w := getPatch(r, "nonsense"); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid scope status = %d, body=%s", w.Code, w.Body.String())
	}

	// 缺省 scope → head（最全集，端点可直链）
	w := getPatch(r, "")
	if w.Code != http.StatusOK {
		t.Fatalf("default scope status = %d, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "+changed") {
		t.Fatalf("default scope should export vs HEAD: %s", w.Body.String())
	}
}

func TestDownloadPatch_DispositionHeaders(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)
	f.write("a.txt", "changed\n")

	w := getPatch(r, "head")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	// Content-Type + attachment
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/x-patch") {
		t.Fatalf("Content-Type = %q", ct)
	}
	disp := w.Header().Get("Content-Disposition")
	if !strings.Contains(disp, "attachment") || !strings.Contains(disp, ".patch") {
		t.Fatalf("Content-Disposition = %q", disp)
	}

	// 文件名含分支名（fixture 为 main）+ 当日日期
	wantDate := time.Now().Format("20060102")
	if !strings.Contains(disp, "main-"+wantDate+".patch") {
		t.Fatalf("Content-Disposition missing branch+date: %q", disp)
	}

	// 含路径分隔符的分支名：折叠为 '-'，下载名不拆级
	f.run("checkout", "-b", "feat/x")
	f.write("a.txt", "changed2\n")
	w = getPatch(r, "head")
	disp = w.Header().Get("Content-Disposition")
	if strings.Contains(disp, "feat/x") {
		t.Fatalf("branch slash must be folded: %q", disp)
	}
	if !strings.Contains(disp, "feat-x-"+wantDate+".patch") {
		t.Fatalf("Content-Disposition missing folded branch: %q", disp)
	}
}

// ── 出域敏感闸二段式（P-20261004-97）：.env 等敏感命名文件入补丁时首请求回
// {warnings} 清单，confirm 后才真出；无敏感文件零打扰直下 ──

func TestPatchExport_SensitiveGate(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)
	f.write(".env", "A=1\n")
	f.write("a.txt", "v1\n")
	f.run("add", ".")
	f.run("commit", "-m", "base")
	// 未提交现场：.env 改动（未暂存）+ a.txt 改动（已暂存）+ untracked 密钥证书
	f.write(".env", "SECRET=1\n")
	f.write("a.txt", "v2\n")
	f.run("add", "a.txt")
	f.write("config/prod.pem", "PEM\n")

	// 首请求（未确认）：head 含两处敏感命中 → 200 JSON {warnings}，无附件头
	w := getPatch(r, "head")
	if w.Code != http.StatusOK {
		t.Fatalf("blocked head status = %d, body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("blocked response must be JSON warnings, got %q", ct)
	}
	if disp := w.Header().Get("Content-Disposition"); disp != "" {
		t.Fatalf("blocked response must not carry attachment header, got %q", disp)
	}
	var blocked struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &blocked); err != nil {
		t.Fatalf("blocked body not JSON: %v: %s", err, w.Body.String())
	}
	if !reflect.DeepEqual(blocked.Warnings, []string{".env", "config/prod.pem"}) {
		t.Fatalf("warnings = %v, want [.env config/prod.pem]", blocked.Warnings)
	}

	// 确认二段：confirm=1 真出补丁，内容完整（含 .env 新值与 untracked 证书段）
	w = getPatch(r, "head&confirm=1")
	if w.Code != http.StatusOK {
		t.Fatalf("confirmed head status = %d, body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/x-patch") {
		t.Fatalf("confirmed response must be patch, got %q", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "+SECRET=1") || !strings.Contains(body, "+++ b/config/prod.pem") {
		t.Fatalf("confirmed patch must carry full content: %s", body)
	}

	// 白名单零打扰：staged scope 只有 a.txt（非敏感）→ 不拦直下
	w = getPatch(r, "staged")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "+v2") {
		t.Fatalf("non-sensitive staged scope should download directly: %d %s", w.Code, w.Body.String())
	}

	// POST /patch/export 同闸同契约：未确认回 warnings，confirm=true 出内容
	post := func(payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/patch/export", strings.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	if w = post(`{"staged":false}`); !strings.Contains(w.Body.String(), `"warnings"`) {
		t.Fatalf("export unstaged should be blocked with warnings: %s", w.Body.String())
	}
	if w = post(`{"staged":false,"confirm":true}`); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `+SECRET=1`) || !strings.Contains(w.Body.String(), `"sensitiveHits"`) {
		t.Fatalf("confirmed export should carry content+sensitiveHits: %d %s", w.Code, w.Body.String())
	}
	// 无命中：响应无 warnings/sensitiveHits 键（与闸门前形态同形）
	if w = post(`{"staged":true}`); !strings.Contains(w.Body.String(), `+v2`) ||
		strings.Contains(w.Body.String(), "sensitiveHits") ||
		strings.Contains(w.Body.String(), "warnings") {
		t.Fatalf("clean staged export should stay plain {data}: %s", w.Body.String())
	}
}
