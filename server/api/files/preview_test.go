package files

// ── 项目文件直接预览 API 测试（P-20261119-4 S2） ──
//
// handler 级 characterization + 安全面钉死：路径越界/净化链产物/映射簿
// 白名单/Range/CSP 红线/敏感读取审计。auth 门控与 ReadFile 同组注册
//（router.go api 组四中间件），组级面在 router 层不属 handler 单测面。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/config"
	fx "codecombo/server/filepreview/fixtures"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupPreviewTest 预览端点测试环境（file_test.go setupFileOpsTest 同款装配：
// 临时数据目录隔离 store + 项目登记 proj-test → TempDir；只挂本族路由——
// auth 中间件在 router.go api 组，handler 单测面不含）
func setupPreviewTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "proj-test"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-test",
		Name: "test",
		Path: root,
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	g := r.Group("/api/projects/:id")
	{
		g.GET("/file/preview", GetFilePreview)
		g.GET("/file/raw", GetFileRaw)
		g.GET("/file/rel/*rel", GetFileRel)
		g.GET("/file/media", GetFileMedia)
		g.GET("/file/embed", GetFileEmbed)
		g.GET("/file/htmlview", GetFileHtmlView)
		g.GET("/file-policy", GetFilePolicy)
	}
	return r, root
}

func doGet(t *testing.T, r *gin.Engine, url string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	r.ServeHTTP(w, req)
	return w
}

// buildDocxWithImage 构造带一张 PNG 的 docx（media 端点白名单用例的取材）
func buildDocxWithImage(t *testing.T) []byte {
	t.Helper()
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/photo.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + `</w:body></w:document>`
	return fx.BuildDocxFull(t, doc, rels, map[string][]byte{"word/media/photo.png": fx.PNGTestBytes})
}

func TestFilePreview_PathTraversalRejected(t *testing.T) {
	r, _ := setupPreviewTest(t)
	for _, ep := range []string{"preview", "raw", "media", "embed", "htmlview"} {
		w := doGet(t, r, "/api/projects/proj-x/file/"+ep+"?path=../outside.txt")
		if w.Code == http.StatusOK {
			t.Fatalf("%s: traversal must not succeed, got %d %s", ep, w.Code, w.Body.String())
		}
	}
}

func TestFilePreview_MissingPathRejected(t *testing.T) {
	r, _ := setupPreviewTest(t)
	w := doGet(t, r, "/api/projects/proj-test/file/preview")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestFilePreview_CSVRenderedSanitized(t *testing.T) {
	r, root := setupPreviewTest(t)
	// 净化链钉死：csv 单元格里的脚本面必须转义出无功能力的文本
	if err := os.WriteFile(filepath.Join(root, "data.csv"),
		[]byte("name,tip\nalice,<script>alert(1)</script>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/preview?path=data.csv&lang=en")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Kind string `json:"kind"`
			HTML string `json:"html"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Kind != "csv" {
		t.Fatalf("kind = %s, want csv", body.Data.Kind)
	}
	if !strings.Contains(body.Data.HTML, "<table>") || !strings.Contains(body.Data.HTML, "alice") {
		t.Fatalf("csv table missing:\n%s", body.Data.HTML)
	}
	if strings.Contains(strings.ToLower(body.Data.HTML), "<script>") {
		t.Fatalf("script tag must be escaped:\n%s", body.Data.HTML)
	}
}

func TestFilePreview_MdKindOnlyNoPayload(t *testing.T) {
	// 必改2 定案 (a)：md 只回 kind 不产 payload——前端预览复用既有
	// marked+DOMPurify 管线，服务端 md 渲染零新增（双实现消失）
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/preview?path=README.md")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body struct {
		Data struct {
			Kind string `json:"kind"`
			HTML string `json:"html"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Kind != "markdown" {
		t.Fatalf("kind = %s, want markdown", body.Data.Kind)
	}
	if body.Data.HTML != "" {
		t.Fatalf("md must not carry server payload (必改2a), got %.80s", body.Data.HTML)
	}
}

func TestFilePreview_DocxPayloadWithMediaURLs(t *testing.T) {
	r, root := setupPreviewTest(t)
	pkg := buildDocxWithImage(t)
	if err := os.WriteFile(filepath.Join(root, "report.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/preview?path=report.docx&lang=en")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Kind string `json:"kind"`
			HTML string `json:"html"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Kind != "docx" || body.Data.HTML == "" {
		t.Fatalf("docx payload missing: kind=%s html=%.80s", body.Data.Kind, body.Data.HTML)
	}
	// MediaURLs 注入（评审建议1）：img src 指向主应用 media 端点（非 /s/{token}）
	if !strings.Contains(body.Data.HTML, "/api/projects/proj-test/file/media?path=report.docx") {
		t.Fatalf("img src must target api media endpoint:\n%s", body.Data.HTML)
	}
}

func TestFilePreview_LangParamZombie(t *testing.T) {
	// 必改3c：lang 参数化——zh 词典进占位块文案
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "data.csv"), []byte("a,b\n1,2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/preview?path=data.csv&lang=zh")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"kind":"csv"`) {
		t.Fatalf("status=%d body=%.120s", w.Code, w.Body.String())
	}
}

func TestFileMedia_WhitelistOnly(t *testing.T) {
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "report.docx"), buildDocxWithImage(t), 0o644); err != nil {
		t.Fatal(err)
	}
	// 白名单命中：PNG 魔数字节按 image/png 供给 + Range 支持
	w := doGet(t, r, "/api/projects/proj-test/file/media?path=report.docx&m=word%2Fmedia%2Fphoto.png")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("status=%d type=%s", w.Code, w.Header().Get("Content-Type"))
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte{0x89, 'P', 'N', 'G'}) {
		t.Fatalf("body must be png bytes, got %.16x", w.Body.Bytes())
	}
	// 白名单外（未被 rels 引用的任意条目名）：404——映射簿是唯一准入
	w2 := doGet(t, r, "/api/projects/proj-test/file/media?path=report.docx&m=word%2Fmedia%2Fevil.png")
	if w2.Code != http.StatusNotFound {
		t.Fatalf("whitelist miss must 404, got %d", w2.Code)
	}
}

