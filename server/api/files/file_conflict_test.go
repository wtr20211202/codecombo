package files

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupConflictTest 构造带已注册临时项目的冲突检测测试环境（PUT/GET /file 同生产路由）
func setupConflictTest(t *testing.T) (*gin.Engine, string) {
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
	g := r.Group("/api/projects/:id")
	{
		g.PUT("/file", WriteFile)
		g.GET("/file", ReadFile)
	}
	return r, projPath
}

func doFileJSON(t *testing.T, r *gin.Engine, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestWriteFile_BaseHashMatchWrites baseHash 与磁盘一致 → 正常写入（检测不误伤）
func TestWriteFile_BaseHashMatchWrites(t *testing.T) {
	r, projPath := setupConflictTest(t)
	target := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(target, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("v1"))
	base := hex.EncodeToString(sum[:])

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"a.txt","content":"v2","baseHash":"`+base+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "v2" {
		t.Fatalf("disk = %q (err=%v), want v2", got, err)
	}
	// 成功响应带回新内容 hash：前端以此刷新下次保存的检测基线
	var resp struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not json: %v", err)
	}
	sum2 := sha256.Sum256([]byte("v2"))
	if resp.Hash != hex.EncodeToString(sum2[:]) {
		t.Fatalf("resp hash = %q, want hash(v2)", resp.Hash)
	}
}

// TestWriteFile_BaseHashMismatch409 baseHash 与磁盘不一致 → 409 携带磁盘当前内容，且不落盘
func TestWriteFile_BaseHashMismatch409(t *testing.T) {
	r, projPath := setupConflictTest(t)
	target := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(target, []byte("agent-rewritten"), 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("stale-open-time-content"))
	staleBase := hex.EncodeToString(sum[:])

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"a.txt","content":"mine","baseHash":"`+staleBase+`"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Error          string `json:"error"`
		CurrentContent string `json:"currentContent"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not json: %v", err)
	}
	if resp.Error == "" {
		t.Fatal("409 body missing error message")
	}
	if resp.CurrentContent != "agent-rewritten" {
		t.Fatalf("currentContent = %q, want agent-rewritten", resp.CurrentContent)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "agent-rewritten" {
		t.Fatalf("disk = %q, conflict write must not land", got)
	}
}

// TestWriteFile_NoBaseHashDirectWrite 无 baseHash → 直写（兼容既有保存调用方）
func TestWriteFile_NoBaseHashDirectWrite(t *testing.T) {
	r, projPath := setupConflictTest(t)
	target := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(target, []byte("disk-changed"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"a.txt","content":"legacy-save"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, _ := os.ReadFile(target)
	if string(got) != "legacy-save" {
		t.Fatalf("disk = %q, want legacy-save", got)
	}
}

// TestWriteFile_BaseHashFileMissingRecreate baseHash 非空但文件已被外部删除 →
// 直写重建（磁盘上已无内容可覆盖，覆盖保存是用户显式意图）
func TestWriteFile_BaseHashFileMissingRecreate(t *testing.T) {
	r, projPath := setupConflictTest(t)
	sum := sha256.Sum256([]byte("deleted-on-disk"))
	base := hex.EncodeToString(sum[:])

	w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
		`{"path":"gone.txt","content":"recreated","baseHash":"`+base+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(projPath, "gone.txt"))
	if err != nil || string(got) != "recreated" {
		t.Fatalf("disk = %q (err=%v), want recreated", got, err)
	}
}

// TestReadFile_ResponseCarriesHash ReadFile 响应带回内容 hash（保存冲突检测基线），
// 且与 ETag 摘要同形；部分预览（truncated）不带 hash
func TestReadFile_ResponseCarriesHash(t *testing.T) {
	r, projPath := setupConflictTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("body"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/file?path=a.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Data      string `json:"data"`
		Hash      string `json:"hash"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not json: %v", err)
	}
	sum := sha256.Sum256([]byte("body"))
	want := hex.EncodeToString(sum[:])
	if resp.Hash != want {
		t.Fatalf("hash = %q, want %q", resp.Hash, want)
	}
	// ETag 摘要与响应 hash 同形（W/"size-hash"），If-None-Match 契约不回归
	if !strings.Contains(w.Header().Get("ETag"), want) {
		t.Fatalf("ETag %q does not embed content hash", w.Header().Get("ETag"))
	}

	// 304 仍工作（弱比较，ETag 原样回传）
	req2 := httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/file?path=a.txt", nil)
	req2.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match status = %d, want 304", w2.Code)
	}
}
