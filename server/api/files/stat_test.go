package files

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// setupStatTest 复用 file_test.go 的项目装配（同 store/project 形态），
// 额外挂生产同形的 stat GET 路由供 handler 用例打点
func setupStatTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	r.GET("/api/projects/:id/file/stat", StatFile)
	return r, projPath
}

// statWrite 用例脚手架：projPath 下按 rel（/ 分隔）建文件（含中间目录）
func statWrite(t *testing.T, projPath, rel, content string) {
	t.Helper()
	p := filepath.Join(projPath, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustStat(t *testing.T, rootPath, absPath string, limit int) DirStat {
	t.Helper()
	d, err := statTarget(rootPath, absPath, limit)
	if err != nil {
		t.Fatalf("statTarget: %v", err)
	}
	return d
}

// TestStatTarget_SingleFile 单文件直接返回：不递归，规模即自身
func TestStatTarget_SingleFile(t *testing.T) {
	projPath := t.TempDir()
	statWrite(t, projPath, "a.txt", "hello")

	d := mustStat(t, projPath, filepath.Join(projPath, "a.txt"), maxStatEntries)
	if d.IsDir || d.Files != 1 || d.Dirs != 0 || d.Bytes != 5 {
		t.Fatalf("stat = %+v, want {IsDir:false Files:1 Dirs:0 Bytes:5}", d)
	}
	if d.SizeHuman == "" {
		t.Fatal("SizeHuman must be populated (前端直显)")
	}
}

// TestStatTarget_DirCountsHiddenAndNested 目录统计：隐藏文件计入（恰是误删
// 盲区），嵌套子目录与其内容计入，Bytes 只算文件内容（目录 inode 尺寸不计）
func TestStatTarget_DirCountsHiddenAndNested(t *testing.T) {
	projPath := t.TempDir()
	statWrite(t, projPath, "probe/visible.txt", "hello") // 5B
	statWrite(t, projPath, "probe/.hidden", "x")         // 1B（隐藏文件计入）
	statWrite(t, projPath, "probe/sub/deep.txt", "yy")   // 2B（嵌套）
	statWrite(t, projPath, "outside.txt", "should-not-count")

	d := mustStat(t, projPath, filepath.Join(projPath, "probe"), maxStatEntries)
	if !d.IsDir || d.Files != 3 || d.Dirs != 1 || d.Bytes != 8 {
		t.Fatalf("stat = %+v, want {IsDir:true Files:3 Dirs:1 Bytes:8}（隐藏/嵌套计入，目标外不计）", d)
	}
	if d.Truncated {
		t.Fatal("未达上限不得置 Truncated")
	}
}

// TestStatTarget_LimitTruncatesOnlyBeyond 上限语义：恰好等于上限不置位，
// 第 limit+1 个条目触发收尾——Truncated=true 当且仅当确有未统计条目
func TestStatTarget_LimitTruncatesOnlyBeyond(t *testing.T) {
	projPath := t.TempDir()
	statWrite(t, projPath, "probe/a.txt", "a")
	statWrite(t, projPath, "probe/b.txt", "b")

	full := mustStat(t, projPath, filepath.Join(projPath, "probe"), 2)
	if full.Files != 2 || full.Truncated {
		t.Fatalf("limit 恰好等于条目数 = %+v, want Files:2 Truncated:false", full)
	}

	capped := mustStat(t, projPath, filepath.Join(projPath, "probe"), 1)
	if capped.Files != 1 || !capped.Truncated {
		t.Fatalf("limit 收尾 = %+v, want Files:1 Truncated:true（下界）", capped)
	}
}

// TestStatTarget_SymlinkCountedNotFollowed 符号链接不深入（P-26 分享扫描同
// 策略）：链接条目本身计入文件数（RemoveAll 会移除链接本身，跳过即低报），
// 但不沿链统计目标侧内容。链接不可用的环境（Windows 无开发者模式）条件跳过
func TestStatTarget_SymlinkCountedNotFollowed(t *testing.T) {
	projPath := t.TempDir()
	statWrite(t, projPath, "probe/keep.txt", "kk")

	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "big.bin"), make([]byte, 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "inner.txt"), []byte("should-not-count"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "big.bin"), filepath.Join(projPath, "probe", "link.bin")); err != nil {
		t.Skipf("symlink 不可用（%v），跳过符号链接用例", err)
	}
	if err := os.Symlink(outside, filepath.Join(projPath, "probe", "linkdir")); err != nil {
		t.Skipf("symlink 不可用（%v），跳过符号链接用例", err)
	}

	d := mustStat(t, projPath, filepath.Join(projPath, "probe"), maxStatEntries)
	// keep.txt + link.bin + linkdir(链接本身) = 3；linkdir 内的 inner.txt 不计入
	if d.Files != 3 || d.Dirs != 0 {
		t.Fatalf("stat = %+v, want Files:3 Dirs:0（链接计自身不深入，目标目录不计 Dirs）", d)
	}
	// Bytes 精确等于 keep 内容 + 两个链接条目自身尺寸（Linux 符号链接 Lstat
	// 尺寸 = 目标路径串长）：目标侧 big.bin 的 100B 内容一旦混入必偏离此值
	wantBytes := int64(len("kk"))
	for _, lp := range []string{
		filepath.Join(projPath, "probe", "link.bin"),
		filepath.Join(projPath, "probe", "linkdir"),
	} {
		li, err := os.Lstat(lp)
		if err != nil {
			t.Fatal(err)
		}
		wantBytes += li.Size()
	}
	if d.Bytes != wantBytes {
		t.Fatalf("Bytes = %d, want %d（仅链接自身，目标内容不计）", d.Bytes, wantBytes)
	}
}

// TestStatFile_HandlerAdmission handler 准入：缺 path 400 / 项目根 403 /
// 越界 403 / 不存在 404（与 GetFilePolicy/DeleteFile 同款错误形态）
func TestStatFile_HandlerAdmission(t *testing.T) {
	r, _ := setupStatTest(t)

	cases := []struct {
		name string
		path string
		want int
	}{
		{"缺 path", "", http.StatusBadRequest},
		{"项目根", ".", http.StatusForbidden},
		{".. 越界", "../x", http.StatusForbidden},
		{"不存在", "no-such", http.StatusNotFound},
	}
	for _, tc := range cases {
		w := doFileJSON(t, r, http.MethodGet,
			"/api/projects/proj-test/file/stat?path="+strings.ReplaceAll(tc.path, "/", "%2F"), "")
		if w.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d, body=%s", tc.name, w.Code, tc.want, w.Body.String())
		}
	}
}

// TestStatFile_HandlerHappyPath handler 全链路：目录含隐藏文件 → 200 且
// data 携带递归规模（e2e 断言的同一载荷形态）
func TestStatFile_HandlerHappyPath(t *testing.T) {
	r, projPath := setupStatTest(t)

	doc := filepath.Join(projPath, "probe-stat")
	if err := os.MkdirAll(filepath.Join(doc, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(doc, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(doc, ".hidden"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/file/stat?path=probe-stat", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data DirStat `json:"data"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, w.Body.String())
	}
	if resp.Data.Files != 2 || resp.Data.Dirs != 1 || resp.Data.Bytes != 6 || !resp.Data.IsDir {
		t.Fatalf("data = %+v, want {IsDir:true Files:2 Dirs:1 Bytes:6}（隐藏文件计入）", resp.Data)
	}
	if !strings.Contains(resp.Data.SizeHuman, "B") {
		t.Fatalf("SizeHuman = %q, want 人类可读字节值", resp.Data.SizeHuman)
	}
}
