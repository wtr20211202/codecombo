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
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupBatchArchiveTest 构造带已注册临时项目的批量归档测试环境。
// 路由形态同生产注册（router.go 的 /files-archive）
func setupBatchArchiveTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	projPath := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-batch",
		Name: "batch",
		Path: projPath,
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/projects/:id/files-archive", DownloadFilesArchive)
	return r, projPath
}

// seedFile 在项目内播种相对路径文件（自动建目录），返回绝对路径
func seedFile(t *testing.T, projPath, rel, content string) {
	t.Helper()
	p := filepath.Join(projPath, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func doGetBatchArchive(t *testing.T, r *gin.Engine, query url.Values) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects/proj-batch/files-archive?"+query.Encode(), nil)
	r.ServeHTTP(w, req)
	return w
}

// zipEntriesByName 解包响应体为「条目名 → 内容」映射（目录占位内容为空）
func zipEntriesByName(t *testing.T, body []byte) map[string]string {
	t.Helper()
	zr := openZip(t, body)
	got := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = string(data)
	}
	return got
}

// TestFilesArchive_ZipStructureCrossDirs 核心验证（P-20261003-250）：多选 3 文件
// 跨 2 目录 → zip 含全部且各条目以选择项为根（basename），内容逐项对得上
func TestFilesArchive_ZipStructureCrossDirs(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "docs/a.txt", "alpha")
	seedFile(t, projPath, "docs/b.txt", "beta")
	seedFile(t, projPath, "src/c.txt", "gamma")

	w := doGetBatchArchive(t, r, url.Values{"paths": {"docs/a.txt", "docs/b.txt", "src/c.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("content-type = %q, want application/zip", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); cd == "" {
		t.Fatalf("content-disposition empty")
	}

	got := zipEntriesByName(t, w.Body.Bytes())
	want := map[string]string{"a.txt": "alpha", "b.txt": "beta", "c.txt": "gamma"}
	for name, content := range want {
		if got[name] != content {
			t.Fatalf("entry %q = %q, want %q; all=%v", name, got[name], content, got)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("zip entries = %v, want exactly %v", got, want)
	}
}

// TestFilesArchive_DirSubtreeRecursive 目录项递归含子树（既有语义）：包内以
// 目录 basename 为根携带整棵子树（嵌套目录占位 Store），与文件项同包共存
func TestFilesArchive_DirSubtreeRecursive(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "docs/a.txt", "alpha")
	seedFile(t, projPath, "docs/inner/b.txt", "beta")
	seedFile(t, projPath, "src/c.txt", "gamma")

	w := doGetBatchArchive(t, r, url.Values{"paths": {"docs", "src/c.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	zr := openZip(t, w.Body.Bytes())
	got := zipEntriesByName(t, w.Body.Bytes())
	want := map[string]string{
		"docs/a.txt":       "alpha",
		"docs/inner/":      "",
		"docs/inner/b.txt": "beta",
		"c.txt":            "gamma",
	}
	for name, content := range want {
		if g, ok := got[name]; !ok || g != content {
			t.Fatalf("entry %q = %q (present=%v), want %q; all=%v", name, g, ok, content, got)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("zip entries = %v, want exactly %v", got, want)
	}
	for _, f := range zr.File {
		if f.Name == "docs/inner/" && f.Method != zip.Store {
			t.Fatalf("dir entry method = %d, want Store(%d)", f.Method, zip.Store)
		}
	}
}

// TestFilesArchive_NameCollisionDedup 跨目录同名文件同包 -N 序号去重
// （首项保原名，按请求顺序；remote uniqueName 同约定）
func TestFilesArchive_NameCollisionDedup(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "docs/same.txt", "from-docs")
	seedFile(t, projPath, "src/same.txt", "from-src")

	w := doGetBatchArchive(t, r, url.Values{"paths": {"docs/same.txt", "src/same.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got := zipEntriesByName(t, w.Body.Bytes())
	if len(got) != 2 {
		t.Fatalf("zip entries = %v, want 2 deduped entries", got)
	}
	if got["same.txt"] != "from-docs" {
		t.Fatalf("same.txt = %q, want from-docs (first keeps base name)", got["same.txt"])
	}
	if got["same-2.txt"] != "from-src" {
		t.Fatalf("same-2.txt = %q, want from-src", got["same-2.txt"])
	}
}

// TestFilesArchive_NestedSelectionDedup 嵌套选择（选中目录 + 其子项）服务端
// 兜底去重：子项随父目录，不双份进包（前端同款前缀规则）
func TestFilesArchive_NestedSelectionDedup(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "docs/a.txt", "alpha")
	seedFile(t, projPath, "src/c.txt", "gamma")

	w := doGetBatchArchive(t, r, url.Values{"paths": {"docs", "docs/a.txt", "src/c.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got := zipEntriesByName(t, w.Body.Bytes())
	want := map[string]string{"docs/a.txt": "alpha", "c.txt": "gamma"}
	if len(got) != len(want) {
		t.Fatalf("zip entries = %v, want exactly %v (nested dup must be dropped)", got, want)
	}
	for name, content := range want {
		if got[name] != content {
			t.Fatalf("entry %q = %q, want %q", name, got[name], content)
		}
	}
}

// TestFilesArchive_SingleFileTarget 单文件选择项：合法出包（条目=自身），
// 包名 = 名.zip——批量的退化形态与单目录包（拒文件）互不越界
func TestFilesArchive_SingleFileTarget(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "f.txt", "solo")

	w := doGetBatchArchive(t, r, url.Values{"paths": {"f.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got := zipEntriesByName(t, w.Body.Bytes())
	if len(got) != 1 || got["f.txt"] != "solo" {
		t.Fatalf("zip entries = %v, want {f.txt: solo}", got)
	}
}

// TestFilesArchive_ProbeAndScanOverride probe=1 聚合规模预估 + 命中带目标前缀；
// 命中未确认不出包（JSON warnings），override=1 整单放行——P-26 同款出域防线
func TestFilesArchive_ProbeAndScanOverride(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "docs/x/.env", "K=v")
	seedFile(t, projPath, "docs/x/a.txt", "alpha")
	seedFile(t, projPath, "src/c.txt", "gamma")

	// probe：条目=3（目录 2 + 文件 1），warnings 带目录目标前缀可定位
	w := doGetBatchArchive(t, r, url.Values{"paths": {"docs/x", "src/c.txt"}, "probe": {"1"}})
	if w.Code != http.StatusOK {
		t.Fatalf("probe status = %d, want 200", w.Code)
	}
	var probe struct {
		Data struct {
			Entries   int64 `json:"entries"`
			Truncated bool  `json:"truncated"`
		} `json:"data"`
		Warnings      []string `json:"warnings"`
		ScanTruncated bool     `json:"scanTruncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Data.Entries != 3 || probe.Data.Truncated {
		t.Fatalf("probe data = %+v, want entries=3 untruncated", probe.Data)
	}
	if len(probe.Warnings) != 1 || probe.Warnings[0] != "docs/x/.env" {
		t.Fatalf("probe warnings = %v, want [docs/x/.env]", probe.Warnings)
	}

	// 未确认：409 拦回 warnings JSON 不出包（P-20261030-2 直链化：200+JSON 会
	// 被浏览器按 a.download 存成假 zip，拦回改冲突状态码）
	blocked := doGetBatchArchive(t, r, url.Values{"paths": {"docs/x", "src/c.txt"}})
	if blocked.Code != http.StatusConflict {
		t.Fatalf("blocked status = %d, want 409", blocked.Code)
	}
	var res struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(blocked.Body.Bytes(), &res); err != nil {
		t.Fatalf("blocked response not JSON: %v (body=%s)", err, blocked.Body.String())
	}
	if len(res.Warnings) != 1 {
		t.Fatalf("blocked warnings = %v, want 1 hit", res.Warnings)
	}

	// override=1：整单放行（.env 随包带走 = 已确认警示的打包意图，同 dir-archive；
	// 目录条目根名 = 选择项 basename，docs/x → x/…）
	got := zipEntriesByName(t, doGetBatchArchive(t, r, url.Values{"paths": {"docs/x", "src/c.txt"}, "override": {"1"}}).Body.Bytes())
	if got["x/.env"] != "K=v" || got["x/a.txt"] != "alpha" || got["c.txt"] != "gamma" {
		t.Fatalf("override zip entries = %v, want x/.env + x/a.txt + c.txt", got)
	}
}

// TestFilesArchive_Rejects 边界拒绝：空/超量 paths 400、穿越 400、缺失 404、
// 全为符号链接 404 不出空包
func TestFilesArchive_Rejects(t *testing.T) {
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "f.txt", "x")

	tooMany := make([]string, 51)
	for i := range tooMany {
		tooMany[i] = "f.txt"
	}
	cases := []struct {
		name  string
		query url.Values
		want  int
	}{
		{"no paths", url.Values{}, http.StatusBadRequest},
		{"empty path segment", url.Values{"paths": {""}}, http.StatusBadRequest},
		{"over 50 paths", url.Values{"paths": tooMany}, http.StatusBadRequest},
		{"traversal escapes root", url.Values{"paths": {"../../etc"}}, http.StatusBadRequest},
		{"missing target", url.Values{"paths": {"nope"}}, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := doGetBatchArchive(t, r, tc.query)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d, body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}

	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(projPath, "f.txt"), filepath.Join(projPath, "lnk")); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		w := doGetBatchArchive(t, r, url.Values{"paths": {"lnk"}})
		if w.Code != http.StatusNotFound {
			t.Fatalf("all-symlink selection status = %d, want 404 no packable", w.Code)
		}
	}
}

// TestFilesArchive_SymlinkTargetSkipped 符号链接选择项跳过、其余项照常出包
// （链接条目不打包策略在选择项级的表现）。Windows 无符号链接权限时跳过，
// WSL 门禁真实执行
func TestFilesArchive_SymlinkTargetSkipped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink needs privilege on windows")
	}
	r, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "keep.txt", "x")
	if err := os.Symlink("/etc", filepath.Join(projPath, "evil")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	w := doGetBatchArchive(t, r, url.Values{"paths": {"evil", "keep.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got := zipEntriesByName(t, w.Body.Bytes())
	if len(got) != 1 || got["keep.txt"] != "x" {
		t.Fatalf("zip entries = %v, want only keep.txt (symlink target skipped)", got)
	}
}

// TestFilesArchive_AggregateLimitTruncates 聚合护栏：跨目标累计触顶停止追加
// （truncated 置位、zip 中央目录完整、条目数=上限）
func TestFilesArchive_AggregateLimitTruncates(t *testing.T) {
	_, projPath := setupBatchArchiveTest(t)
	seedFile(t, projPath, "d1/a.txt", "a")
	seedFile(t, projPath, "d1/b.txt", "b")
	seedFile(t, projPath, "d2/c.txt", "c")

	targets := []batchArchiveTarget{
		{rel: "d1/a.txt", abs: filepath.Join(projPath, "d1", "a.txt")},
		{rel: "d1/b.txt", abs: filepath.Join(projPath, "d1", "b.txt")},
		{rel: "d2/c.txt", abs: filepath.Join(projPath, "d2", "c.txt")},
	}
	var buf bytes.Buffer
	st := streamSelectionZip(&buf, projPath, targets,
		dirZipLimits{maxEntries: 2, maxBytes: dirZipMaxTotalBytes, excludeGit: true})
	if !st.truncated {
		t.Fatalf("expected truncated=true at aggregate limit 2")
	}
	if st.entries != 2 {
		t.Fatalf("entries = %d, want 2", st.entries)
	}
	zr := openZip(t, buf.Bytes())
	if len(zr.File) != 2 {
		t.Fatalf("truncated zip entries = %d, want 2", len(zr.File))
	}
}
