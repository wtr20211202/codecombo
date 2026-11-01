package notify

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 长会话完成提醒阈值（P-20261002-140）的设置 API 契约：部分合并语义下仅传
// 新字段不动其他偏好，写入值经边界钳制（与 notification.ClampLongSessionSec 同界）

func setupPrefsTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.PUT("/api/notifications/prefs", UpdateNotificationPrefs)
	r.POST("/api/notifications", AddNotification)
	return r
}

func TestUpdateNotificationPrefsLongSessionSec(t *testing.T) {
	r := setupPrefsTest(t)

	// 仅传阈值：其他字段不在请求体 = 保留原值（部分合并语义）
	body := `{"longSessionNotifySec": 60}`
	req := httptest.NewRequest(http.MethodPut, "/api/notifications/prefs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT prefs status = %d, body %s", w.Code, w.Body.String())
	}
	p := store.Get().Notification.GetPrefs()
	if p.LongSessionNotifySec != 60 {
		t.Fatalf("longSessionNotifySec = %d, want 60", p.LongSessionNotifySec)
	}
	if !p.Enabled[notification.CategoryTask] || !p.DesktopNotify {
		t.Fatalf("partial merge broken: enabled/desktopNotify overwritten: %+v", p)
	}
	if p.LongTaskThresholdMs != notification.DefaultPrefs().LongTaskThresholdMs {
		t.Fatalf("longTaskThresholdMs = %d, want default preserved", p.LongTaskThresholdMs)
	}

	// 越界写入钳制：1 → 下限 10
	body = `{"longSessionNotifySec": 1}`
	req = httptest.NewRequest(http.MethodPut, "/api/notifications/prefs", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if got := store.Get().Notification.GetPrefs().LongSessionNotifySec; got != 10 {
		t.Fatalf("clamped longSessionNotifySec = %d, want 10", got)
	}

	// 响应体回读即合法值（前端 slider 直接绑定）
	var resp notification.Prefs
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response unmarshal: %v", err)
	}
	if resp.LongSessionNotifySec != 10 {
		t.Fatalf("response longSessionNotifySec = %d, want 10", resp.LongSessionNotifySec)
	}
}

