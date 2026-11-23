package system

// 失败路径必产日志断言（P-20261122-12 必改4）：清更新结果文件失败时如实
// 500 + 留 WARN——该文件清不掉会让「已确认」的更新横幅在下次 status 读取时
// 复活（前端两处调用点都静默吞错），服务端日志是唯一诊断面。

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/update"

	"github.com/gin-gonic/gin"
)

// warnCapture 捕获 Warn 及以上的 slog 记录。本包测试无 t.Parallel，
// slog.SetDefault 包级替换安全（结束还原）。
type warnCapture struct {
	mu   sync.Mutex
	msgs []string
}

func (c *warnCapture) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelWarn
}
func (c *warnCapture) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, r.Message)
	return nil
}
func (c *warnCapture) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *warnCapture) WithGroup(string) slog.Handler      { return c }
func (c *warnCapture) found(substr string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.msgs {
		if strings.Contains(m, substr) {
			return true
		}
	}
	return false
}

func captureWarn(t *testing.T) *warnCapture {
	t.Helper()
	c := &warnCapture{}
	orig := slog.Default()
	slog.SetDefault(slog.New(c))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return c
}

// TestDeleteUpdateStatusClearFailureLogs 结果文件删除失败：500 + WARN，且
// 不谎报已清除（mgr 状态不动）。
func TestDeleteUpdateStatusClearFailureLogs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shared.SetDevMode(false)
	t.Cleanup(func() { shared.SetDevMode(true) })
	capture := captureWarn(t)

	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	mgr := update.GetManager()
	mgr.Reset()
	t.Cleanup(mgr.Reset)

	// 非空目录占位 update-result.json：os.Remove 在 win/mac/linux 必失败
	// （空目录在 POSIX 可被 Remove 成功，故必须留一个子文件）
	blocked := filepath.Join(config.DataDir(), "update-result.json")
	if err := os.MkdirAll(blocked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "keep"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodDelete, "/api/updates/status", nil)
	DeleteUpdateStatus(c)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500（清不掉不得假 200），body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "clear update result failed") {
		t.Fatalf("body 应携带稳定失败原因，got %s", w.Body.String())
	}
	if !capture.found("clear update result failed") {
		t.Fatalf("未捕获错误日志（%v），失败无日志=不可诊断", capture.msgs)
	}
}

// TestDeleteUpdateStatusSucceedsWithoutResultFile 无结果文件时照旧 200
// （幂等清除语义不回退）。
func TestDeleteUpdateStatusSucceedsWithoutResultFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	mgr := update.GetManager()
	mgr.Reset()
	t.Cleanup(mgr.Reset)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodDelete, "/api/updates/status", nil)
	DeleteUpdateStatus(c)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200（无文件即已清），body = %s", w.Code, w.Body.String())
	}
}
