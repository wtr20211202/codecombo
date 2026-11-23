package system

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/update"

	"github.com/gin-gonic/gin"
)

// 中心链活性握手接入（P-20261122-5）：握手失败即中止——500 带可区分原因、不
// 触发退出钩子（主进程不退出=监管者不重拉，服务维持安全态）；spawn err 与秒死
// 两形态 publicMsg 可区分；成功路径钩子照常触发（既有语义零变化）。
// 断言走非 dev 模式：devMode 下响应体直透 err 原文（errText），publicMsg 分型
// 只在生产口径可见。launchSubprocessFn 注入护栏同 update 包
// launchUpdateSubprocessFn 先例（manager_retry_test.go）——测试绝不真实 spawn
// 换包进程
func TestApplyUpdateFromCenterHandshakeAbort(t *testing.T) {
	gin.SetMode(gin.TestMode)
	shared.SetDevMode(false)
	t.Cleanup(func() { shared.SetDevMode(true) }) // 包内其余测试的缺省形态
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 中心实例桩：serve-binary 任意路径回固定字节
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("center-binary"))
	}))
	t.Cleanup(center.Close)

	hookFired := &atomic.Bool{}
	update.SetRestartHook(func() { hookFired.Store(true) })
	t.Cleanup(func() { update.SetRestartHook(nil) })

	mgr := update.GetManager()
	mgr.Reset()
	t.Cleanup(mgr.Reset)

	orig := launchSubprocessFn
	t.Cleanup(func() { launchSubprocessFn = orig })

	reqBody := fmt.Sprintf(`{"centerUrl": %q}`, center.URL)
	call := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/updates/apply-from-center", strings.NewReader(reqBody))
		ApplyUpdateFromCenter(c)
		return w
	}

	t.Run("秒死中止 500 带原因且不触发钩子", func(t *testing.T) {
		hookFired.Store(false)
		launchSubprocessFn = func(string, string, int, int, string, string, string) error {
			return fmt.Errorf(`%w: no "update started" logged within 10s — common causes: antivirus blocking`, update.ErrSubprocessDied)
		}
		w := call()
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 (body %s)", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "update subprocess did not confirm startup") {
			t.Fatalf("body should carry the not-confirmed-startup reason, got %s", w.Body.String())
		}
		time.Sleep(700 * time.Millisecond) // 钩子有 500ms 延迟
		if hookFired.Load() {
			t.Fatal("aborted handshake must not trigger the restart hook")
		}
	})

	t.Run("spawn err 中止 500 且不触发钩子", func(t *testing.T) {
		hookFired.Store(false)
		launchSubprocessFn = func(string, string, int, int, string, string, string) error {
			return errors.New("fork/exec denied")
		}
		w := call()
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 (body %s)", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "start update process failed") {
			t.Fatalf("body should carry the spawn-err form, got %s", w.Body.String())
		}
		time.Sleep(700 * time.Millisecond)
		if hookFired.Load() {
			t.Fatal("failed spawn must not trigger the restart hook")
		}
	})

	t.Run("成功路径钩子照常触发", func(t *testing.T) {
		hookFired.Store(false)
		launchSubprocessFn = func(string, string, int, int, string, string, string) error { return nil }
		w := call()
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "update from center started") {
			t.Fatalf("body = %s, want started message", w.Body.String())
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if hookFired.Load() {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("restart hook must fire on the success path")
	})
}

// 状态端点透出 buildVersion（P-20261122-5）：前端 unknown 结局判定「服务可达
// 但版本<目标=仍为旧版本」的数据源
func TestGetUpdateStatusCarriesBuildVersion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	update.GetManager().Reset()

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/status", nil)
	GetUpdateStatus(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"buildVersion":"`+buildVersion+`"`) {
		t.Fatalf("body should carry buildVersion=%s, got %s", buildVersion, w.Body.String())
	}
}