// setupSnoozeTest 构造带通知路由的测试引擎（snooze 打标/取消契约 P-20261003-36）
func setupSnoozeTest(t *testing.T) (*gin.Engine, func(seed notification.Notification) string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/notifications", AddNotification)
	r.POST("/api/notifications/snooze/:id", SnoozeNotification)
	// 播种一条通知并返回其 id（Add 生成 ID/时间、清延后态）
	seed := func(n notification.Notification) string {
		body, err := json.Marshal(n)
		if err != nil {
			t.Fatalf("seed marshal: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/notifications", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("seed status = %d, body %s", w.Code, w.Body.String())
		}
		items := store.Get().Notification.List(0)
		if len(items) == 0 {
			t.Fatal("seed 后列表为空")
		}
		return items[0].ID
	}
	return r, seed
}

func postSnooze(r *gin.Engine, id, payload string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/notifications/snooze/"+id, strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestSnoozeNotificationContract 打标/取消/非法入参契约：RFC3339 绝对时刻落盘、
// 空串取消、坏格式 400（稳定英文原文）、未知 id 404
func TestSnoozeNotificationContract(t *testing.T) {
	r, seed := setupSnoozeTest(t)

	id := seed(notification.Notification{Type: "info", Category: "system", Title: "snooze-contract"})

	// 打标：合法 RFC3339 → 200，字段随记录落盘
	if w := postSnooze(r, id, `{"snoozeUntil":"2026-10-04T12:00:00Z"}`); w.Code != http.StatusOK {
		t.Fatalf("snooze status = %d, body %s", w.Code, w.Body.String())
	}
	var snoozed notification.Notification
	for _, n := range store.Get().Notification.List(0) {
		if n.ID == id {
			snoozed = n
		}
	}
	if snoozed.SnoozeUntil == nil || !snoozed.SnoozeUntil.Equal(time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("snoozeUntil not persisted: %+v", snoozed)
	}

	// 取消：空串 → 标记清除
	if w := postSnooze(r, id, `{"snoozeUntil":""}`); w.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body %s", w.Code, w.Body.String())
	}
	for _, n := range store.Get().Notification.List(0) {
		if n.ID == id && n.SnoozeUntil != nil {
			t.Fatalf("cancel should clear snoozeUntil: %+v", n)
		}
	}

	// 坏格式：400 + 稳定英文原文（前端按原文直出，不依赖 devMode 转译）
	w := postSnooze(r, id, `{"snoozeUntil":"not-a-time"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad format status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "snoozeUntil must be RFC3339") {
		t.Fatalf("bad format should return stable message, got %s", w.Body.String())
	}

	// 未知 id：404
	if w := postSnooze(r, "missing-id", `{"snoozeUntil":"2026-10-04T12:00:00Z"}`); w.Code != http.StatusNotFound {
		t.Fatalf("missing id status = %d, want 404", w.Code)
	}
}

// TestAddNotificationClearsSnooze 新入账通知不携带延后态：AddNotification 对
// 载荷里的 snoozeUntil 防御性清零（客户端伪造的预延后通知不成立）
func TestAddNotificationClearsSnooze(t *testing.T) {
	r, _ := setupSnoozeTest(t)

	body := `{"type":"info","category":"system","title":"snooze-forged","snoozeUntil":"2026-10-04T12:00:00Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/notifications", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("add status = %d, body %s", w.Code, w.Body.String())
	}
	for _, n := range store.Get().Notification.List(0) {
		if n.SnoozeUntil != nil {
			t.Fatalf("new notification should not carry snoozeUntil: %+v", n)
		}
	}
}

// TestAddNotificationRuntimePassthrough runtime 字段透传（P-20261003-187）：
// POST /api/notifications 载荷声明的 runtime 随记录落盘（agent 自报归属与
// e2e 播种同走此口）；缺省留空 = 无归属不受前端 runtime 过滤
func TestAddNotificationRuntimePassthrough(t *testing.T) {
	r, _ := setupSnoozeTest(t)

	post := func(body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/notifications", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("add status = %d, body %s", w.Code, w.Body.String())
		}
	}
	post(`{"type":"warning","category":"system","title":"rt-claude","runtime":"claude"}`)
	post(`{"type":"info","category":"task","title":"rt-none"}`)

	items := store.Get().Notification.List(0)
	if len(items) != 2 {
		t.Fatalf("expect 2 notifications, got %d", len(items))
	}
	byTitle := make(map[string]notification.Notification, len(items))
	for _, n := range items {
		byTitle[n.Title] = n
	}
	if got := byTitle["rt-claude"].Runtime; got != "claude" {
		t.Fatalf("runtime = %q, want claude", got)
	}
	if got := byTitle["rt-none"].Runtime; got != "" {
		t.Fatalf("runtime = %q, want empty", got)
	}
}

// 项目×类别二维静音（P-20261003-168）的设置 API 契约：仅传 projectMutes 不动
// 其他偏好（部分合并语义）、写入端归一（空项剔除/去重）；静音组合经
// POST /api/notifications（agent 同款入账口）不再入账，解除后恢复
func TestUpdateNotificationPrefsProjectMutes(t *testing.T) {
	r := setupPrefsTest(t)

	put := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/notifications/prefs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("PUT prefs status = %d, body %s", w.Code, w.Body.String())
		}
		return w
	}

	put(`{"projectMutes":[{"projectId":"p1","category":"git"},{"projectId":"","category":"task"},{"projectId":"p1","category":"git"}]}`)
	p := store.Get().Notification.GetPrefs()
	want := []notification.ProjectMute{{ProjectID: "p1", Category: "git"}}
	if len(p.ProjectMutes) != 1 || p.ProjectMutes[0] != want[0] {
		t.Fatalf("projectMutes = %+v, want %+v (空项剔除+去重)", p.ProjectMutes, want)
	}
	// 部分合并：仅传 projectMutes 不动其他偏好
	if !p.Enabled[notification.CategoryTask] || !p.DesktopNotify {
		t.Fatalf("partial merge broken: enabled/desktopNotify overwritten: %+v", p)
	}

	// 仅传空清单 = 清空静音（指针判存在，区别于缺字段保留）
	put(`{"projectMutes":[]}`)
	if mutes := store.Get().Notification.GetPrefs().ProjectMutes; len(mutes) != 0 {
		t.Fatalf("projectMutes should be cleared, got %+v", mutes)
	}

	// 重新静音后 POST 通知：同组合不入账
	put(`{"projectMutes":[{"projectId":"p1","category":"git"}]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/notifications", strings.NewReader(`{"type":"info","category":"git","title":"muted-via-api","projectId":"p1"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST notification status = %d", w.Code)
	}
	if n := store.Get().Notification.List(0); len(n) != 0 {
		t.Fatalf("静音组合不应入账，got %+v", n)
	}
}
