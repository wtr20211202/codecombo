package files

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/store"
)

// setupRenameGuardTest 构造带已注册临时项目的重命名防护测试环境
// （POST /file/rename 走生产路由，setup 同 file_conflict_test.go）
func setupRenameGuardTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupConflictTest(t)
	g := r.Group("/api/projects/:id")
	g.POST("/file/rename", RenameFile)
	return r, projPath
}

// TestRenameFile_TargetExists409 目标已存在 → 409「file already exists」，
// 源与目标内容均不被破坏（不落盘）；P-13 既有语义为仅成功入账，失败不产生
// file.rename 审计事件
func TestRenameFile_TargetExists409(t *testing.T) {
	r, projPath := setupRenameGuardTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "src.txt"), []byte("src-keep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "dst.txt"), []byte("dst-keep"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"src.txt","newPath":"dst.txt"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "file already exists") {
		t.Fatalf("body = %s, want error 原文 file already exists（前端已知错误映射识别口径）", w.Body.String())
	}
	// 不落盘：源保留原内容，目标不被覆盖
	if got, _ := os.ReadFile(filepath.Join(projPath, "src.txt")); string(got) != "src-keep" {
		t.Fatalf("src.txt = %q, want src-keep（失败重命名不得移动源）", got)
	}
	if got, _ := os.ReadFile(filepath.Join(projPath, "dst.txt")); string(got) != "dst-keep" {
		t.Fatalf("dst.txt = %q, want dst-keep（409 不得覆盖既有目标）", got)
	}
	if renamed := countRenameAudit(t, "test: src.txt → dst.txt"); renamed != 0 {
		t.Fatalf("失败重命名入账了 %d 条 file.rename 审计，want 0（仅成功入账）", renamed)
	}
}

// TestRenameFile_TargetMissingOK 目标不存在 → 200 正常重命名：内容保留、旧路径消失
func TestRenameFile_TargetMissingOK(t *testing.T) {
	r, projPath := setupRenameGuardTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("payload-9527"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"a.txt","newPath":"b.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(projPath, "a.txt")); !os.IsNotExist(err) {
		t.Fatalf("a.txt stat err = %v, want 旧路径消失", err)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "b.txt")); err != nil || string(got) != "payload-9527" {
		t.Fatalf("b.txt = %q (err=%v), want payload-9527", got, err)
	}
}

// TestRenameFile_SelfRenameIdempotent 同名自身重命名 → 200 幂等（目标即源，
// os.SameFile 判等放行，不走 409）
func TestRenameFile_SelfRenameIdempotent(t *testing.T) {
	r, projPath := setupRenameGuardTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "same.txt"), []byte("unchanged"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"same.txt","newPath":"same.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "same.txt")); err != nil || string(got) != "unchanged" {
		t.Fatalf("same.txt = %q (err=%v), want unchanged", got, err)
	}
}

// countRenameAudit 统计 Detail 精确匹配的成功重命名审计条数
func countRenameAudit(t *testing.T, detail string) int {
	t.Helper()
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range events {
		if e.Action == store.AuditFileRename && e.Result == store.AuditResultSuccess && e.Detail == detail {
			n++
		}
	}
	return n
}

// TestRenameFile_SuccessAudited 成功重命名仍入账（P-13 埋点不被本防护破坏）
func TestRenameFile_SuccessAudited(t *testing.T) {
	r, projPath := setupRenameGuardTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "au-from.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"au-from.txt","newPath":"au-to.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if n := countRenameAudit(t, "test: au-from.txt → au-to.txt"); n != 1 {
		t.Fatalf("成功重命名审计条数 = %d, want 1（P-13 语义不变）", n)
	}
}
