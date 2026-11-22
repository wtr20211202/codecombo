package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"codecombo/server/api/opschannel"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// frontend 动词族设备定向（P-20261117-4）发布口单测：路由决策矩阵的 hub 侧在
// opschannel 包钉死（targeting_test.go），本组钉发布口侧——白名单分流（frontend.*
// 走定向出口、其余事件族全广播零变化）、降级通知的形态契约（下载动作复合载荷/
// open 转 url 动作/剪贴板遮蔽预览）、类别静音吞没（评审必改④a）、无绑定降级。
// 定向广播面（真连接收发）归 e2e 多浏览器上下文。

// TestDeliverDeviceEffect_UnboundDegradesToNotice 无绑定会话（纯脚本会话/
// 重启恢复绑定丢失且实例零浏览器在线）→ 不广播设备效应，降级 notify.persist
// 通知入账：下载动作扩 `download` 形态（projectId+path 复合 JSON），响应仍 200
func TestDeliverDeviceEffect_UnboundDegradesToNotice(t *testing.T) {
	r := setupNotifyTest(t)

	var broadcasted opschannel.Event
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if opschannel.IsDeviceEffectEvent(ev.Type) {
			broadcasted = ev
		}
	})
	defer unsub()

	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify",
		`{"type":"frontend.download","payload":{"path":"reports/a.md","projectId":"p1"}}`,
		map[string]string{"X-Session-ID": "sid-none"})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200 (degrade is silent success), got %d body=%s", w.Code, w.Body.String())
	}
	// 设备效应零广播（未捕获到定向事件）
	if broadcasted.Type != "" {
		t.Fatalf("unbound session must not broadcast device effect, got %+v", broadcasted)
	}
	// 通知入账：download 动作 + 复合 JSON 载荷 + 项目归属
	items := store.Get().Notification.List(100)
	if len(items) != 1 {
		t.Fatalf("expect 1 fallback notification, got %d", len(items))
	}
	n := items[0]
	if n.Action != "download" {
		t.Fatalf("fallback download must carry download action, got %q", n.Action)
	}
	var compound map[string]string
	if err := json.Unmarshal([]byte(n.ActionPayload), &compound); err != nil {
		t.Fatalf("actionPayload must be compound JSON, got %q err=%v", n.ActionPayload, err)
	}
	if compound["projectId"] != "p1" || compound["path"] != "reports/a.md" {
		t.Fatalf("compound payload mismatch, got %v", compound)
	}
	if n.ProjectID != "p1" {
		t.Fatalf("notification ProjectID expect p1, got %q", n.ProjectID)
	}
}

// TestDeliverDeviceEffect_BoundOfflineDegradesWithOfflineCopy 绑定浏览器不在场
// （browserForSession 换桩）→ 降级 offline 档文案；open 降级转 action=url
// （http(s) 白名单已过，任何设备的用户点击仍可达）
func TestDeliverDeviceEffect_BoundOfflineDegradesWithOfflineCopy(t *testing.T) {
	r := setupNotifyTest(t)

	oldLookup := browserForSession
	browserForSession = func(string) string { return "b-gone" }
	t.Cleanup(func() { browserForSession = oldLookup })

	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify",
		`{"type":"frontend.open","payload":{"url":"https://ci.example.com/run/42"}}`,
		map[string]string{"X-Session-ID": "sid-1"})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	items := store.Get().Notification.List(100)
	if len(items) != 1 {
		t.Fatalf("expect 1 fallback notification, got %d", len(items))
	}
	n := items[0]
	if n.Action != "url" || n.ActionPayload != "https://ci.example.com/run/42" {
		t.Fatalf("open fallback must carry url action, got %q -> %q", n.Action, n.ActionPayload)
	}
	if !strings.Contains(n.TitleKey, "frontendFallback.openTitle") {
		t.Fatalf("titleKey expect frontendFallback.openTitle, got %q", n.TitleKey)
	}
	if strings.Contains(n.BodyKey, "unbound") || !strings.Contains(n.BodyKey, "Offline") {
		t.Fatalf("offline binding expect offline body copy, got %q", n.BodyKey)
	}
}

