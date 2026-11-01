package files

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// setupNameCompatTest 构造带 create/mkdir/rename 三入口的测试环境
// （setup 同 file_conflict_test.go，路由挂载同 file_rename_guard_test.go 形态）
func setupNameCompatTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupConflictTest(t)
	g := r.Group("/api/projects/:id")
	g.POST("/file/create", CreateFile)
	g.POST("/file/mkdir", CreateDir)
	g.POST("/file/rename", RenameFile)
	return r, projPath
}

// TestValidateNameCompat_ReservedDevices Windows 保留设备名全形态拒绝：
// 裸名/大小写变体/带扩展名形态/嵌套段命中；主干非保留名的正常名不受影响
func TestValidateNameCompat_ReservedDevices(t *testing.T) {
	rejected := []string{
		// 裸名 + 大小写不敏感
		"CON", "con", "Con", "PRN", "prn", "AUX", "aux", "NUL", "nul",
		// COM/LPT 1-9 全档位（抽全 + 变体）
		"COM1", "com9", "Com5", "LPT1", "lpt9", "Lpt3",
		// 带扩展名形态：主干命中即保留
		"CON.txt", "nul.md", "Com1.go", "aux.tar.gz", "LPT9.log",
		// 嵌套路径段命中
		"docs/con.txt", "sub/aux/nested.md", "a/NUL/b.md",
	}
	for _, name := range rejected {
		if err := validateNameCompat(name); err == nil {
			t.Errorf("validateNameCompat(%q) = nil, want reject（Windows 保留设备名）", name)
		} else if !strings.Contains(err.Error(), "invalid file name") {
			t.Errorf("validateNameCompat(%q) err = %q, want 稳定前缀 invalid file name:", name, err.Error())
		}
	}

	// 主干含保留名字样但主干本身不是保留名：放行（从严不误伤）
	passing := []string{
		"constant.go", "concourse.yml", "auxiliary.ts", "null.ts",
		"console.ts", "control.md", "prng.py", "nulldate.txt",
	}
	for _, name := range passing {
		if err := validateNameCompat(name); err != nil {
			t.Errorf("validateNameCompat(%q) = %v, want nil（主干非保留名不误伤）", name, err)
		}
	}
}

// TestValidateNameCompat_TrailingDotSpace 段结尾点/空格拒绝（含嵌套段）；
// 名字内部的点/空格与结尾之外的形态不受影响
func TestValidateNameCompat_TrailingDotSpace(t *testing.T) {
	rejected := []string{
		"a.",       // 结尾点
		"a ",       // 结尾空格
		"a. ",      // 点后空格结尾
		"...",      // 全点段（Windows 同样拒绝）
		"docs/b .", // 嵌套段结尾点
		"docs/b ",  // 嵌套段结尾空格
	}
	for _, name := range rejected {
		if err := validateNameCompat(name); err == nil {
			t.Errorf("validateNameCompat(%q) = nil, want reject（段结尾点/空格）", name)
		}
	}

	passing := []string{
		"a.b",          // 内部点正常
		"v1.2.3",       // 多级版本号
		"a b c.md",     // 内部空格正常
		".gitignore",   // 开头点（隐藏文件）不受结尾规则影响
		"docs/.hidden", // 嵌套隐藏文件
		"说明 文档.md",     // 非 ASCII + 内部空格
	}
	for _, name := range passing {
		if err := validateNameCompat(name); err != nil {
			t.Errorf("validateNameCompat(%q) = %v, want nil（仅校验段结尾，内部形态放行）", name, err)
		}
	}
}

// TestValidateNameCompat_NormalNamesPass 正常名三态不误伤：根段/嵌套/目录路径
func TestValidateNameCompat_NormalNamesPass(t *testing.T) {
	passing := []string{
		"README.md",
		"docs/guide.md",
		"server/api/files/file.go",
		"new-dir/nested/deep.txt",
		"package.json",
	}
	for _, name := range passing {
		if err := validateNameCompat(name); err != nil {
			t.Errorf("validateNameCompat(%q) = %v, want nil（正常名不误伤）", name, err)
		}
	}
	// 空段（规范化写法如根相对路径）与 "."/".." 段不在本校验职责内（".." 由
	// SafeJoinProject 拒绝）：跳过段不报错
	for _, name := range []string{"/docs/a.txt", "docs//a.txt", "./a.txt", "a/../b.txt"} {
		if err := validateNameCompat(name); err != nil {
			t.Errorf("validateNameCompat(%q) = %v, want nil（空段/../段由 SafeJoinProject 管）", name, err)
		}
	}
}

