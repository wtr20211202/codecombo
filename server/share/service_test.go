package share

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// ---- fakes ----

type fakeShares map[string]*store.Share

func (f fakeShares) Get(token string) (*store.Share, error) {
	if s, ok := f[token]; ok {
		return s, nil
	}
	return nil, store.ErrNotFound
}

// Delete 惰性清理落点：直接从 map 删除（访客面把守「过期首踩即删」的观测口）
func (f fakeShares) Delete(token string) error {
	delete(f, token)
	return nil
}

type fakeRoots struct{ byID map[string]string }

func (f fakeRoots) RootOf(projectID string) (string, error) {
	if dir, ok := f.byID[projectID]; ok {
		return dir, nil
	}
	return "", os.ErrNotExist
}

// fixedToken 定长 16 位测试 token（满足形态门禁）
func fixedToken(s string) string {
	for len(s) < 16 {
		s += "x"
	}
	return s[:16]
}

// fixture 建一个临时项目树：docs/readme.md、docs/sub/note.txt、img.png、
// secret.txt（不在分享根内）、指向外部的符号链接（平台上能建就建）
func fixture(t *testing.T) (root string) {
	t.Helper()
	root = t.TempDir()
	mustWrite := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("docs/readme.md", "# Title\n\n<script>alert(1)</script>hello [link](https://example.com)")
	mustWrite("docs/sub/note.txt", "note content")
	mustWrite("img.png", "PNGDATA")
	mustWrite("app.exe", "MZbinary")
	_ = os.MkdirAll(filepath.Join(root, "empty"), 0o755)
	return root
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	root := fixture(t)
	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

// TestVisitorSurfaceNoStore 访客面全响应 no-store（P-20261002-121）：
// 页面/元信息/原文/错误页统一携 no-store + Pragma 兜底——短链常在共享/
// 公共设备上打开，不在本地缓存留痕。本服务只出私有分享内容（无静态
// 资源），入口施加即全覆盖
func TestVisitorSurfaceNoStore(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")
	for _, path := range []string{
		"/s/" + token,                              // 分享页（HTML）
		"/s/" + token + "/meta",                    // 元信息（JSON）
		"/s/" + token + "/raw?path=readme.md",      // 文本原文
		"/s/" + token + "/download?path=readme.md", // 下载
		"/s/aaaaaaaaaaaaaaaa",                      // 未知短链 404 页
	} {
		resp := get(t, srv.URL+path)
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", path, got)
		}
		if got := resp.Header.Get("Pragma"); got != "no-cache" {
			t.Errorf("%s: Pragma = %q, want no-cache", path, got)
		}
		_ = resp.Body.Close()
	}
}

