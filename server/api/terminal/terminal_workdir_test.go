package terminal

import (
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

// 目录级终端（P-20261005-192）工作目录守卫单测：resolveSessionWorkDir 纯函数面
// （缺省回落 / 相对与绝对在根内 / "..." 越界 / 兄弟目录前缀伪装 / 缺失 / 文件非
// 目录）+ POST /terminals 的 400 稳定原文契约（P-29 errmarkers 族，前端
// KNOWN_ERROR_I18N 按原文映射，改文案须两侧同步）。真实建会话不进本包单测
// （PTY 不进单测是本包既有边界），cwd 落点断言在 e2e

func TestResolveSessionWorkDir(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "web", "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 兄弟目录前缀伪装靶：rootFoo 与 root 同前缀不同名（同级，非根内）
	siblingRoot := filepath.Join(filepath.Dir(root), filepath.Base(root)+"-sibling")
	if err := os.MkdirAll(siblingRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(siblingRoot) })

	t.Run("empty falls back to root", func(t *testing.T) {
		got, err := resolveSessionWorkDir(root, "")
		if err != nil || got != root {
			t.Fatalf("got %q, %v; want root", got, err)
		}
	})
	t.Run("relative sub dir", func(t *testing.T) {
		got, err := resolveSessionWorkDir(root, "web/src")
		if err != nil || got != sub {
			t.Fatalf("got %q, %v; want %q", got, err, sub)
		}
	})
	t.Run("absolute sub dir", func(t *testing.T) {
		got, err := resolveSessionWorkDir(root, sub)
		if err != nil || got != sub {
			t.Fatalf("got %q, %v; want %q", got, err, sub)
		}
	})
	t.Run("root itself allowed", func(t *testing.T) {
		got, err := resolveSessionWorkDir(root, ".")
		if err != nil || got != root {
			t.Fatalf("got %q, %v; want root", got, err)
		}
	})
	t.Run("dot-dot traversal rejected", func(t *testing.T) {
		for _, in := range []string{"..", "web/../..", "web/../../outside"} {
			if _, err := resolveSessionWorkDir(root, in); err == nil || err.Error() != "path traversal not allowed" {
				t.Fatalf("input %q: got %v; want stable traversal text", in, err)
			}
		}
	})
	t.Run("absolute outside root rejected", func(t *testing.T) {
		if _, err := resolveSessionWorkDir(root, siblingRoot); err == nil || err.Error() != "path traversal not allowed" {
			t.Fatalf("got %v; want stable traversal text", err)
		}
	})
	t.Run("missing dir rejected", func(t *testing.T) {
		_, err := resolveSessionWorkDir(root, "web/nope")
		if err == nil || err.Error() != "path does not exist or is not a directory" {
			t.Fatalf("got %v; want stable missing text", err)
		}
	})
	t.Run("file target rejected", func(t *testing.T) {
		_, err := resolveSessionWorkDir(root, "file.txt")
		if err == nil || err.Error() != "path does not exist or is not a directory" {
			t.Fatalf("got %v; want stable missing text", err)
		}
	})
}

// POST /terminals dir 参数 400 契约：越界与缺失都在进入 manager（起 PTY）之前
// 短路，本测试只覆盖这两条校验面；合法 dir 的创建落点（首 prompt cwd、响应
// path）由 e2e 承接（PTY 不进单测是本包既有边界）
func TestCreateTerminalDirValidation(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-workdir", Name: "workdir", Path: root}); err != nil {
		t.Fatal(err)
	}
	pid := "p-workdir"

	r := gin.New()
	r.POST("/api/terminals", CreateTerminal)

	post := func(dir string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/terminals",
			strings.NewReader(`{"projectId":"`+pid+`","dir":"`+dir+`"}`))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	if w := post("../.."); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "path traversal not allowed") {
		t.Fatalf("traversal: got %d %s", w.Code, w.Body.String())
	}
	if w := post("no-such-dir"); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "path does not exist or is not a directory") {
		t.Fatalf("missing: got %d %s", w.Code, w.Body.String())
	}
}
