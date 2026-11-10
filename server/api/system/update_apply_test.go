package system

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/errmarkers"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/update"

	"github.com/gin-gonic/gin"
)

// stubNewerSource 恒返回更高版本的假源（受理路径用）
type stubNewerSource struct{}

func (s *stubNewerSource) FetchLatest(_ context.Context, _, _ string) (*update.ReleaseInfo, error) {
	return &update.ReleaseInfo{Version: "99.0.0"}, nil
}

// TestApplyUpdateNpmManagedConflict 异步受理（P-20261109-10）后，受理前拒绝
// 仍同步映射为 409 + 注册表稳定文案（npm 指引），状态机不动、不入账通知。
// 走 npm 形态拒绝而非真实受理：受理会在全局管理器的真实数据目录下建临时目录
func TestApplyUpdateNpmManagedConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Setenv("CODECOMBO_INSTALLER", "npm")

	mgr := update.GetManager()
	mgr.Reset()
	mgr.SetSource(&stubNewerSource{})
	t.Cleanup(func() {
		mgr.SetSource(nil)
		mgr.Reset()
	})

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/updates/apply", nil)
	ApplyUpdate(c)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), errmarkers.UpdateNpmManaged[:20]) {
		t.Fatalf("body should carry npm marker, got %s", w.Body.String())
	}
	if st := mgr.GetStatus(); st.Status != update.StatusIdle {
		t.Fatalf("rejected admission must leave idle, got %s", st.Status)
	}
	if n := len(store.Get().Notification.List(0)); n != 0 {
		t.Fatalf("rejected admission must not notify, got %d", n)
	}
}