// TestFileShareExpiryMetaAndGuestBanner 有效期闭环（P-20261020-5）：文件/目录
// 分享的 meta 透出 expiresAt（agent 程序化读取与访客页共用），访客页非永久
// 记录在紧凑状态条上渲染有效期段（P-20261111-5 与快照声明合并单行）；
// 永久记录零渲染
func TestFileShareExpiryMetaAndGuestBanner(t *testing.T) {
	// expiresAt 动态远期（截断到分钟）：硬编码日历时刻是定时炸弹——原
	// 2026-11-01 12:00 local 一过 meta 即 410、横幅断言全红（share_collab
	// 夹具 af12a0d0 同族）；横幅期望串取同 layout 的夹具格式化值随夹具走
	expiresAt := time.Now().AddDate(1, 0, 0).Truncate(time.Minute)
	mk := func(token string, at time.Time) *httptest.Server {
		svc := NewService(fakeShares{token: {
			Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
			Path: "docs", IsDir: true, ExpiresAt: at,
		}}, fakeRoots{byID: map[string]string{"p1": fixture(t)}}, nil)
		srv := httptest.NewServer(svc.Handler())
		t.Cleanup(srv.Close)
		return srv
	}

	ttlTok, permTok := fixedToken("ttlfile"), fixedToken("permfile")
	srv := mk(ttlTok, expiresAt)

	// meta：文件/目录形态同样携带 expiresAt（RFC3339）
	resp := get(t, srv.URL+"/s/"+ttlTok+"/meta")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("meta status = %d", resp.StatusCode)
	}
	var meta struct {
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		t.Fatalf("meta json: %v (%s)", err, body)
	}
	if got, err := time.Parse(time.RFC3339, meta.ExpiresAt); err != nil || !got.Equal(expiresAt) {
		t.Fatalf("meta expiresAt = %q, want %v", meta.ExpiresAt, expiresAt)
	}

	// 访客页：有效期段随紧凑状态条（服务端直出；get 无 Accept-Language 落
	// en，短文案 expires {time} 与悬停全句分层，此处锚条节点与本地时点）
	page := get(t, srv.URL+"/s/"+ttlTok)
	pageBody, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if !strings.Contains(string(pageBody), `id="status-banner"`) {
		t.Fatalf("non-permanent share page must carry the expiry status bar\n%s", pageBody)
	}
	if !strings.Contains(string(pageBody), expiresAt.Format("2006-01-02 15:04")) {
		t.Fatalf("expiry banner must carry the local expiry time\n%s", pageBody)
	}

	// 永久记录：meta 不带 expiresAt，页面无横幅节点（可见行为零变化）
	permSrv := mk(permTok, time.Time{})
	presp := get(t, permSrv.URL+"/s/"+permTok+"/meta")
	pbody, _ := io.ReadAll(presp.Body)
	presp.Body.Close()
	if strings.Contains(string(pbody), "expiresAt") {
		t.Fatalf("permanent share meta must not carry expiresAt: %s", pbody)
	}
	ppage := get(t, permSrv.URL+"/s/"+permTok)
	ppageBody, _ := io.ReadAll(ppage.Body)
	ppage.Body.Close()
	if strings.Contains(string(ppageBody), `id="status-banner"`) {
		t.Fatalf("permanent share page must not render the status bar")
	}
}

func TestPageUnknownTokenFriendly404(t *testing.T) {
	srv := newTestServer(t)
	resp := get(t, srv.URL+"/s/aaaaaaaaaaaaaaaa")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "404") {
		t.Fatal("friendly 404 page should mention 404")
	}
	// 形态不对的 token 同样 404（不查库）
	resp2 := get(t, srv.URL+"/s/..%2Fetc")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("malformed token status = %d, want 404", resp2.StatusCode)
	}
}

func TestMetaAndListDirShare(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")

	resp := get(t, srv.URL+"/s/"+token+"/meta")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("meta status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"isDir":true`) || !strings.Contains(string(body), "docs") {
		t.Fatalf("meta body unexpected: %s", body)
	}

	// 根列表：分享根（docs）的一级条目
	resp2 := get(t, srv.URL+"/s/"+token+"/list")
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	for _, want := range []string{"readme.md", "sub"} {
		if !strings.Contains(string(body2), want) {
			t.Fatalf("list missing %q: %s", want, body2)
		}
	}
	// img.png/app.exe 在项目根但不在分享根（docs）内，绝不可出现
	if strings.Contains(string(body2), "img.png") || strings.Contains(string(body2), "app.exe") {
		t.Fatalf("list leaked entries outside share root: %s", body2)
	}

	// 子目录列表（递归浏览语义）：docs/sub 下是 note.txt
	resp3 := get(t, srv.URL+"/s/"+token+"/list?path=sub")
	defer resp3.Body.Close()
	body3, _ := io.ReadAll(resp3.Body)
	if !strings.Contains(string(body3), "note.txt") {
		t.Fatalf("subdir list missing note.txt: %s", body3)
	}
}

func TestTraversalRejected(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")
	for _, bad := range []string{"..%2f..%2fimg.png", "%2e%2e%2fimg.png", "sub%2f..%2f..%2f..%2fimg.png", ".."} {
		resp := get(t, srv.URL+"/s/"+token+"/raw?path="+bad)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Fatalf("traversal path %q escaped share root", bad)
		}
	}
}

