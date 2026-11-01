package files

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupFileOpsTest 构造带已注册临时项目的文件写操作测试环境。
// 路由形态同生产注册（router.go 的 /file、/file/mkdir、/file/rename、/file/delete），
// 各用例锚定 handler 既有行为（characterization），作为 files 写路径域改动的回归护栏
func setupFileOpsTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	// 回收站（P-20261003-304）随删除链写入 artifacts/trash/：隔离到临时数据
	// 目录，绝不触碰开发者真实 ~/.simple-coding（oauth_client_test 同款手法）
	t.Setenv("CC_DATA_DIR", t.TempDir())
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	projPath := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-test",
		Name: "test",
		Path: projPath,
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	g := r.Group("/api/projects/:id")
	{
		g.PUT("/file", WriteFile)
		g.POST("/file/mkdir", CreateDir)
		g.POST("/file/rename", RenameFile)
		g.POST("/file/delete", DeleteFile)
	}
	return r, projPath
}

// TestWriteFile_CreateNew 新建（目标不存在、父目录已在）→ 200 且内容落盘
func TestWriteFile_CreateNew(t *testing.T) {
	r, projPath := setupFileOpsTest(t)

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"new.txt","content":"created"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(projPath, "new.txt"))
	if err != nil || string(got) != "created" {
		t.Fatalf("disk = %q (err=%v), want created", got, err)
	}
}

// TestWriteFile_Overwrite 覆写既有文件 → 200 且磁盘内容被替换、无 .sc-tmp-* 残留
// （原子写经 tmp+rename，成功后临时文件应被 rename 消费）
func TestWriteFile_Overwrite(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	target := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(target, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"a.txt","content":"v2"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "v2" {
		t.Fatalf("disk = %q (err=%v), want v2", got, err)
	}
	entries, err := os.ReadDir(projPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".sc-tmp-") {
			t.Fatalf("leftover tmp file: %s", e.Name())
		}
	}
}

// TestWriteFile_PathTraversalRejected 路径越界（".." 段）→ 403
// （safeJoinProject 第一道闸：规范化前先拒绝），且项目外零落盘、项目内零残留
func TestWriteFile_PathTraversalRejected(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	sibling := filepath.Join(filepath.Dir(projPath), "escape.txt")

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"../escape.txt","content":"pwn"}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(sibling); !os.IsNotExist(err) {
		t.Fatalf("越界内容落到项目外 %s: %v", sibling, err)
	}
}

// TestWriteFile_SymlinkEscapeRejected 项目内符号链接指向根外且目标文件已存在 →
// 403（safeJoinProject 第三道闸：EvalSymlinks 真实路径前缀校验，见 download.go 注释）。
// 符号链接创建失败的环境（Windows 无开发者模式/管理员权限）条件跳过——拒绝逻辑本身跨平台一致
func TestWriteFile_SymlinkEscapeRejected(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	outside := t.TempDir()
	victim := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(victim, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(projPath, "lnk")); err != nil {
		t.Skipf("symlink 不可用（%v），跳过符号链接外逃用例", err)
	}

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"lnk/victim.txt","content":"pwn"}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(victim)
	if err != nil || string(got) != "original" {
		t.Fatalf("根外文件被改写: %q (err=%v)", got, err)
	}
}

// TestCreateDir_NormalThenExisting mkdir 正常创建 → 201 且目录落盘（含多级父目录，
// MkdirAll 语义）；再创建已存在目录 → 仍 201（幂等，既有契约；若未来改报冲突需同步前端）
func TestCreateDir_NormalThenExisting(t *testing.T) {
	r, projPath := setupFileOpsTest(t)

	body := `{"path":"docs/notes"}`
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/mkdir", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", w.Code, w.Body.String())
	}
	info, err := os.Stat(filepath.Join(projPath, "docs", "notes"))
	if err != nil || !info.IsDir() {
		t.Fatalf("目录未落盘: %v", err)
	}

	w2 := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/mkdir", body)
	if w2.Code != http.StatusCreated {
		t.Fatalf("已存在目录 status = %d, want 201（MkdirAll 幂等）, body=%s", w2.Code, w2.Body.String())
	}
}

