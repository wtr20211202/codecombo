package files

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupDirArchiveTest 构造带已注册临时项目的目录打包下载测试环境。
// 路由形态同生产注册（router.go 的 /dir-archive）
func setupDirArchiveTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
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
	r.GET("/api/projects/:id/dir-archive", DownloadDirArchive)
	return r, projPath
}

func doGetArchive(t *testing.T, r *gin.Engine, query url.Values) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/dir-archive?"+query.Encode(), nil)
	r.ServeHTTP(w, req)
	return w
}

// openZip 解包响应体（结构损坏/非 zip 直接失败）
func openZip(t *testing.T, body []byte) *zip.Reader {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open zip: %v (body head=%q)", err, string(body[:min(len(body), 64)]))
	}
	return zr
}

// TestDirArchive_ZipStructure 目录树打包：条目名/层级/内容逐项核对（目录占位
// 条目 Store、文件 Deflate），文件名带 .zip 附件头
func TestDirArchive_ZipStructure(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	write := func(rel, content string) {
		p := filepath.Join(projPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("sub/a.txt", "alpha")
	write("sub/inner/b.txt", "beta")
	write("sub/inner/c.log", "gamma")

	w := doGetArchive(t, r, url.Values{"path": {"sub"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("content-type = %q, want application/zip", ct)
	}
	cd := w.Header().Get("Content-Disposition")
	if cd == "" || !bytes.Contains([]byte(cd), []byte(url.PathEscape("sub.zip"))) {
		t.Fatalf("content-disposition = %q, want attachment sub.zip", cd)
	}

	zr := openZip(t, w.Body.Bytes())
	got := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = string(data)
		if f.Name == "inner/" && f.Method != zip.Store {
			t.Fatalf("dir entry method = %d, want Store(%d)", f.Method, zip.Store)
		}
	}
	want := map[string]string{
		"a.txt":       "alpha",
		"inner/":      "",
		"inner/b.txt": "beta",
		"inner/c.log": "gamma",
	}
	for name, content := range want {
		if _, ok := got[name]; !ok {
			t.Fatalf("zip missing entry %q; got %v", name, got)
		}
		if got[name] != content {
			t.Fatalf("entry %q = %q, want %q", name, got[name], content)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("zip entries = %d, want %d: %v", len(got), len(want), got)
	}
}

// TestDirArchive_GitExcluded .git 目录默认排除、excludeGit=0 可带（工作区快照
// 语义：历史对象树不随包带走）
func TestDirArchive_GitExcluded(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	for _, rel := range []string{"sub/a.txt", "sub/.git/config", "sub/.git/HEAD"} {
		p := filepath.Join(projPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	zr := openZip(t, doGetArchive(t, r, url.Values{"path": {"sub"}}).Body.Bytes())
	for _, f := range zr.File {
		if bytes.Contains([]byte(f.Name), []byte(".git")) {
			t.Fatalf(".git entry leaked by default: %q", f.Name)
		}
	}
	zr = openZip(t, doGetArchive(t, r, url.Values{"path": {"sub"}, "excludeGit": {"0"}}).Body.Bytes())
	found := false
	for _, f := range zr.File {
		if f.Name == ".git/config" {
			found = true
		}
	}
	if !found {
		t.Fatalf("excludeGit=0 should include .git/config")
	}
}

// writeSubFile 在项目 sub/ 下播种文件（自动建目录），供各用例复用
func writeSubFile(t *testing.T, projPath, name, content string) {
	t.Helper()
	p := filepath.Join(projPath, "sub", name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDirArchive_SymlinkSkipped 符号链接条目跳过不打包（zip-slip 变体防御，
// share writeZip 同策略）。Windows 无符号链接权限时跳过，WSL 门禁真实执行
func TestDirArchive_SymlinkSkipped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink needs privilege on windows")
	}
	r, projPath := setupDirArchiveTest(t)
	writeSubFile(t, projPath, "keep.txt", "x")
	if err := os.Symlink("/etc", filepath.Join(projPath, "sub", "evil-link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	zr := openZip(t, doGetArchive(t, r, url.Values{"path": {"sub"}}).Body.Bytes())
	for _, f := range zr.File {
		if f.Name == "evil-link" {
			t.Fatalf("symlink entry should be skipped: %q", f.Name)
		}
	}
}

// TestDirArchive_EntryLimitTruncates 条目护栏触顶：包仍合法（中央目录完整），
// 只含上限内条目，probe 同口径置 Truncated
func TestDirArchive_EntryLimitTruncates(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	for i := 0; i < 5; i++ {
		writeSubFile(t, projPath, string(rune('a'+i))+".txt", "x")
	}

	body := doGetArchive(t, r, url.Values{"path": {"sub"}}).Body.Bytes()
	zr := openZip(t, body)
	if len(zr.File) != 5 {
		t.Fatalf("unlimited entries = %d, want 5", len(zr.File))
	}

	// 小上限打包（模拟触顶）：zip.Reader 能打开即中央目录完整
	var buf bytes.Buffer
	st := streamDirZip(&buf, projPath, filepath.Join(projPath, "sub"),
		dirZipLimits{maxEntries: 2, maxBytes: dirZipMaxTotalBytes, excludeGit: true})
	if !st.truncated {
		t.Fatalf("expected truncated=true at limit 2")
	}
	if st.entries != 2 {
		t.Fatalf("entries = %d, want 2", st.entries)
	}
	zr = openZip(t, buf.Bytes())
	if len(zr.File) != 2 {
		t.Fatalf("truncated zip entries = %d, want 2", len(zr.File))
	}

	// probe 同口径：条目上限触顶 → data.truncated=true
	w := doGetArchive(t, r, url.Values{"path": {"sub"}, "probe": {"1"}})
	if w.Code != http.StatusOK {
		t.Fatalf("probe status = %d, want 200", w.Code)
	}
	var probe struct {
		Data struct {
			Entries   int64 `json:"entries"`
			Truncated bool  `json:"truncated"`
		} `json:"data"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Data.Entries != 5 || probe.Data.Truncated {
		t.Fatalf("probe scale = %+v (want entries=5 untruncated; limits match production here)", probe.Data)
	}
}

// TestDirArchive_ScanBlockedThenOverride 敏感命中 409 拦回 warnings（不出包；
// P-20261030-2 直链化：200+JSON 会被浏览器按 a.download 存成假 zip，拦回改
// 冲突状态码），override=1 二次请求才出包——P-26 分享扫描同款出域防线
func TestDirArchive_ScanBlockedThenOverride(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	writeSubFile(t, projPath, ".env", "K=v")
	writeSubFile(t, projPath, "a.txt", "x")

	w := doGetArchive(t, r, url.Values{"path": {"sub"}})
	if w.Code != http.StatusConflict {
		t.Fatalf("blocked status = %d, want 409", w.Code)
	}
	var blocked struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &blocked); err != nil {
		t.Fatalf("blocked response not JSON: %v (body=%s)", err, w.Body.String())
	}
	if len(blocked.Warnings) != 1 || blocked.Warnings[0] != ".env" {
		t.Fatalf("warnings = %v, want [.env]", blocked.Warnings)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("blocked content-type = %q, want json", ct)
	}

	// override=1：出包且 .env 条目在内（警示已确认，打包即用户意图）
	zr := openZip(t, doGetArchive(t, r, url.Values{"path": {"sub"}, "override": {"1"}}).Body.Bytes())
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names[".env"] || !names["a.txt"] {
		t.Fatalf("override zip entries = %v, want .env + a.txt", names)
	}
}

// TestDirArchive_ProbeShape probe=1 返回规模预估 + 敏感命中（含空清单），
// 不出包（纯 JSON）
func TestDirArchive_ProbeShape(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	writeSubFile(t, projPath, "a.txt", "hello")

	w := doGetArchive(t, r, url.Values{"path": {"sub"}, "probe": {"1"}})
	if w.Code != http.StatusOK {
		t.Fatalf("probe status = %d, want 200", w.Code)
	}
	var probe struct {
		Data struct {
			Entries int64 `json:"entries"`
			Bytes   int64 `json:"bytes"`
		} `json:"data"`
		Warnings      []string `json:"warnings"`
		ScanTruncated bool     `json:"scanTruncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Data.Entries != 1 || probe.Data.Bytes != 5 {
		t.Fatalf("probe data = %+v, want entries=1 bytes=5", probe.Data)
	}
	if probe.Warnings == nil || len(probe.Warnings) != 0 {
		t.Fatalf("probe warnings = %v, want empty list", probe.Warnings)
	}
}

// TestDirArchive_Rejects 边界拒绝：路径穿越 400（归一层拦）、目标缺失 404、
// 文件目标 400 not a directory
func TestDirArchive_Rejects(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		query url.Values
		want  int
	}{
		{"traversal escapes root", url.Values{"path": {"../../etc"}}, http.StatusBadRequest},
		{"missing target", url.Values{"path": {"nope"}}, http.StatusNotFound},
		{"file target", url.Values{"path": {"f.txt"}}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := doGetArchive(t, r, tc.query)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d, body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}

// TestDirArchive_RootArchive path 为空 = 项目根本身打包（zip 名取项目目录名，
// 树右键不提供该入口，API 直达可用）
func TestDirArchive_RootArchive(t *testing.T) {
	r, projPath := setupDirArchiveTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "top.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGetArchive(t, r, url.Values{"path": {""}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	zr := openZip(t, w.Body.Bytes())
	found := false
	for _, f := range zr.File {
		if f.Name == "top.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("root zip missing top.txt")
	}
}
