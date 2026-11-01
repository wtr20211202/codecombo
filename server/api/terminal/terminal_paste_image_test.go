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
)

// 粘贴上传端点（P-20261024-2 通用化）单测：
//   - file 形态（paste 事件 Files）：白名单扩展名落盘 sc-paste-*.<ext>、内容一致
//   - image 形态（截图 blob）既有语义回归：Content-Type 白名单 → .png，旧前端兼容
//   - 白名单外扩展名 / 双字段全缺 400；validatePasteFile 大小上限（纯函数，免造 20MB 体）
//   - createUniquePasteFile 同名碰撞 -1 后缀步进 + O_EXCL 不覆盖既有文件

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

// validatePasteFile 纯函数矩阵：大小上限按 header.Size 判（免造 20MB 真实体）、
// 扩展名 lowercase 归一
func TestValidatePasteFile(t *testing.T) {
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.md", Size: 1}); err != nil {
		t.Fatalf(".md should pass: %v", err)
	}
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "A.JPG", Size: 1}); err != nil {
		t.Fatalf("uppercase ext should normalize to pass: %v", err)
	}
	big := int64(pasteFileMaxBytes) + 1
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.zip", Size: big}); err == nil {
		t.Fatal("oversized file should be rejected")
	}
	if _, err := validatePasteFile(&multipart.FileHeader{Filename: "a.sh", Size: pasteFileMaxBytes}); err != nil {
		t.Fatalf("size == cap should pass: %v", err)
	}
}

func TestCreateUniquePasteFileCollision(t *testing.T) {
	dir := t.TempDir()
	taken := filepath.Join(dir, "sc-paste-1700000000000.png")
	if err := os.WriteFile(taken, []byte("occupied"), 0600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	f, full, err := createUniquePasteFile(dir, "sc-paste-1700000000000.png")
	if err != nil {
		t.Fatalf("createUniquePasteFile: %v", err)
	}
	defer f.Close()
	defer os.Remove(full)
	if full != filepath.Join(dir, "sc-paste-1700000000000-1.png") {
		t.Fatalf("collision should step to -1 suffix, got %s", full)
	}
	// O_EXCL：不覆盖既有文件（occupied 内容原样）
	got, err := os.ReadFile(taken)
	if err != nil || string(got) != "occupied" {
		t.Fatalf("existing file must not be overwritten: %v %q", err, got)
	}
}
