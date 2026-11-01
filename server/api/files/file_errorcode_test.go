package files

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// P-20261003-305 门禁：files 域错误面的 code 稳定断言——agent 按 code 分支自纠
// （413 拆分 / 越界换相对路径 / 409 先读后写），码值或绑定 status 漂移在此翻红。
// code 字面与共享注册表（server/api/shared/errors.go）一一对应。

// respCode 解出响应体的 code 字段（缺字段 = 空串，断言即翻红）
func respCode(t *testing.T, body []byte) string {
	t.Helper()
	var m struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	return m.Code
}

func postJSON(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestWriteFile_ErrorCodes 写路径三分类自纠依据：413 载荷过大 / 403 越界 / 400 缺 path
func TestWriteFile_ErrorCodes(t *testing.T) {
	r := setupProjectTest(t)

	// 请求体超上限 → 413 + files.payload_too_large（agent 自纠：拆分写入）
	big := strings.Repeat("a", int(writeFileBodyMaxBytes)+1<<20)
	w := postJSON(r, "/api/projects/proj-test/file", `{"path":"a.txt","content":"`+big+`"}`)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too-large status = %d, want 413", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.payload_too_large" {
		t.Errorf("too-large code = %q, want files.payload_too_large", got)
	}

	// 路径越出项目根 → 403 + files.path_outside_root（agent 自纠：换项目相对路径）
	w = postJSON(r, "/api/projects/proj-test/file", `{"path":"../evil.txt","content":"x"}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("outside-root status = %d, want 403", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.path_outside_root" {
		t.Errorf("outside-root code = %q, want files.path_outside_root", got)
	}

	// 缺 path → 400 + files.path_required（agent 自纠：补字段重发）
	w = postJSON(r, "/api/projects/proj-test/file", `{"content":"x"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("path-required status = %d, want 400", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.path_required" {
		t.Errorf("path-required code = %q, want files.path_required", got)
	}
}

// TestCreateFile_ErrorCodes 新建文件：409 已存在冲突 + 400 载荷非法
func TestCreateFile_ErrorCodes(t *testing.T) {
	r := setupProjectTest(t)

	// 首建成功
	if w := postJSON(r, "/api/projects/proj-test/file-create", `{"path":"c.txt","content":"v1"}`); w.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, want 201, body=%s", w.Code, w.Body.String())
	}
	// 再建同路径 → 409 + files.conflict（agent 自纠：先读现状再决策）
	w := postJSON(r, "/api/projects/proj-test/file-create", `{"path":"c.txt","content":"v2"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, want 409", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.conflict" {
		t.Errorf("conflict code = %q, want files.conflict", got)
	}

	// 非法 JSON → 400 + files.payload_invalid
	w = postJSON(r, "/api/projects/proj-test/file-create", `{bad json`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid payload status = %d, want 400", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.payload_invalid" {
		t.Errorf("invalid payload code = %q, want files.payload_invalid", got)
	}
}

// TestReadFile_ErrorCodes 读面：404 不存在（先创建）与 403 越界同带 code
func TestReadFile_ErrorCodes(t *testing.T) {
	r := setupProjectTest(t)
	r.GET("/api/projects/:id/file", ReadFile)

	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}

	// 不存在 → 404 + files.not_found（agent 自纠：核对路径或先创建）
	w := get("/api/projects/proj-test/file?path=missing.txt")
	if w.Code != http.StatusNotFound {
		t.Fatalf("not-found status = %d, want 404", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.not_found" {
		t.Errorf("not-found code = %q, want files.not_found", got)
	}

	// 越界 → 403 + files.path_outside_root
	w = get("/api/projects/proj-test/file?path=../secret.txt")
	if w.Code != http.StatusForbidden {
		t.Fatalf("outside-root status = %d, want 403", w.Code)
	}
	if got := respCode(t, w.Body.Bytes()); got != "files.path_outside_root" {
		t.Errorf("outside-root code = %q, want files.path_outside_root", got)
	}
}