func TestFileEmbed_AttachmentBaselineAndPreviewWhitelist(t *testing.T) {
	r, root := setupPreviewTest(t)
	// .bin 嵌入（白名单外）恒 attachment；.html 嵌入 preview=1 出净化正文
	bin := fx.Ole10FlaggedPayload(fx.GbkSampleName, 600)
	rels := fx.RelsShell +
		fx.EmbedRel("rBin", "oleObject", "embeddings/oleObject1.bin") +
		fx.EmbedRel("rHtml", "package", "embeddings/attached.html")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rBin", "Package") + fx.ObjectXML("", "rHtml", "Package") + `</w:body></w:document>`
	htmlBody := []byte("<!doctype html><html><body><p>ok</p></body></html>")
	pkg := fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/embeddings/oleObject1.bin": fx.BuildCFB(t, 512, bin, true, nil),
		"word/embeddings/attached.html":  htmlBody,
	})
	if err := os.WriteFile(filepath.Join(root, "spec.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	// .bin 基线：恒 attachment + octet-stream（P-7 红线）
	w := doGet(t, r, "/api/projects/proj-test/file/embed?path=spec.docx&e=word%2Fembeddings%2FoleObject1.bin")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("bin embed: status=%d type=%s", w.Code, w.Header().Get("Content-Type"))
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf("bin embed must be attachment, got %q", cd)
	}
	// .bin + preview=1：白名单外参数忽略回归 attachment
	w2 := doGet(t, r, "/api/projects/proj-test/file/embed?path=spec.docx&e=word%2Fembeddings%2FoleObject1.bin&preview=1")
	if w2.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("bin preview=1 must fall back to attachment, got %s", w2.Header().Get("Content-Type"))
	}
	// .html + preview=1：白名单命中出净化正文（text/html）+ CSP sandbox + XFO SAMEORIGIN
	w3 := doGet(t, r, "/api/projects/proj-test/file/embed?path=spec.docx&e=word%2Fembeddings%2Fattached.html&preview=1")
	if w3.Code != http.StatusOK || w3.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("html preview: status=%d type=%s", w3.Code, w3.Header().Get("Content-Type"))
	}
	if !bytes.Equal(w3.Body.Bytes(), htmlBody) {
		t.Fatalf("html preview body must be extracted verbatim, got %.60q", w3.Body.Bytes())
	}
	if csp := w3.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
		t.Fatalf("html preview CSP = %q, want sandbox prefix", csp)
	}
	if xfo := w3.Header().Get("X-Frame-Options"); xfo != "SAMEORIGIN" {
		t.Fatalf("html preview XFO = %q", xfo)
	}
	// 白名单外 e=：404
	w4 := doGet(t, r, "/api/projects/proj-test/file/embed?path=spec.docx&e=word%2Fembeddings%2Fnope.bin")
	if w4.Code != http.StatusNotFound {
		t.Fatalf("embed whitelist miss must 404, got %d", w4.Code)
	}
	// ui=1&full=1 全幅预览模式（P-20261120-2 顺带断言）：share/api 共享同一
	// 壳页模板（filepreview.ServeEmbedShell 一处生效双侧受益）——api 侧同
	// 处生效：header 不渲染、iframe+浮动退出钮在场
	w5 := doGet(t, r, "/api/projects/proj-test/file/embed?path=spec.docx&e=word%2Fembeddings%2Fattached.html&ui=1&full=1")
	if w5.Code != http.StatusOK || w5.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("html embed full shell: status=%d type=%s", w5.Code, w5.Header().Get("Content-Type"))
	}
	if body := w5.Body.String(); !strings.Contains(body, `class="shell-frame"`) ||
		!strings.Contains(body, `class="shell-full-exit"`) || strings.Contains(body, "<header") {
		t.Fatalf("full shell must render iframe+exit button and drop header, got %.300q", body)
	}
}