// TestDeliverDeviceEffect_ClipboardMaskedPreview 剪贴板降级：入账面持久留痕，
// 敏感值必须遮蔽 + rune 截断（展示面纪律与 notify.persist 校验即遮蔽同源）
func TestDeliverDeviceEffect_ClipboardMaskedPreview(t *testing.T) {
	r := setupNotifyTest(t)

	// 绑定在案而浏览器不在场 → offline 档（无绑定的 unbound 档已在下载用例覆盖）
	oldLookup := browserForSession
	browserForSession = func(string) string { return "b-gone" }
	t.Cleanup(func() { browserForSession = oldLookup })

	secret := "sk-verysecret-value-0123456789abcdefghijklmnop"
	long := strings.Repeat("字", 100)
	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify",
		`{"type":"frontend.clipboard","payload":{"text":"token=`+secret+long+`"}}`,
		map[string]string{"X-Session-ID": "sid-2"})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	items := store.Get().Notification.List(100)
	if len(items) != 1 {
		t.Fatalf("expect 1 fallback notification, got %d", len(items))
	}
	n := items[0]
	if strings.Contains(n.Body, "sk-verysecret") {
		t.Fatalf("clipboard preview must be masked, got %q", n.Body)
	}
	if runes := len([]rune(n.Body)); runes > 90 {
		t.Fatalf("clipboard preview must be truncated (~80+…), got %d runes", runes)
	}
	if strings.Contains(n.BodyKey, "unbound") || !strings.Contains(n.BodyKey, "clipOffline") {
		t.Fatalf("expect clipOffline body copy, got %q", n.BodyKey)
	}
}

// TestDeliverDeviceEffect_MutedCategorySwallowsFallback 类别静音命中 = 降级全链
// 吞没（评审必改④a）：不入账不广播，响应仍 200——「静音时段本就不弹面」的
// 既有语义随行，效应零反馈如实成立
func TestDeliverDeviceEffect_MutedCategorySwallowsFallback(t *testing.T) {
	r := setupNotifyTest(t)

	// 关任务类别（notify.persist 同门类，同一 IsEnabled 判定点）
	prefs := store.Get().Notification.GetPrefs()
	prefs.Enabled[notification.CategoryTask] = false
	if err := store.Get().Notification.SavePrefs(prefs); err != nil {
		t.Fatalf("save prefs: %v", err)
	}

	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify",
		`{"type":"frontend.reload","payload":{"scope":"page"}}`,
		map[string]string{"X-Session-ID": "sid-3"})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200 (silent like notify.persist), got %d", w.Code)
	}
	if items := store.Get().Notification.List(100); len(items) != 0 {
		t.Fatalf("muted category must swallow fallback, got %d notifications", len(items))
	}
}

// TestDeliverDeviceEffect_WhitelistUnaffected 白名单外事件族零变化（评审必改⑥）：
// agent 自定义事件照常全广播（Target 恒空），设备定向不越族扩散、也不入降级
// 通知面
func TestDeliverDeviceEffect_WhitelistUnaffected(t *testing.T) {
	r := setupNotifyTest(t)

	var seen opschannel.Event
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "custom.ping" {
			seen = ev
		}
	})
	defer unsub()

	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify",
		`{"type":"custom.ping","payload":{"k":1}}`,
		map[string]string{"X-Session-ID": "sid-4"})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	if seen.Type != "custom.ping" || seen.TargetBrowserId != "" {
		t.Fatalf("non-device event must broadcast with empty target, got %+v", seen)
	}
	if items := store.Get().Notification.List(100); len(items) != 0 {
		t.Fatalf("non-device event must not create fallback notification, got %d", len(items))
	}
}