func TestRawAndMarkdownSanitized(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")

	// raw：文本原样 + nosniff + CSP sandbox
	resp := get(t, srv.URL+"/s/"+token+"/raw?path=sub/note.txt")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("raw status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("raw content-type = %s", ct)
	}
	if resp.Header.Get("Content-Security-Policy") != "sandbox" {
		t.Fatal("raw must carry CSP sandbox")
	}
	b, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(b)) != "note content" {
		t.Fatalf("raw body = %q", b)
	}

	// render：markdown 转净 HTML，script 必须被剥离
	resp2 := get(t, srv.URL+"/s/"+token+"/render?path=readme.md")
	defer resp2.Body.Close()
	b2, _ := io.ReadAll(resp2.Body)
	sb := string(b2)
	if strings.Contains(sb, "<script>") {
		t.Fatalf("render leaked script tag: %s", sb)
	}
	if !strings.Contains(sb, "Title") || !strings.Contains(sb, "<h1") {
		t.Fatalf("render missing heading: %s", sb)
	}
	// 链接应带 target=_blank（渲染 Flag）
	if !strings.Contains(sb, `target="_blank"`) {
		t.Fatalf("render link lacks target=_blank: %s", sb)
	}
}

func TestUnsupportedFileDownloadAndZipDir(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")

	// 分享根为 docs；把单文件下载路径对准根下文件（下载原始字节 + attachment）
	resp := get(t, srv.URL+"/s/"+token+"/download?path=readme.md")
	defer resp.Body.Close()
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf("download disposition = %s", cd)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "# Title") {
		t.Fatalf("download body = %q", b)
	}

	// 目录下载：zip 流，含 docs 下两个文件
	resp2 := get(t, srv.URL+"/s/"+token+"/download")
	defer resp2.Body.Close()
	if ct := resp2.Header.Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("zip content-type = %s", ct)
	}
	data, _ := io.ReadAll(resp2.Body)
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip unreadable: %v (%d bytes)", err, len(data))
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["readme.md"] || !names["sub/note.txt"] {
		t.Fatalf("zip entries missing: %v", names)
	}
	if names["img.png"] {
		t.Fatal("zip must not contain files outside share root")
	}
}

func TestFileShareDownload(t *testing.T) {
	root := fixture(t)
	token := fixedToken("f")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "img.png",
		Path: "img.png", IsDir: false, Size: 7,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	// 文件分享的 meta/list/download 都锁定该文件本身
	resp := get(t, srv.URL+"/s/"+token+"/meta")
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), `"kind":"image"`) || !strings.Contains(string(b), "img.png") {
		t.Fatalf("file share meta = %s", b)
	}

	// 目录浏览端点对文件分享应报 not_a_directory
	resp2 := get(t, srv.URL+"/s/"+token+"/list")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("file share list status = %d, want 400", resp2.StatusCode)
	}

	// 下载即文件本身
	resp3 := get(t, srv.URL+"/s/"+token+"/download")
	defer resp3.Body.Close()
	b3, _ := io.ReadAll(resp3.Body)
	if string(b3) != "PNGDATA" {
		t.Fatalf("file share download = %q", b3)
	}
}

func TestTargetMissingFriendly(t *testing.T) {
	root := fixture(t)
	token := fixedToken("g")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "gone.md",
		Path: "docs/gone.md", IsDir: false,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	// 页面仍 200（短链稳定语义），meta 探测给出 target_missing
	resp := get(t, srv.URL+"/s/"+token)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("page for missing target = %d, want 200", resp.StatusCode)
	}
	resp2 := get(t, srv.URL+"/s/"+token+"/meta")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("meta for missing target = %d, want 404", resp2.StatusCode)
	}
	b, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(b), "target_missing") {
		t.Fatalf("meta error code missing: %s", b)
	}
}

