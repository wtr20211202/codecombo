package files

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupProjectTest 构造带已注册临时项目的 handler 测试环境
func setupProjectTest(t *testing.T) *gin.Engine {
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
		g.POST("/file", WriteFile)
		g.POST("/file-create", CreateFile)
	}
	return r
}

// TestWriteFile_BodyTooLarge413 请求体超上限 → 413（且不落盘）
func TestWriteFile_BodyTooLarge413(t *testing.T) {
	r := setupProjectTest(t)

	// 33MB 字符串超过 32MB body 上限
	big := strings.Repeat("a", int(writeFileBodyMaxBytes)+1<<20)
	body := `{"path":"a.txt","content":"` + big + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/projects/proj-test/file", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}

// TestWriteFile_NormalWriteStillWorks 上限内正常写入不受影响
func TestWriteFile_NormalWriteStillWorks(t *testing.T) {
	r := setupProjectTest(t)

	req := httptest.NewRequest(http.MethodPost, "/api/projects/proj-test/file",
		strings.NewReader(`{"path":"a.txt","content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
}

// TestCreateFile_BodyTooLarge413 新建文件同样受上限保护
func TestCreateFile_BodyTooLarge413(t *testing.T) {
	r := setupProjectTest(t)

	big := strings.Repeat("a", int(writeFileBodyMaxBytes)+1<<20)
	body := `{"path":"b.txt","content":"` + big + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/projects/proj-test/file-create", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}
