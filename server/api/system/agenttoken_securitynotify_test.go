package system

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// P-20261003-54 破坏性安全操作的通知回执：Agent Token 轮换使全部既有 sca_
// 令牌立即失效（持旧值的一侧骤然失能），在审计点同位旁挂即时回执通知
// （warning 类别走 webhook 默认 important 外发、来源 IP 入 body）。

func TestRotateAgentTokenNotification(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/agent-token/rotate", nil)
	RotateAgentToken(c)
	if w.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, body = %s", w.Code, w.Body.String())
	}

	list := store.Get().Notification.List(0)
	if len(list) == 0 {
		t.Fatal("expect rotate to produce a notification")
	}
	n := list[0] // List 按时间倒序，最新在前
	if n.Type != "warning" || n.Category != notification.CategorySystem {
		t.Fatalf("type/category = %s/%s, want warning/system", n.Type, n.Category)
	}
	if !strings.Contains(n.Title, "Agent") {
		t.Fatalf("title %q should identify the rotated object", n.Title)
	}
	if !strings.Contains(n.Body, "来源 IP") || n.MsgParams["ip"] == "" {
		t.Fatalf("body should carry source ip, got %q, params %v", n.Body, n.MsgParams)
	}
	if n.TitleKey != "audit.notify.agentTokenRotate.title" || n.BodyKey != "audit.notify.agentTokenRotate.body" {
		t.Fatalf("template keys = %s / %s", n.TitleKey, n.BodyKey)
	}
}
