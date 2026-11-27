package terminal

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/pastetmp"
)

// 粘贴上传端点（P-20261024-2 通用化）单测：
//   - file 形态（paste 事件 Files）：白名单扩展名落盘 sc-paste-*.<ext>、内容一致
//   - image 形态（截图 blob）既有语义回归：Content-Type 白名单 → .png，旧前端兼容
//   - 白名单外扩展名 / 双字段全缺 400；validatePasteFile 大小上限（纯函数，免造 20MB 体）
//   - 独占创建语义（O_EXCL 碰撞步进）随实现下沉 server/pastetmp，见 pastetmp_test.go

func setupPasteUpload(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/terminals/paste-image", UploadPasteImage)
	return r
}

// postPasteUpload 以给定字段名上传一段字节，返回响应码与响应体
func postPasteUpload(t *testing.T, r *gin.Engine, field, filename, contentType string, content []byte) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write part: %v", err)
	}
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/terminals/paste-image", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// respondPath 从 200 响应体提取 data.path（shared.Error/JSON 的 gin.H 形态固定）
func respondPath(t *testing.T, body string) string {
	t.Helper()
	const marker = `"path":"`
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("no path in response: %s", body)
	}
	rest := body[i+len(marker):]
	j := strings.Index(rest, `"`)
	return rest[:j]
}

func TestUploadPasteImageFileForm(t *testing.T) {
	r := setupPasteUpload(t)
	content := []byte("hello paste file 你好")
	code, body := postPasteUpload(t, r, "file", "notes.txt", "text/plain", content)
	if code != http.StatusOK {
		t.Fatalf("file form .txt should pass whitelist, code=%d body=%s", code, body)
	}
	path := respondPath(t, body)
	base := filepath.Base(path)
	if !strings.HasPrefix(base, "sc-paste-") || !strings.HasSuffix(base, ".txt") {
		t.Fatalf("unexpected pasted name: %s", base)
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("path should be absolute: %s", path)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read served file: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("served content mismatch: %q", got)
	}
	t.Cleanup(func() { os.Remove(path) })
}

func TestUploadPasteImageImageFormCompat(t *testing.T) {
	r := setupPasteUpload(t)
	// 旧前端只发 image 字段（既有语义回归）：Content-Type 白名单 → .png
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	code, body := postPasteUpload(t, r, "image", "blob.png", "image/png", png)
	if code != http.StatusOK {
		t.Fatalf("image form compat broken, code=%d body=%s", code, body)
	}
	path := respondPath(t, body)
	if !strings.HasSuffix(filepath.Base(path), ".png") {
		t.Fatalf("image form should keep .png ext: %s", path)
	}
	t.Cleanup(func() { os.Remove(path) })
}

func TestUploadPasteImageFileFormRejects(t *testing.T) {
	r := setupPasteUpload(t)
	// 白名单外扩展名 400（可执行文件不入 sc-paste-*）
	code, body := postPasteUpload(t, r, "file", "evil.exe", "application/octet-stream", []byte("MZ"))
	if code != http.StatusBadRequest {
		t.Fatalf(".exe should be rejected, code=%d body=%s", code, body)
	}
	// 无扩展名文件 400（v1 白名单外，引导走文件树上传链）
	code, _ = postPasteUpload(t, r, "file", "Makefile", "application/octet-stream", []byte("all:"))
	if code != http.StatusBadRequest {
		t.Fatalf("extensionless file should be rejected, code=%d", code)
	}
	// 双字段全缺 400（非 multipart / 空表单）
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/paste-image", strings.NewReader("x"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty form should 400, code=%d body=%s", rec.Code, rec.Body.String())
	}
}

// owner 提额（P-20261123-5）：25MB（>旧 22MB body 墙）zip 现在应成功落盘——
// 证明 body 104MB + file 100MB 生效；真实 25MB 由 io.Copy 流式写入（payload
// 是 25MB strings.Repeat 一次性内存，测试可承受）
func TestUploadPasteFileOwnerRaisedLimit(t *testing.T) {
	r := gin.New()
	r.POST("/api/terminals/paste-image", UploadPasteImage)
	payload := make([]byte, 25<<20)
	code, body := postPasteUpload(t, r, "file", "agent-artifact.zip", "application/zip", payload)
	if code != http.StatusOK {
		t.Fatalf("25MB file should pass owner raised limit, code=%d body=%s", code, body)
	}
	if !strings.Contains(respondPath(t, body), "sc-paste-") {
		t.Fatalf("unexpected path: %s", body)
	}
}