func TestProjectGone(t *testing.T) {
	token := fixedToken("h")
	shares := fakeShares{token: {
		Token: token, ProjectID: "ghost", ProjectName: "ghost", Name: "x",
		Path: "x", IsDir: false,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	resp := get(t, srv.URL+"/s/"+token+"/meta")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("meta for dead project = %d, want 410", resp.StatusCode)
	}
}

func TestNormalizeRelPath(t *testing.T) {
	okCases := map[string]string{
		"a\\b.txt":   "a/b.txt",
		"/a/b/":      "a/b",
		"a/./b/../c": "a/c",
		"":           "",
		".":          "",
		"sub/..":     "",
	}
	for in, want := range okCases {
		got, err := NormalizeRelPath(in)
		if err != nil || got != want {
			t.Errorf("NormalizeRelPath(%q) = %q, %v; want %q, nil", in, got, err, want)
		}
	}
	// 越过分享根的必须报错（不是钳制改写）；"..\a\..\b" 中途爬出根，
	// 即便净效果不越界也按拒绝处理（分享根是能力边界）
	for _, bad := range []string{"..", "..\\..\\etc", "..\\a\\..\\b", "a/../../etc", "a/b/../../../c"} {
		if got, err := NormalizeRelPath(bad); err == nil {
			t.Errorf("NormalizeRelPath(%q) = %q, want escape error", bad, got)
		}
	}
}

// markdown 渲染上限（20MB）：超限给 413/too_large（分享页呈现"仅下载"
// 提示），上限内正常渲染
func TestRenderSizeLimit(t *testing.T) {
	// 自建服务器（root 与超限文件同一份——newTestServer 的 fixture 是独立临时目录）
	root := fixture(t)
	if err := os.WriteFile(filepath.Join(root, "docs", "big.md"),
		[]byte("# big\n\n"+strings.Repeat("段落内容。", 21*1024*1024/12+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	resp := get(t, srv.URL+"/s/"+token+"/render?path=big.md")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized md render status = %d, want 413", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "too_large") {
		t.Fatalf("body = %q, want too_large", b)
	}

	// 上限内渲染语义未被破坏
	resp2 := get(t, srv.URL+"/s/"+token+"/render?path=readme.md")
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("normal md render status = %d", resp2.StatusCode)
	}
}

// /dl/{name...} 自描述下载路由：URL 即分享根内路径，原名附件；
// 越界路径与未知 token 友好拒绝
func TestDownloadPathRoute(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")

	// 文件下载：URL 以原名结尾
	resp := get(t, srv.URL+"/s/"+token+"/dl/readme.md")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("dl file status = %d", resp.StatusCode)
	}
	if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, "readme.md") {
		t.Fatalf("disposition missing original name: %s", cd)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "# Title") {
		t.Fatalf("dl body = %q", b)
	}

	// 子目录文件
	resp2 := get(t, srv.URL+"/s/"+token+"/dl/sub/note.txt")
	defer resp2.Body.Close()
	b2, _ := io.ReadAll(resp2.Body)
	if strings.TrimSpace(string(b2)) != "note content" {
		t.Fatalf("sub dl body = %q", b2)
	}

	// 越界：拒绝
	resp3 := get(t, srv.URL+"/s/"+token+"/dl/../../img.png")
	defer resp3.Body.Close()
	if resp3.StatusCode == 200 {
		t.Fatal("traversal dl must not succeed")
	}

	// 未知 token：友好 404 页
	resp4 := get(t, srv.URL+"/s/zzzzzzzzzzzzzzzz/dl/readme.md")
	defer resp4.Body.Close()
	if resp4.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown token dl status = %d", resp4.StatusCode)
	}
}

// ---- 符号链接逃逸防护（分享根是能力边界）----

// symlinkFixture 在 docs 分享根内建指向分享外（项目内 img.png 与项目外
// secret.txt）的符号链接。Windows 无符号链接权限（非开发者模式）时跳过
func symlinkFixture(t *testing.T) string {
	t.Helper()
	root := fixture(t)
	mustWrite := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("secret.txt", "TOPSECRET")
	// 分享根（docs）内的符号链接：指向项目内分享外 / 项目外绝对路径
	for _, link := range []struct{ name, target string }{
		{"leak.png", "../img.png"},
		{"abs.txt", filepath.Join(root, "secret.txt")},
	} {
		if err := os.Symlink(filepath.Join(root, link.target), filepath.Join(root, "docs", link.name)); err != nil {
			t.Skipf("symlink unavailable on this platform: %v", err)
		}
	}
	return root
}

func newSymlinkServer(t *testing.T) *httptest.Server {
	t.Helper()
	root := symlinkFixture(t)
	token := fixedToken("sym")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv
}

