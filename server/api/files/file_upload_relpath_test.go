package files

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// upload 子路径形态（P-20261023-2）行为锚定：multipart filename 按 RFC 7578 被
// Go 解析层剥成 basename，子路径经旁挂 form 字段 paths（JSON 数组，与 files 逐序
// 对齐）携带——按段自动建目录落盘；路径穿越段（..）与盘符/数据流段（:）在清洗
// 层拒绝；旁挂字段缺省时回落 filename 语义零变化（假路径前缀照旧剥除）。

// doUploadRelPath 发一次携旁挂 paths 字段的上传（relPath 为空 = 只传 filename；
// query 形如 "?dest=pkg"）
func doUploadRelPath(t *testing.T, r *gin.Engine, filename, relPath, content, query string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("files", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if relPath != "" {
		if err := mw.WriteField("paths", relPath); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/proj-upload/file/upload"+query, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestUploadFiles_SubPath_CreatesDirs 子路径旁挂字段：dest 下按段建目录、文件
// 落位、saved 回显相对路径
func TestUploadFiles_SubPath_CreatesDirs(t *testing.T) {
	r, projPath := setupUploadTest(t)

	w := doUploadRelPath(t, r, "a.txt", `["pkg/sub/deep/a.txt"]`, "content-a", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Saved) != 1 || resp.Saved[0] != "pkg/sub/deep/a.txt" {
		t.Fatalf("saved = %v", resp.Saved)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "pkg", "sub", "deep", "a.txt"))
	if err != nil || string(got) != "content-a" {
		t.Fatalf("pkg/sub/deep/a.txt = %q (err=%v)", got, err)
	}
	// dest 组合：子路径相对 dest 落位
	if w := doUploadRelPath(t, r, "b.txt", `["inner/b.txt"]`, "content-b", "?dest=pkg"); w.Code != http.StatusOK {
		t.Fatalf("dest upload status = %d", w.Code)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "pkg", "inner", "b.txt")); err != nil || string(got) != "content-b" {
		t.Fatalf("pkg/inner/b.txt = %q (err=%v)", got, err)
	}
}

// TestUploadFiles_RelPathsLengthMismatch 旁挂字段长度与 files 失配：新调用方
// bug 显式 400，绝不静默错落
func TestUploadFiles_RelPathsLengthMismatch(t *testing.T) {
	r, _ := setupUploadTest(t)
	if w := doUploadRelPath(t, r, "a.txt", `["x.txt","y.txt"]`, "c", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// TestUploadFiles_TraversalRejected 穿越段与盘符段拒绝：.. 段、含 : 段一律
// skipped「invalid filename」，项目外零落盘
func TestUploadFiles_TraversalRejected(t *testing.T) {
	r, projPath := setupUploadTest(t)

	for _, rel := range []string{`["../escape.txt"]`, `["sub/../../escape.txt"]`, `["sub/steam:x.txt"]`} {
		w := doUploadRelPath(t, r, "f.txt", rel, "evil", "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", rel, w.Code)
		}
		var resp uploadResp
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("%s: unmarshal: %v", rel, err)
		}
		if len(resp.Saved) != 0 || len(resp.Skipped) != 1 || resp.Skipped[0]["reason"] != "invalid filename" {
			t.Fatalf("%s: saved=%v skipped=%v", rel, resp.Saved, resp.Skipped)
		}
	}
	// 项目外零落盘（tempdir 父目录探测）
	if _, err := os.Stat(filepath.Join(filepath.Dir(projPath), "escape.txt")); err == nil {
		t.Fatalf("穿越文件落到了项目外")
	}
}

// TestUploadFiles_FakePathStillStripped 既有假路径语义保持：input 上传的
// x:/fakepath/ 前缀剥除后按裸名落盘（单段名零变化）
func TestUploadFiles_FakePathStillStripped(t *testing.T) {
	r, projPath := setupUploadTest(t)

	w := doUpload(t, r, "C:/fakepath/legacy.png", "img")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(projPath, "legacy.png")); err != nil {
		t.Fatalf("legacy.png 未按裸名落盘: %v", err)
	}
}

// TestSanitizeUploadRelPath_SingleSegmentColonAllowed 单段名含冒号不追溯收紧：
// 清洗层原样放行（Linux/mac 宿主合法文件名），Windows 写入失败由 OS 自身语义
// 兜底——契约在纯函数层断言（冒号名在本测试宿主 Windows 上无法真实落盘）；
// 子路径形态的盘符/数据流段拒绝由 HTTP 层 TraversalRejected 用例覆盖
func TestSanitizeUploadRelPath_SingleSegmentColonAllowed(t *testing.T) {
	if got := sanitizeUploadRelPath("12:30-report.md"); got != "12:30-report.md" {
		t.Fatalf("sanitizeUploadRelPath(12:30-report.md) = %q, want 原样放行", got)
	}
	if got := sanitizeUploadRelPath("sub/steam:x.txt"); got != "" {
		t.Fatalf("sanitizeUploadRelPath(sub/steam:x.txt) = %q, want 拒绝", got)
	}
}

// TestUploadFiles_SubPath_NameCompat 子路径段的跨平台名校验（P-132）：保留设备
// 名目录段拒绝（MkdirAll 连带建父目录故全路径逐段校验）
func TestUploadFiles_SubPath_NameCompat(t *testing.T) {
	r, projPath := setupUploadTest(t)

	w := doUploadRelPath(t, r, "a.txt", `["con/a.txt"]`, "x", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Saved) != 0 || len(resp.Skipped) != 1 {
		t.Fatalf("saved=%v skipped=%v, want skipped", resp.Saved, resp.Skipped)
	}
	if _, err := os.Stat(filepath.Join(projPath, "con")); err == nil {
		t.Fatalf("保留设备名目录被创建")
	}
}