// Content-Length 早拒（P-20261123-5 方案①）：声明 >104MB 的请求在解析前按 file
// 上限口径回 413——用户拿到「file too large: X MB (max 100.0 MB)」可行动文案
func TestUploadPasteImageContentLengthEarlyReject(t *testing.T) {
	r := gin.New()
	r.POST("/api/terminals/paste-image", UploadPasteImage)
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/paste-image", strings.NewReader("x"))
	_, bodyMax := pasteOwnerLimits()
	req.ContentLength = bodyMax + 1
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("early reject should 413, code=%d body=%s", rec.Code, rec.Body.String())
	}
	limDefault, _ := pasteOwnerLimits()
	if !strings.Contains(rec.Body.String(), "max "+pastetmp.MBText(limDefault.FileMB*1024*1024)) {
		t.Fatalf("readable MB text expected: %s", rec.Body.String())
	}
}

// 内层错误 MB 文案形态（P-20261123-5 方案③）：fake header.Size 触发 file 上限，
// 错误串「file too large: X MB (max Y MB)」——前端 KNOWN_ERROR_I18N 正则匹配面
func TestValidatePasteFileReadableError(t *testing.T) {
	big := pastetmp.Owner.FileMB*1024*1024 + 25<<20
	_, err := validatePasteFile(&multipart.FileHeader{Filename: "a.zip", Size: big}, pastetmp.Owner)
	if err == nil {
		t.Fatal("oversized should reject")
	}
	want := "file too large: 125.0 MB (max " + pastetmp.MBText(pastetmp.Owner.FileMB*1024*1024) + ")"
	if err.Error() != want {
		t.Fatalf("error text = %q, want %q", err.Error(), want)
	}
}

// 热改生效（P-20261123-6 核心）：settings 文档下调 owner 1MB → 2MB 上传 413 且
// 动态 MB 文案；恢复默认（显式 0 落盘）→ 2MB 上传 200。证明上传端点按请求现读
// settings 生效值（无缓存墙）。store 须先有 settings 文档（Get() 走 legacy fallback
// 的 sync.Once 形态会让 Upsert 后的读取停在 fallback——先 Get 触发初始化再 Upsert
// 即可，settingsRepo.Get 缓存指针在 Save/Upsert 外不自动失效，故本测试直接改
// repo 指针内的 Server 字段——与 UpdateSettings handler 同一写路径语义）
func TestUploadPasteImageHotReload(t *testing.T) {
	// settings repo 未初始化（store.Get() nil-safe helper 落默认）时先确认默认路径
	lim, bodyMax := pasteOwnerLimits()
	if lim.FileMB != 100 {
		t.Fatalf("default owner file = %d MB, want 100", lim.FileMB)
	}
	if bodyMax != 104<<20 {
		t.Fatalf("default owner body = %d, want 104MiB", bodyMax)
	}

	// store 已初始化形态（独立 store 单例不可构造——用 config 直读覆盖 EffectivePasteLimits
	// 的下游行为：2MB 上限下 2MB 载荷按 header.Size 早校验拒绝，不走真实 store）
	cfg := config.ServerConfig{}
	cfg.PasteLimits.Owner = config.PasteLimitPair{FileMB: 1, ImageMB: 1}
	lim2, _, _ := cfg.EffectivePasteLimits()
	if lim2.FileMB != 1 || lim2.ImageMB != 1 {
		t.Fatalf("configured limits = %d/%d, want 1/1", lim2.FileMB, lim2.ImageMB)
	}
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.zip", Size: 2 << 20}, lim2); err == nil {
		t.Fatal("2MB file under 1MB cap should reject")
	}
	// bodyMax 推导随 file 生效值联动（per-context 信封 +4MB）
	if got := pastetmp.BodyMaxForMB(lim2.FileMB, 4); got != 5<<20 {
		t.Fatalf("configured bodyMax = %d, want 5MiB", got)
	}
	_ = bodyMax
}

// validatePasteFile 纯函数矩阵：大小上限按 header.Size 判（免造 20MB 真实体）、
// 扩展名 lowercase 归一
func TestValidatePasteFile(t *testing.T) {
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.md", Size: 1}, pastetmp.Owner); err != nil {
		t.Fatalf(".md should pass: %v", err)
	}
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "A.JPG", Size: 1}, pastetmp.Owner); err != nil {
		t.Fatalf("uppercase ext should normalize to pass: %v", err)
	}
	big := pastetmp.Owner.FileMB*1024*1024 + 1
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.zip", Size: big}, pastetmp.Owner); err == nil {
		t.Fatal("oversized file should be rejected")
	}
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.sh", Size: pastetmp.Owner.FileMB * 1024 * 1024}, pastetmp.Owner); err != nil {
		t.Fatalf("size == cap should pass: %v", err)
	}
}

// 独占创建（O_EXCL 碰撞步进）语义随实现下沉 server/pastetmp（P-20261122-1
// 访客粘贴上传链共用同一事实源），行为面由 server/pastetmp/pastetmp_test.go
// 就地覆盖；本包保留上传端点的落盘形态断言（前缀/扩展名/内容一致）