// 分享根内符号链接对访客不可见：列表不出现、raw/dl 404、zip 不含
func TestSymlinkEscapeRejected(t *testing.T) {
	srv := newSymlinkServer(t)
	token := fixedToken("sym")

	// 列表不出现符号链接条目
	resp := get(t, srv.URL+"/s/"+token+"/list")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(string(body), "leak.png") || strings.Contains(string(body), "abs.txt") {
		t.Fatalf("list exposed symlinks: %s", body)
	}

	// 定位/raw 一律 404（符号链接对 resolve 不可见）
	for _, ep := range []string{"meta?path=leak.png", "raw?path=leak.png", "raw?path=abs.txt"} {
		r := get(t, srv.URL+"/s/"+token+"/"+ep)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode == 200 {
			t.Fatalf("symlink %q served", ep)
		}
	}
	for _, p := range []string{"dl/leak.png", "dl/abs.txt"} {
		r := get(t, srv.URL+"/s/"+token+"/"+p)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode == 200 {
			t.Fatalf("symlink download %q served", p)
		}
	}

	// zip 不包含符号链接条目
	resp2 := get(t, srv.URL+"/s/"+token+"/download")
	data, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip unreadable: %v", err)
	}
	for _, f := range zr.File {
		if f.Name == "leak.png" || f.Name == "abs.txt" {
			t.Fatalf("zip contains symlink entry %q", f.Name)
		}
	}

	// 分享根内真实文件不受影响
	resp3 := get(t, srv.URL+"/s/"+token+"/raw?path=readme.md")
	defer resp3.Body.Close()
	if resp3.StatusCode != 200 {
		t.Fatalf("regular file broken by symlink policy: %d", resp3.StatusCode)
	}
}

// 分享根路径本身被符号链接偷换：整个分享拒绝（防 git 恶意提交把分享
// 目录替换为指向 .ssh 等敏感目录的链接）
func TestShareRootSymlinkRejected(t *testing.T) {
	root := symlinkFixture(t)
	if err := os.Symlink(filepath.Join(root, "docs"), filepath.Join(root, "docslink")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	token := fixedToken("swap")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "x",
		Path: "docslink", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	resp := get(t, srv.URL+"/s/"+token+"/meta")
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("share root swapped via symlink must be rejected")
	}
}

// 创建侧同策略：StatTarget 拒绝符号链接目标
func TestStatTargetRefusesSymlink(t *testing.T) {
	root := symlinkFixture(t)
	if _, err := StatTarget(root, "docs/leak.png"); err == nil {
		t.Fatal("StatTarget must refuse symlink target")
	}
	if _, err := StatTarget(root, "docs/readme.md"); err != nil {
		t.Fatalf("regular target rejected: %v", err)
	}
}

// 目录分享锚定收紧：分享根内的链接即使指向分享根内部其它目录也遵循
// 同一拒绝策略（策略一致性优先于"理论上安全"的链接跟随）
func TestIntraShareSymlinkPolicy(t *testing.T) {
	root := fixture(t)
	token := fixedToken("intra")
	if err := os.Symlink(filepath.Join(root, "docs", "sub"), filepath.Join(root, "docs", "sublink")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	resp := get(t, srv.URL+"/s/"+token+"/raw?path=sublink/note.txt")
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("intra-share symlink must follow the same refuse policy")
	}
}

// ---- 文本片段分享（P-20261002-71）：访客面形态与过期语义 ----