func TestFileRaw_RangeAndCSP(t *testing.T) {
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "movie.bin"), bytes.Repeat([]byte("abcd"), 1024), 0o644); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/file/raw?path=movie.bin", nil)
	req.Header.Set("Range", "bytes=0-3")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPartialContent {
		t.Fatalf("Range must yield 206, got %d", w.Code)
	}
	if w.Body.String() != "abcd" {
		t.Fatalf("range body = %.8q", w.Body.String())
	}
	// CSP sandbox：任意字节内联面脚本全禁（.html 改名 .bin 同样不获本源脚本）
	if csp := w.Header().Get("Content-Security-Policy"); csp != "sandbox" {
		t.Fatalf("raw CSP = %q, want sandbox", csp)
	}
}

func TestFileRaw_UnknownBinaryStillServedWithAttachmentSafeType(t *testing.T) {
	// 未注册后缀：raw 按 application/octet-stream 兜底（ForFile 判定），
	// 「真未知格式打开=信息卡+下载」的字节面
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "blob.xyz42"), []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/raw?path=blob.xyz42")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type = %q, want octet-stream", ct)
	}
}

func TestFileHtmlView_BaseInjectionAndScriptRedLine(t *testing.T) {
	r, root := setupPreviewTest(t)
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "page.html"),
		[]byte("<html><head><title>t</title></head><body><img src='pic.png'></body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 默认：CSP sandbox（脚本全禁）+ <base> 指向 rel 通配端点（评审必改3b）
	w := doGet(t, r, "/api/projects/proj-test/file/htmlview?path=docs%2Fpage.html")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	if csp := w.Header().Get("Content-Security-Policy"); csp != "sandbox" {
		t.Fatalf("default CSP = %q, want bare sandbox", csp)
	}
	if !strings.Contains(w.Body.String(), `/api/projects/proj-test/file/rel/docs/`) {
		t.Fatalf("base href must target rel endpoint:\n%s", w.Body.String())
	}
	// scripts=1 opt-in：只加 allow-scripts，绝不 allow-same-origin（硬红线）
	w2 := doGet(t, r, "/api/projects/proj-test/file/htmlview?path=docs%2Fpage.html&scripts=1")
	if csp := w2.Header().Get("Content-Security-Policy"); csp != "sandbox allow-scripts" {
		t.Fatalf("opt-in CSP = %q, want sandbox allow-scripts", csp)
	}
	// 非 html 目标：415
	w3 := doGet(t, r, "/api/projects/proj-test/file/htmlview?path=docs%2Fnope.html")
	if w3.Code != http.StatusNotFound {
		t.Fatalf("missing html must 404, got %d", w3.Code)
	}
}

