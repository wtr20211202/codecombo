package files

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	mw "codecombo/server/middleware"
)

// setupCacheHeaderTest 构造读取面（file-policy / file / file/download）测试环境，
// 三路由挂 mw.NoStore() 同生产注册（router.go，P-20261002-121）
func setupCacheHeaderTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	g := r.Group("/api/projects/:id")
	{
		g.GET("/file-policy", mw.NoStore(), GetFilePolicy)
		g.GET("/file", mw.NoStore(), ReadFile)
		g.GET("/file/download", mw.NoStore(), DownloadFile)
	}
	return r, projPath
}

// assertNoStore 私有内容缓存头双断言（no-store + Pragma 兜底）
func assertNoStore(t *testing.T, label string, w *httptest.ResponseRecorder) {
	t.Helper()
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("%s: Cache-Control = %q, want no-store", label, got)
	}
	if got := w.Header().Get("Pragma"); got != "no-cache" {
		t.Errorf("%s: Pragma = %q, want no-cache", label, got)
	}
}

// TestPrivateContentCacheHeaders 读取面三端点（含 404 错误路径）一律携
// no-store/no-cache——文件内容是私有内容，不落浏览器/共享代理缓存
func TestPrivateContentCacheHeaders(t *testing.T) {
	r, projPath := setupCacheHeaderTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "note.txt"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		path string
		code int
	}{
		{"policy", "/api/projects/proj-test/file-policy?path=note.txt", http.StatusOK},
		{"read", "/api/projects/proj-test/file?path=note.txt", http.StatusOK},
		{"download", "/api/projects/proj-test/file/download?path=note.txt", http.StatusOK},
		{"missing", "/api/projects/proj-test/file?path=ghost.txt", http.StatusNotFound},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != tc.code {
			t.Errorf("%s: status = %d, want %d (body=%s)", tc.name, w.Code, tc.code, w.Body.String())
			continue
		}
		assertNoStore(t, tc.name, w)
	}
}

// TestReadFile_304StillNoStore ETag/304 既有优化不被破坏：If-None-Match 命中
// 返回 304，缓存头仍在（no-store 只禁存储，不禁条件请求语义）
func TestReadFile_304StillNoStore(t *testing.T) {
	r, projPath := setupCacheHeaderTest(t)
	target := filepath.Join(projPath, "a.txt")
	if err := os.WriteFile(target, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}

	first := httptest.NewRecorder()
	r.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/file?path=a.txt", nil))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want 200", first.Code)
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag missing on first read")
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/file?path=a.txt", nil)
	req.Header.Set("If-None-Match", etag)
	second := httptest.NewRecorder()
	r.ServeHTTP(second, req)
	if second.Code != http.StatusNotModified {
		t.Fatalf("second status = %d, want 304", second.Code)
	}
	assertNoStore(t, "304", second)
}