// newSnippetServer 起一个只挂 snippet 分享的测试服务（含一个已过期样本）
func newSnippetServer(t *testing.T) *httptest.Server {
	t.Helper()
	live := fixedToken("snippet")
	stale := fixedToken("stalesnippet")
	svc := NewService(fakeShares{
		live:  {Token: live, Kind: store.ShareKindSnippet, Name: "报错输出", Content: "panic: <boom>\n  at main()"},
		stale: {Token: stale, Kind: store.ShareKindSnippet, Name: "stale", Content: "old", ExpiresAt: time.Now().Add(-time.Minute)},
	}, fakeRoots{byID: map[string]string{}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func TestSnippetShareVisitorSurface(t *testing.T) {
	srv := newSnippetServer(t)
	token := fixedToken("snippet")
	base := srv.URL + "/s/" + token

	// 页面 200（片段与文件同页骨架）
	resp := get(t, base)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("page status = %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), "snippetLabel") {
		t.Fatal("page should carry snippet dict entries")
	}

	// meta：kind=snippet + 尺寸 + expiresAt
	meta := get(t, base+"/meta")
	metaBody, _ := io.ReadAll(meta.Body)
	meta.Body.Close()
	if meta.StatusCode != 200 {
		t.Fatalf("meta status = %d", meta.StatusCode)
	}
	for _, want := range []string{`"kind":"snippet"`, `"isDir":false`, `"name":"报错输出"`, "expiresAt"} {
		if !strings.Contains(string(metaBody), want) {
			t.Fatalf("meta missing %s: %s", want, metaBody)
		}
	}

	// render：代码块形态 + 正文 html 转义（<boom> 不得成为真实标签）
	render := get(t, base+"/render")
	renderBody, _ := io.ReadAll(render.Body)
	render.Body.Close()
	if render.StatusCode != 200 {
		t.Fatalf("render status = %d", render.StatusCode)
	}
	rendered := string(renderBody)
	if !strings.HasPrefix(strings.TrimSpace(rendered), "<pre><code>") {
		t.Fatalf("render should be a bare code block: %q", rendered)
	}
	if !strings.Contains(rendered, "panic: &lt;boom&gt;") || strings.Contains(rendered, "<boom>") {
		t.Fatalf("snippet content must be html-escaped: %s", rendered)
	}

	// raw：text/plain 原文逐字取回
	raw := get(t, base+"/raw")
	rawBody, _ := io.ReadAll(raw.Body)
	raw.Body.Close()
	if raw.StatusCode != 200 || string(rawBody) != "panic: <boom>\n  at main()" {
		t.Fatalf("raw = %d %q", raw.StatusCode, rawBody)
	}
	if ct := raw.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("raw content-type = %s, want text/plain", ct)
	}

	// 下载/列表对片段无意义：拒绝且不 panic
	for _, ep := range []string{"download", "list", "dl/whatever"} {
		d := get(t, base+"/"+ep)
		_, _ = io.Copy(io.Discard, d.Body)
		d.Body.Close()
		if d.StatusCode == 200 {
			t.Fatalf("snippet %s must not succeed", ep)
		}
	}
}

func TestSnippetShareExpired(t *testing.T) {
	srv := newSnippetServer(t)
	stale := fixedToken("stalesnippet")
	base := srv.URL + "/s/" + stale

	// 首踩（页面）：410 Gone 明确「已过期」文案（P-20261003-29 起不再与
	// 404 混同——收件人要能区分「敲错链接」与「有效期已到」）
	resp := get(t, base)
	pageBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("expired snippet page status = %d, want 410", resp.StatusCode)
	}
	if !strings.Contains(string(pageBody), "This link has expired") || !strings.Contains(string(pageBody), "410") {
		t.Fatalf("expired page should carry expired copy and 410 code: %s", pageBody)
	}

	// 首踩已惰性删除：后续探测端点回落 404（与不存在同观感），不再 410
	for _, ep := range []string{"/meta", "/render", "/raw"} {
		r2 := get(t, base+ep)
		_, _ = io.Copy(io.Discard, r2.Body)
		r2.Body.Close()
		if r2.StatusCode != http.StatusNotFound {
			t.Fatalf("evicted snippet %q status = %d, want 404", ep, r2.StatusCode)
		}
	}
}

// TestShareExpiredJSONCode JSON 端点首踩 410 的错误码（share_expired）——
// 惰性删除前的一次性观测口
func TestShareExpiredJSONCode(t *testing.T) {
	stale := fixedToken("stalesnippet")
	svc := NewService(fakeShares{
		stale: {Token: stale, Kind: store.ShareKindSnippet, Name: "stale", Content: "old", ExpiresAt: time.Now().Add(-time.Minute)},
	}, fakeRoots{byID: map[string]string{}}, nil)
	ts := httptest.NewServer(svc.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/s/" + stale + "/meta")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("expired meta status = %d, want 410", resp.StatusCode)
	}
	if !strings.Contains(string(body), "share_expired") {
		t.Fatalf("expired meta should carry share_expired code: %s", body)
	}
}

// TestShareExpiredLazyEvict 访客首踩即惰性删除（P-20261003-29）：清理 ticker
// 有周期间隙，过期记录不允许在间隙内被反复命中（opt-in TTL 的文件分享同管线）
func TestShareExpiredLazyEvict(t *testing.T) {
	stale := fixedToken("stalesnippet")
	shares := fakeShares{
		stale: {Token: stale, Kind: store.ShareKindFile, ProjectID: "p1", Name: "docs", Path: "docs", IsDir: true,
			ExpiresAt: time.Now().Add(-time.Minute)},
	}
	direct := NewService(shares, fakeRoots{byID: map[string]string{"p1": t.TempDir()}}, nil)
	ts := httptest.NewServer(direct.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/s/" + stale)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("expired file share status = %d, want 410", resp.StatusCode)
	}
	if _, ok := shares[stale]; ok {
		t.Fatal("expired record must be lazy-evicted on first guest hit")
	}
	// 记录已删：再次访问回落 404（与不存在同观感），不再重复 410
	resp2, err := http.Get(ts.URL + "/s/" + stale)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("evicted token status = %d, want 404", resp2.StatusCode)
	}
}

