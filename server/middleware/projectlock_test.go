package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 项目硬锁守卫（P-20261004-3）单测：403 契约（稳定标记 project.locked）、
// 放行方向、未知项目穿透（404 归 handler）

func setupLockStore(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

func newGuardRouter(handler gin.HandlerFunc) *gin.Engine {
	r := gin.New()
	r.PUT("/api/projects/:id/file", ProjectHardLock(), handler)
	return r
}

func doReq(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestProjectHardLockDeniesLockedProject(t *testing.T) {
	setupLockStore(t)
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-lock", Name: "locked", Path: t.TempDir(), Locked: true}); err != nil {
		t.Fatalf("create: %v", err)
	}
	r := newGuardRouter(func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	w := doReq(r, http.MethodPut, "/api/projects/p-lock/file", `{}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d body=%s", w.Code, w.Body.String())
	}
	// 错误契约（P-305 已落地）：响应体携结构化 code，且码值与文案稳定标记同串
	//——关键字子串识别契约（前端 KNOWN_ERROR_I18N）与 code 分支契约在此绑定对账
	if !strings.Contains(w.Body.String(), ProjectLockedMarker) {
		t.Fatalf("body must contain stable marker %q, got %s", ProjectLockedMarker, w.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v (%s)", err, w.Body.String())
	}
	if body.Code != ProjectLockedMarker {
		t.Fatalf("structured code = %q, want %q (must equal the stable marker)", body.Code, ProjectLockedMarker)
	}
}

func TestProjectHardLockAllowsUnlockedProject(t *testing.T) {
	setupLockStore(t)
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p-open", Name: "open", Path: t.TempDir()}); err != nil {
		t.Fatalf("create: %v", err)
	}
	r := newGuardRouter(func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	if w := doReq(r, http.MethodPut, "/api/projects/p-open/file", `{}`); w.Code != http.StatusOK {
		t.Fatalf("unlocked project must pass guard, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestProjectHardLockUnknownProjectPassesThrough(t *testing.T) {
	setupLockStore(t)
	r := newGuardRouter(func(c *gin.Context) { c.JSON(http.StatusNotFound, gin.H{"error": "project not found"}) })

	// 未知 ID 不由守卫裁决 404——放行给 handler 保持既有语义
	if w := doReq(r, http.MethodPut, "/api/projects/no-such/file", `{}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown id must pass through to handler, got %d", w.Code)
	}
}

func TestDenyLockedProjectHelper(t *testing.T) {
	setupLockStore(t)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)

	if DenyLockedProject(c, nil) {
		t.Fatal("nil project must not deny")
	}
	if DenyLockedProject(c, &config.ProjectConfig{ID: "x"}) {
		t.Fatal("unlocked project must not deny")
	}
	if !DenyLockedProject(c, &config.ProjectConfig{ID: "x", Locked: true}) {
		t.Fatal("locked project must deny")
	}
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), ProjectLockedMarker) {
		t.Fatalf("deny response must be 403 with marker, got %d %s", w.Code, w.Body.String())
	}
}
