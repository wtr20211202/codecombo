package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// conflictStaleMarkerWant 服务端稳定标记（git.ConflictStaleMarker 的 handler
// 响应原文即契约）——独立字面量避免与被测实现同源复制漂移不可检
const conflictStaleMarkerWant = "conflict file was modified externally since it was loaded"

// ── 冲突解决写回 BaseHash 乐观锁（P-20261004-27）handler 测试 ──
// 真实 fixture 仓库走完整请求链：载入快照（hash 基线）→ 外部改盘 → 失配 409
// 携 currentContent 且 resolve 标记不触达 → 重新解析后二次写回成功。

// seedMergeConflict 在 fixture 上制造 UU 合并冲突（双分支各改 a.txt 后 merge）
func seedMergeConflict(t *testing.T, f *fixtureRepo) {
	t.Helper()
	f.run("checkout", "-q", "-b", "feature")
	f.write("a.txt", "feature side\n")
	f.run("commit", "-qam", "feature edit")
	f.run("checkout", "-q", "main")
	f.write("a.txt", "main side\n")
	f.run("commit", "-qam", "main edit")
	// merge 冲突即预期（非零退出）
	cmd := exec.Command("git", "-C", f.path, "merge", "feature")
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("expected merge conflict, got clean merge: %s", out)
	}
	if out := f.run("status", "--porcelain"); !strings.Contains(out, "UU a.txt") {
		t.Fatalf("expected UU conflict on a.txt, got: %s", out)
	}
}

func setupConflictTest(t *testing.T, f *fixtureRepo) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/projects/:id")
	{
		api.GET("/conflicts/content", GetConflictContent)
		api.GET("/conflicts/parsed", GetConflictParsed)
		api.POST("/conflicts/resolve-content", ResolveConflictWithContent)
	}
	// store 装配复用既有 harness（fixture 项目注册）
	setupGitopsTest(t, f)
	return r
}

func conflictContentHash(t *testing.T, r *gin.Engine, endpoint string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, endpoint, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, body=%s", endpoint, w.Code, w.Body.String())
	}
	var body struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v: %s", endpoint, err, w.Body.String())
	}
	if body.Hash == "" {
		t.Fatalf("%s response missing hash: %s", endpoint, w.Body.String())
	}
	return body.Hash
}

// TestConflictContentResponses_CarryHash 两个读取端点都回传磁盘当前内容 hash
// （files 域 ReadFile 的 hash 字段同款），同一未变文件两次读 hash 一致
func TestConflictContentResponses_CarryHash(t *testing.T) {
	f := newFixtureRepo(t)
	seedMergeConflict(t, f)
	r := setupConflictTest(t, f)

	h1 := conflictContentHash(t, r, "/api/projects/p1/conflicts/content?file=a.txt")
	h2 := conflictContentHash(t, r, "/api/projects/p1/conflicts/parsed?file=a.txt")
	if h1 != h2 {
		t.Fatalf("hash mismatch between content/parsed endpoints: %q vs %q", h1, h2)
	}
}

// TestResolveConflictWithContent_BaseHashMismatchHandler 失配 409 携
// currentContent（外部改动可见）；resolve 标记不触达（冲突仍是 UU，未被他支
// 窗口期改动的「已解决」假象吞掉）；重新解析（新基线）后二次写回成功
func TestResolveConflictWithContent_BaseHashMismatchHandler(t *testing.T) {
	f := newFixtureRepo(t)
	seedMergeConflict(t, f)
	r := setupConflictTest(t, f)

	staleHash := conflictContentHash(t, r, "/api/projects/p1/conflicts/content?file=a.txt")

	// 解析斟酌窗口期：外部（agent/他会话）改盘上同一冲突文件
	external := f.read("a.txt") + "agent tweak\n"
	f.write("a.txt", external)

	w := post(r, "/api/projects/p1/conflicts/resolve-content",
		`{"file":"a.txt","content":"resolved\n","baseHash":"`+staleHash+`"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Error          string `json:"error"`
		CurrentContent string `json:"currentContent"`
		Code           string `json:"code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode 409 body: %v", err)
	}
	if body.Error != conflictStaleMarkerWant {
		t.Fatalf("error marker = %q, want %q", body.Error, conflictStaleMarkerWant)
	}
	// P-20261005-160：结构化 code 与文本标记双轨并存（agent 按码分支、前端按
	// 标记映射，迁移不回退关键字）
	if body.Code != "git.conflict_stale" {
		t.Fatalf("code = %q, want git.conflict_stale", body.Code)
	}
	if !strings.Contains(body.CurrentContent, "agent tweak") {
		t.Fatalf("currentContent = %q, want external edit visible", body.CurrentContent)
	}
	// resolve 标记仅成功路径触达：409 后冲突条目原样（仍 UU、未 git add）
	if out := f.run("status", "--porcelain"); !strings.Contains(out, "UU a.txt") {
		t.Fatalf("conflict entry mutated after 409: %s", out)
	}

	// 重新解析重走快照：新基线随外部改动在场，二次写回成功
	freshHash := conflictContentHash(t, r, "/api/projects/p1/conflicts/content?file=a.txt")
	if freshHash == staleHash {
		t.Fatal("fresh hash equals stale hash after external edit")
	}
	w2 := post(r, "/api/projects/p1/conflicts/resolve-content",
		`{"file":"a.txt","content":"resolved\n","baseHash":"`+freshHash+`"}`)
	if w2.Code != http.StatusOK {
		t.Fatalf("second write status = %d, body=%s", w2.Code, w2.Body.String())
	}
	if got := f.read("a.txt"); got != "resolved\n" {
		t.Fatalf("disk = %q, want resolved content", got)
	}
	// 成功路径 resolve 标记触达：git add 完成（无 UU，改动入暂存区）
	if out := f.run("status", "--porcelain"); strings.Contains(out, "UU") ||
		!strings.Contains(out, "M  a.txt") {
		t.Fatalf("resolve marker not applied after success: %s", out)
	}
}

// TestResolveConflictWithContent_EmptyBaseHashLegacyHandler 空 baseHash = 旧
// 调用方兼容直写（升级窗口期旧前端零破坏）
func TestResolveConflictWithContent_EmptyBaseHashLegacyHandler(t *testing.T) {
	f := newFixtureRepo(t)
	seedMergeConflict(t, f)
	r := setupConflictTest(t, f)

	// 外部改盘后不带 baseHash 直写：不做比对，照常成功
	f.write("a.txt", f.read("a.txt")+"agent tweak\n")
	w := post(r, "/api/projects/p1/conflicts/resolve-content",
		`{"file":"a.txt","content":"legacy write\n"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := f.read("a.txt"); got != "legacy write\n" {
		t.Fatalf("disk = %q, want legacy write", got)
	}
}
