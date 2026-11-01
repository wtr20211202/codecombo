package project

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupRelocateRouter 构造测试 router：独立 store + 预置两个项目 + 注册路由。
// projA 的路径是 dirA（重定位目标项目），projB 占用 dirB（重复登记检测用）
func setupRelocateRouter(t *testing.T) (*gin.Engine, string, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	dirA := t.TempDir()
	dirB := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-a", Name: "alpha", Path: dirA}); err != nil {
		t.Fatalf("create project a: %v", err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-b", Name: "beta", Path: dirB}); err != nil {
		t.Fatalf("create project b: %v", err)
	}

	r := gin.New()
	api := r.Group("/api")
	api.PUT("/projects/:id", RelocateProject)
	return r, "proj-a", dirA, dirB
}

func doRelocate(t *testing.T, r *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/projects/"+id, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// relocateTo 用新目录模拟「目录搬家」：建 newDir 后调用重定位，断言 200 且
// 返回体与存储层的项目 ID/名称不变、path 已更新
func relocateTo(t *testing.T, r *gin.Engine, id, name, newDir string) {
	t.Helper()
	w := doRelocate(t, r, id, `{"path":`+mustJSON(newDir)+`}`)
	if w.Code != http.StatusOK {
		t.Fatalf("relocate: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var res struct {
		Data modelProject
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if res.Data.ID != id || res.Data.Name != name {
		t.Fatalf("identity must be preserved: got id=%q name=%q", res.Data.ID, res.Data.Name)
	}
	if res.Data.Path != newDir {
		t.Fatalf("path not updated: got %q want %q", res.Data.Path, newDir)
	}
	if !res.Data.Valid {
		t.Fatal("relocated project must be valid")
	}
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		t.Fatalf("get after relocate: %v", err)
	}
	if p.Path != newDir {
		t.Fatalf("stored path not updated: got %q want %q", p.Path, newDir)
	}
}

// mustJSON 小工具：测试内把字符串编码为 JSON 字符串字面量
func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestRelocateProjectUpdatesPath 改路径成功：ID/名称不变，仅 path 更新；
// 指回当前路径的重定位是幂等 no-op（200）
func TestRelocateProjectUpdatesPath(t *testing.T) {
	r, id, _, _ := setupRelocateRouter(t)
	newDir := t.TempDir()
	relocateTo(t, r, id, "alpha", newDir)
	// 幂等：再次指向当前路径不报冲突
	relocateTo(t, r, id, "alpha", newDir)
}

// TestRelocateProjectRejectsDuplicatePath 重复路径：新路径归一后与 proj-b 相同 → 409，
// 且存储层路径不得被改动；指回自身路径不受该检测误伤
func TestRelocateProjectRejectsDuplicatePath(t *testing.T) {
	r, id, dirA, dirB := setupRelocateRouter(t)

	w := doRelocate(t, r, id, `{"path":`+mustJSON(dirB)+`}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate path: expected 409, got %d body=%s", w.Code, w.Body.String())
	}
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil || p.Path != dirA {
		t.Fatalf("path must stay unchanged after conflict: %v %v", p, err)
	}

	// 自身路径不在冲突检测范围（排除自身）
	relocateTo(t, r, id, "alpha", dirA)
}

// TestRelocateProjectRejectsMissingPath 不存在路径/文件路径/空 path/未知项目
func TestRelocateProjectRejectsMissingPath(t *testing.T) {
	r, id, _, _ := setupRelocateRouter(t)

	// 不存在的目录
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	if w := doRelocate(t, r, id, `{"path":`+mustJSON(missing)+`}`); w.Code != http.StatusBadRequest {
		t.Fatalf("missing dir: expected 400, got %d", w.Code)
	}
	// 存在但不是目录
	file := filepath.Join(t.TempDir(), "plain.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doRelocate(t, r, id, `{"path":`+mustJSON(file)+`}`); w.Code != http.StatusBadRequest {
		t.Fatalf("regular file: expected 400, got %d", w.Code)
	}
	// 空 path（binding required）
	if w := doRelocate(t, r, id, `{}`); w.Code != http.StatusBadRequest {
		t.Fatalf("empty path: expected 400, got %d", w.Code)
	}
	// 未知项目
	if w := doRelocate(t, r, "no-such-id", `{"path":`+mustJSON(t.TempDir())+`}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown id: expected 404, got %d", w.Code)
	}
}

// modelProject 与后端响应体对应的最小结构（避免测试反向依赖 model 包字段全集）
type modelProject struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	Valid bool   `json:"valid"`
}