// ---- 全端点 × 攻击载荷矩阵（回归门禁）----
// 分享根（docs）内只允许 docs/readme.md、docs/sub、docs/sub/note.txt；
// 任何端点对载荷返回 200 都必须对应分享根内的真实内容

func TestAllEndpointsTraversalMatrix(t *testing.T) {
	srv := newTestServer(t)
	token := fixedToken("tok")
	base := srv.URL + "/s/" + token

	// payloads：经典穿越 / 编码穿越 / 反斜杠 / 绝对路径 / 空段 /
	// Windows 保留名形态 / 中途爬出再回落
	traversal := []string{
		"../img.png", "..%2fimg.png", "%2e%2e%2fimg.png", "%2e%2e/img.png",
		"..%5cimg.png", "..\\img.png", "sub/../../img.png", "sub/..%2f..%2fimg.png",
		"a/b/../../../img.png", "/../img.png", "./../img.png", "....//img.png",
		"sub/../../../app.exe", "%252e%252e%252fimg.png", "..%00/img.png",
		"docs/../img.png", "docs/img.png", "img.png", "app.exe", "secret",
		"C:/Windows/win.ini", "\\\\server\\share\\f", "/etc/passwd", "NUL",
	}
	endpoints := []struct {
		ep          string
		pathInQuery bool
	}{
		{"meta", true}, {"list", true}, {"render", true},
		{"raw", true}, {"download", true},
	}
	for _, e := range endpoints {
		for _, p := range traversal {
			u := base + "/" + e.ep + "?path=" + p
			resp := get(t, u)
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				// 唯一合法的 200 形态：payload 归一后仍在分享根内。
				// 上表所有载荷都指向分享根之外，200 即为逃逸
				t.Errorf("%s?path=%q escaped share root (status 200)", e.ep, p)
			}
			if bytes.Contains(body, []byte("PNGDATA")) || bytes.Contains(body, []byte("MZbinary")) {
				t.Errorf("%s?path=%q leaked outside content", e.ep, p)
			}
		}
	}
	// /dl/{name...} 路由形态（net/http 会先清洗 ../ 段，聚焦编码与绝对形态）
	for _, p := range []string{"..%2fimg.png", "%2e%2e%2fimg.png", "..%5cimg.png",
		"%252e%252e%252fimg.png", "C:%5cWindows%5cwin.ini", "%2fetc%2fpasswd"} {
		resp := get(t, base+"/dl/"+p)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 || bytes.Contains(body, []byte("PNGDATA")) {
			t.Errorf("dl/%q escaped share root", p)
		}
	}
	// 合法路径仍然工作（防矩阵误伤正常语义）
	for _, ok := range []string{"meta?path=", "list?path=", "raw?path=readme.md", "download?path=sub/note.txt"} {
		resp := get(t, base+"/"+ok)
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != 200 {
			t.Errorf("legitimate %q broken: %d", ok, resp.StatusCode)
		}
		resp.Body.Close()
	}
}