// TestRenameFile_Normal 正常重命名 → 200，旧路径消失、内容随迁
func TestRenameFile_Normal(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"a.txt","newPath":"b.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(projPath, "a.txt")); !os.IsNotExist(err) {
		t.Fatalf("旧路径应消失: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "b.txt"))
	if err != nil || string(got) != "keep" {
		t.Fatalf("新路径 = %q (err=%v), want keep", got, err)
	}
}

// TestRenameFile_TargetExists 目标已存在 → 409 防护属 P-20261002-117（在途，未合入）。
// 合入前 handler 直接 os.Rename（POSIX/Windows 均为替换语义）返回 200，故按响应码分叉：
// 拿到 409 即断言防护契约（带错误信息、目标内容不被覆盖、旧路径保留）；否则视为
// P-117 未合入，条件跳过并注明——P-117 合入后本用例自动转为防护契约断言
func TestRenameFile_TargetExists(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("newname"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "b.txt"), []byte("occupied"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"a.txt","newPath":"b.txt"}`)
	if w.Code == http.StatusConflict {
		var resp struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response not json: %v", err)
		}
		if resp.Error == "" {
			t.Fatal("409 body missing error message")
		}
		if got, _ := os.ReadFile(filepath.Join(projPath, "b.txt")); string(got) != "occupied" {
			t.Fatalf("已存在目标被覆盖: %q", got)
		}
		if _, err := os.Stat(filepath.Join(projPath, "a.txt")); err != nil {
			t.Fatalf("旧路径应保留: %v", err)
		}
		return
	}
	t.Skipf("P-20261002-117 rename 目标存在防护未合入（当前替换语义返回 %d），409 态条件跳过", w.Code)
}

// TestRenameFile_OldPathMissing oldPath 不存在 → 500（os.Rename 报错），
// 且目标路径不会被凭空产生
func TestRenameFile_OldPathMissing(t *testing.T) {
	r, projPath := setupFileOpsTest(t)

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"ghost.txt","newPath":"b.txt"}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(projPath, "b.txt")); !os.IsNotExist(err) {
		t.Fatalf("目标路径不应产生: %v", err)
	}
}

// TestRenameFile_PathBoundary oldPath / newPath 含 ".." 段 → 各自 403
// （invalid old path / invalid new path），项目内文件零变动、项目外零落盘
func TestRenameFile_PathBoundary(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("stay"), 0644); err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(filepath.Dir(projPath), "outside.txt")

	wOld := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"../outside.txt","newPath":"b.txt"}`)
	if wOld.Code != http.StatusForbidden {
		t.Fatalf("oldPath 越界 status = %d, want 403, body=%s", wOld.Code, wOld.Body.String())
	}
	wNew := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"a.txt","newPath":"../outside.txt"}`)
	if wNew.Code != http.StatusForbidden {
		t.Fatalf("newPath 越界 status = %d, want 403, body=%s", wNew.Code, wNew.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(projPath, "a.txt"))
	if err != nil || string(got) != "stay" {
		t.Fatalf("项目内文件不应变动: %q (err=%v)", got, err)
	}
	if _, err := os.Stat(sibling); !os.IsNotExist(err) {
		t.Fatalf("越界内容落到项目外 %s: %v", sibling, err)
	}
}

// TestDeleteFile_Normal 正常删除 → 200 且消失；目录（含子内容）整树删除
func TestDeleteFile_Normal(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	file := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(file, []byte("bye"), 0644); err != nil {
		t.Fatal(err)
	}
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete",
		`{"path":"a.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("文件应已删除: %v", err)
	}

	dir := filepath.Join(projPath, "docs")
	if err := os.MkdirAll(filepath.Join(dir, "notes"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes", "n.md"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	w2 := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete",
		`{"path":"docs"}`)
	if w2.Code != http.StatusOK {
		t.Fatalf("目录删除 status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("目录树应已删除: %v", err)
	}
}

// TestDeleteFile_Missing 删除不存在路径 → 仍 200（os.RemoveAll 对不存在路径返回
// nil，幂等语义——既有契约，前端批量删除循环依赖；若未来改 404 需同步调用方）
func TestDeleteFile_Missing(t *testing.T) {
	r, _ := setupFileOpsTest(t)

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete",
		`{"path":"ghost.txt"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200（幂等）, body=%s", w.Code, w.Body.String())
	}
}

// TestDeleteFile_PathBoundaryAndRoot 删除的路径边界：含 ".." 段 → 403（invalid path）；
// 项目根本身（path "."）→ 403 cannot delete project root，且项目根必须健在
func TestDeleteFile_PathBoundaryAndRoot(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	sibling := filepath.Join(filepath.Dir(projPath), "outside.txt")

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete",
		`{"path":"../outside.txt"}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("越界删除 status = %d, want 403, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(sibling); !os.IsNotExist(err) {
		t.Fatalf("项目外内容不应被删（本就不存在）: %v", err)
	}

	wRoot := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete",
		`{"path":"."}`)
	if wRoot.Code != http.StatusForbidden {
		t.Fatalf("删根 status = %d, want 403, body=%s", wRoot.Code, wRoot.Body.String())
	}
	if _, err := os.Stat(projPath); err != nil {
		t.Fatalf("项目根不应被删: %v", err)
	}
}
