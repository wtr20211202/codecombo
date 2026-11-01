package remote

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// P-20261003-54 破坏性安全操作的通知回执：主机删除 / SSH 指纹重置在审计点
// 同位产通知（warning 类别走 webhook 默认 important 外发、标题含对象名、
// 来源 IP 入 body 用审计同源 ClientIP）。单测直连 handler，断言通知中心
// 落库条目与审计双通道并存。

func setupSecurityNotifyStore(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

func doNotifyReq(t *testing.T, handler gin.HandlerFunc, method, path, id string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, path, nil)
	// CreateTestContext 不经路由树，路径参数须手动注入（handler 直连无 :id 解析）
	c.Params = gin.Params{{Key: "id", Value: id}}
	handler(c)
	return w
}

func seedNotifyHost(t *testing.T, name string) config.RemoteHost {
	t.Helper()
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: name, Host: "192.168.1.10", Port: 22, User: "root",
		AuthType: config.AuthTypePassword, Password: "pw-plain",
	})
	if err != nil {
		t.Fatalf("seed host: %v", err)
	}
	return *rh
}

func lastNotification(t *testing.T) notification.Notification {
	t.Helper()
	list := store.Get().Notification.List(0)
	if len(list) == 0 {
		t.Fatal("expect a notification to be recorded")
	}
	return list[0] // List 按时间倒序，最新在前
}

func TestDeleteRemoteHostNotification(t *testing.T) {
	setupSecurityNotifyStore(t)
	rh := seedNotifyHost(t, "victim-host")

	w := doNotifyReq(t, DeleteRemoteHost, http.MethodDelete, "/api/remotehosts/"+rh.ID, rh.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}

	// 通知回执：warning/system、标题含对象名、body 带主机摘要与来源 IP
	n := lastNotification(t)
	if n.Type != "warning" || n.Category != notification.CategorySystem {
		t.Fatalf("type/category = %s/%s, want warning/system", n.Type, n.Category)
	}
	if !strings.Contains(n.Title, "victim-host") {
		t.Fatalf("title %q should contain object name", n.Title)
	}
	if !strings.Contains(n.Body, "root@192.168.1.10:22") {
		t.Fatalf("body %q should contain host summary", n.Body)
	}
	if !strings.Contains(n.Body, "来源 IP") || n.MsgParams["ip"] == "" {
		t.Fatalf("body should carry source ip, got %q, params %v", n.Body, n.MsgParams)
	}
	// i18n 模板键 + 命名参数（前端按 key + MsgParams 渲染，原文为兜底）
	if n.TitleKey != "audit.notify.hostDelete.title" || n.BodyKey != "audit.notify.hostDelete.body" {
		t.Fatalf("template keys = %s / %s", n.TitleKey, n.BodyKey)
	}
	if n.MsgParams["name"] != "victim-host" || n.MsgParams["host"] != "192.168.1.10" {
		t.Fatalf("msgParams = %v", n.MsgParams)
	}

	// 双通道并存：审计点未被旁挂通知取代（审计逻辑勿动）
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditHostDelete && strings.Contains(e.Detail, rh.ID) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("audit log should still record host delete, got %+v", events)
	}
}

// TestDeleteRemoteHostAuditDetailSelfDescribing（P-20261003-133）：删除审计
// Detail 拼「name (id)」——对象已删，翻台账不再只见裸 id 无从对机
func TestDeleteRemoteHostAuditDetailSelfDescribing(t *testing.T) {
	setupSecurityNotifyStore(t)
	rh := seedNotifyHost(t, "audit-name-host")

	w := doNotifyReq(t, DeleteRemoteHost, http.MethodDelete, "/api/remotehosts/"+rh.ID, rh.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}

	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	for _, e := range events {
		if e.Action != store.AuditHostDelete {
			continue
		}
		if want := fmt.Sprintf("%s (%s)", "audit-name-host", rh.ID); e.Detail != want {
			t.Fatalf("detail = %q, want %q", e.Detail, want)
		}
		return
	}
	t.Fatalf("audit log should record host delete, got %+v", events)
}

func TestResetRemoteHostKeyNotificationCarriesIP(t *testing.T) {
	setupSecurityNotifyStore(t)
	rh := seedNotifyHost(t, "fp-host")
	// 先钉扎一条指纹，重置语义真实（未钉扎时幂等成功，同样产通知）
	if err := store.Get().SSHHostKey.Put(rh.Host, rh.Port, "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99", "ed25519"); err != nil {
		t.Fatalf("pin fingerprint: %v", err)
	}

	w := doNotifyReq(t, ResetRemoteHostKey, http.MethodPost, "/api/remotehosts/"+rh.ID+"/hostkey/reset", rh.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("reset status = %d, body = %s", w.Code, w.Body.String())
	}

	n := lastNotification(t)
	if n.Type != "warning" || !strings.Contains(n.Title, "fp-host") {
		t.Fatalf("type/title = %s/%q, want warning + object name", n.Type, n.Title)
	}
	if !strings.Contains(n.Body, "来源 IP") || n.MsgParams["ip"] == "" {
		t.Fatalf("body should carry source ip (P-20261003-54), got %q, params %v", n.Body, n.MsgParams)
	}
	// port 经落盘 JSON 往返为 float64，按数值比较
	if p, ok := n.MsgParams["port"].(float64); !ok || int(p) != rh.Port {
		t.Fatalf("msgParams = %v", n.MsgParams)
	}
}