func TestFilePolicy_PreviewDescriptorPresent(t *testing.T) {
	// file-policy 增量 pv 字段（前端双视图分流判定源）：docx → kind=docx、
	// 未知二进制 → kind=info；加法字段零回归
	r, root := setupPreviewTest(t)
	if err := os.WriteFile(filepath.Join(root, "report.docx"), buildDocxWithImage(t), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file-policy?path=report.docx")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Kind string `json:"kind"`
			Pv   struct {
				Kind string `json:"kind"`
				Mime string `json:"mime"`
			} `json:"pv"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Kind != "binary" || body.Data.Pv.Kind != "docx" {
		t.Fatalf("policy = %+v, want kind binary + pv docx", body.Data)
	}
}

// TestFileRel_ServesSubresource 路径形态回源端点（评审必改3b）：htmlview 的
// <base href> 落点按 URL 层级服务相对 css/img；穿越尝试在解码后仍被
// SafeJoinProject 拒（引号/百分号编码的 .. 同一条防线）
func TestFileRel_ServesSubresource(t *testing.T) {
	r, root := setupPreviewTest(t)
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "pic.png"), fx.PNGTestBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/projects/proj-test/file/rel/docs/pic.png")
	if w.Code != http.StatusOK {
		t.Fatalf("rel serve status = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("rel content-type = %q, want image/png", ct)
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte{0x89, 'P', 'N', 'G'}) {
		t.Fatalf("rel body must be png bytes, got %.16x", w.Body.Bytes())
	}
	// 编码形态的 ../：解码后走同一 SafeJoinProject 防线（<base> 子资源
	// 不能成为越界读通道）
	w2 := doGet(t, r, "/api/projects/proj-test/file/rel/%2e%2e/outside.txt")
	if w2.Code == http.StatusOK {
		t.Fatalf("encoded traversal must not succeed, got %d", w2.Code)
	}
}

// TestFilePreview_LangPlaceholder 评审必改3c：渲染端点上 lang 参数穿透到
// docx 占位块词典（zh/en 两语境文案互异——主应用语境不串英文/分享语境
// 不串中文）；占位块取材=悬空 media 关系（映射簿命中不了条目）
func TestFilePreview_LangPlaceholder(t *testing.T) {
	r, root := setupPreviewTest(t)
	rels := fx.RelsShell + fx.ImgRel("rIdGone", "media/gone.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rIdGone") + `</w:body></w:document>`
	if err := os.WriteFile(filepath.Join(root, "dangling.docx"), fx.BuildDocxFull(t, doc, rels, nil), 0o644); err != nil {
		t.Fatal(err)
	}
	get := func(lang string) string {
		w := doGet(t, r, "/api/projects/proj-test/file/preview?path=dangling.docx&lang="+lang)
		if w.Code != http.StatusOK {
			t.Fatalf("lang=%s status = %d %s", lang, w.Code, w.Body.String())
		}
		var body struct {
			Data struct {
				HTML string `json:"html"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Data.HTML
	}
	if zh := get("zh"); !strings.Contains(zh, "图片未随预览内嵌") {
		t.Fatalf("zh placeholder missing:\n%s", zh)
	}
	if en := get("en"); !strings.Contains(en, "Image not shown in preview") {
		t.Fatalf("en placeholder missing:\n%s", en)
	}
}

// TestFilePreview_SensitiveReadAudited 六端点全过敏感读取审计（评审建议4；
// raw 等同下载面尤其不可漏）：预览/字节两条读取面对 .env 的读各入账一条
// （同一去重窗口内同路径只记一次——与 ReadFile 共享同一张去重表语义）
func TestFilePreview_SensitiveReadAudited(t *testing.T) {
	r, root := setupPreviewTest(t)
	sensitiveReadTable = sensitiveReadDedup{} // 全局去重表按用例隔离（同包先例）
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("TOPSECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, ep := range []string{"preview", "raw"} {
		w := doGet(t, r, "/api/projects/proj-test/file/"+ep+"?path=.env")
		if w.Code != http.StatusOK {
			t.Fatalf("%s status = %d %s", ep, w.Code, w.Body.String())
		}
	}
	events := sensitiveReadEvents(t)
	if len(events) != 1 {
		t.Fatalf("sensitive read events = %d, want 1 (dedup window)", len(events))
	}
	if !strings.Contains(events[0].Detail, ".env") {
		t.Fatalf("audit detail must carry path, got %q", events[0].Detail)
	}
}