// TestCreateFile_ReservedNameRejected400 CreateFile 入口拒绝保留名（400 + 稳定错误原文），
// 磁盘不落任何文件（Windows 上 os.WriteFile 对 CON 原生报错，守卫必须先于写盘拦截）
func TestCreateFile_ReservedNameRejected400(t *testing.T) {
	r, projPath := setupNameCompatTest(t)

	for _, name := range []string{"CON.txt", "com1", "docs/aux.md"} {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/create",
			`{"path":"`+name+`","content":"x"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("create %q status = %d, want 400, body=%s", name, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid file name") {
			t.Fatalf("create %q body = %s, want 稳定前缀 invalid file name:（前端识别口径）", name, w.Body.String())
		}
	}
	entries, err := os.ReadDir(projPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("被拒创建落盘了 %d 项，want 0", len(entries))
	}
}

// TestCreateFile_NormalNameStillCreated 正常名新建照常（守卫不误伤主链路）
func TestCreateFile_NormalNameStillCreated(t *testing.T) {
	r, projPath := setupNameCompatTest(t)

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/create",
		`{"path":"docs/ok-name.md","content":"fine"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", w.Code, w.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "docs", "ok-name.md")); err != nil || string(got) != "fine" {
		t.Fatalf("docs/ok-name.md = %q (err=%v), want fine", got, err)
	}
}

// TestCreateDir_TrailingDotRejected400 mkdir 入口拒绝结尾点/空格段；
// 结尾空格在请求 JSON 里保留（raw 字符串）以覆盖真实形态
func TestCreateDir_TrailingDotRejected400(t *testing.T) {
	r, projPath := setupNameCompatTest(t)

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/mkdir",
		`{"path":"bad-dir."}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid file name") {
		t.Fatalf("body = %s, want invalid file name:", w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(projPath, "bad-dir.")); !os.IsNotExist(err) {
		t.Fatalf("bad-dir. stat err = %v, want 不落盘", err)
	}

	// 正常目录照常创建
	w2 := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/mkdir",
		`{"path":"fine-dir"}`)
	if w2.Code != http.StatusCreated {
		t.Fatalf("mkdir fine-dir status = %d, want 201, body=%s", w2.Code, w2.Body.String())
	}
}

// TestRenameFile_InvalidTargetName400 重命名目标命中保留名/结尾点 → 400（在
// P-117 目标存在防护之前）：无效名比「已存在」更早失败；旧文件不受影响
func TestRenameFile_InvalidTargetName400(t *testing.T) {
	r, projPath := setupNameCompatTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "src.md"), []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{"con", "to.txt ", "nul.md"} {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
			`{"oldPath":"src.md","newPath":"`+target+`"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("rename → %q status = %d, want 400, body=%s", target, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid file name") {
			t.Fatalf("rename → %q body = %s, want invalid file name:", target, w.Body.String())
		}
	}
	// 旧文件原样保留（失败重命名不移动源）
	if got, err := os.ReadFile(filepath.Join(projPath, "src.md")); err != nil || string(got) != "keep" {
		t.Fatalf("src.md = %q (err=%v), want keep", got, err)
	}

	// 正常名重命名照常（P-117 同名 409 与本守卫互不重叠，既有语义回归由
	// file_rename_guard_test.go 全量覆盖）
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"src.md","newPath":"dst.md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("rename 正常名 status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
}

// TestRenameFile_LeaveMineNameAllowed 改名离开地雷名（旧名是保留名）→ 放行：
// 校验只看新名，已存在的旧名不回头追责
func TestRenameFile_LeaveMineNameAllowed(t *testing.T) {
	r, projPath := setupNameCompatTest(t)
	src := filepath.Join(projPath, "legacy-src.md")
	if err := os.WriteFile(src, []byte("escape"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"legacy-src.md","newPath":"clean-name.md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("legacy-src.md stat err = %v, want 已改名", err)
	}
}
