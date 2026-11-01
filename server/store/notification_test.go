package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

func setupNotificationStore(t *testing.T) *store.Store {
	t.Helper()
	s := store.New(filestore.New(filepath.Join(t.TempDir(), "data")))
	store.SetDefault(s)
	return s
}

// addNotification 落一条通知并返回其持久化记录（Add 生成 ID/时间）
func addNotification(t *testing.T, s *store.Store, title string) notification.Notification {
	t.Helper()
	s.Notification.Add(notification.Notification{Type: "info", Category: "git", Title: title})
	for _, item := range s.Notification.List(0) {
		if item.Title == title {
			return item
		}
	}
	t.Fatalf("通知 %q 落库后未在列表中", title)
	return notification.Notification{}
}

// TestNotificationRepo_DismissMany 批量移除：命中者全部消失、未命中者保留、
// 读缓存随写失效（DismissMany 后 List 不返回已删条目）
func TestNotificationRepo_DismissMany(t *testing.T) {
	s := setupNotificationStore(t)
	n := s.Notification

	a := addNotification(t, s, "batch-a")
	b := addNotification(t, s, "batch-b")
	keep := addNotification(t, s, "keep-me")

	n.DismissMany([]string{a.ID, b.ID, "not-exists-id"})

	remaining := n.List(0)
	if len(remaining) != 1 {
		t.Fatalf("DismissMany 后应剩 1 条，got %d", len(remaining))
	}
	if remaining[0].ID != keep.ID {
		t.Fatalf("应保留 keep-me，got %q", remaining[0].Title)
	}
}

// TestNotificationRepo_DismissMany_Empty：空入参不 panic、不影响现有数据
func TestNotificationRepo_DismissMany_Empty(t *testing.T) {
	s := setupNotificationStore(t)
	n := s.Notification

	addNotification(t, s, "stay")
	before := len(n.List(0))

	n.DismissMany(nil)
	if len(n.List(0)) != before {
		t.Fatal("空批量不应改变列表")
	}
}

// TestNotificationRepo_SnoozeRemount 稍后提醒打标/取消/到点重挂（P-20261003-36）：
// 打标只动 SnoozeUntil（条目仍在列表，随记录持久）；取消恢复原状；巡检只收
// 已到点条目并重挂为未读置顶（时间戳前移、清标记），未到点/重新延后不受影响
func TestNotificationRepo_SnoozeRemount(t *testing.T) {
	s := setupNotificationStore(t)
	n := s.Notification

	due := addNotification(t, s, "snooze-due")
	later := addNotification(t, s, "snooze-later")
	n.MarkRead(due.ID)
	if !n.Snooze(due.ID, time.Now().Add(30*time.Minute)) {
		t.Fatal("打标应命中已存在条目")
	}

	now := time.Now()
	// 打标后条目仍在列表（延后是标记不是删除），SnoozeUntil 随记录落盘
	list := n.List(0)
	if len(list) != 2 {
		t.Fatalf("snooze 后列表应仍 2 条，got %d", len(list))
	}

	// 未到点：巡检零命中、标记保留
	if got := n.RemountDue(now); len(got) != 0 {
		t.Fatalf("未到点巡检不应重挂，got %d 条", len(got))
	}
	// 到期窗口内重新打标到更晚：巡检不得以缓存的旧到期时刻误重挂（竞态回归）
	if !n.Snooze(due.ID, now.Add(time.Hour)) {
		t.Fatal("重新打标应命中已存在条目")
	}
	if got := n.RemountDue(now.Add(31 * time.Minute)); len(got) != 0 {
		t.Fatalf("重新延后到未来后巡检不应重挂，got %d 条", len(got))
	}

	// 取消延后（零值 until）：标记清除；未知 id 返回 false
	if !n.Snooze(due.ID, time.Time{}) {
		t.Fatal("取消延后应命中已存在条目")
	}
	if n.Snooze("not-exists", now) {
		t.Fatal("未知 id 应返回 false")
	}
	for _, item := range n.List(0) {
		if item.ID == due.ID && item.SnoozeUntil != nil {
			t.Fatalf("取消后 SnoozeUntil 应为 nil，got %v", item.SnoozeUntil)
		}
	}

	// 到点重挂：SnoozeUntil 已过 → 置未读 + 时间戳前移 + 清标记；
	// 延后中的另一条不受波及
	snoozedAt := now.Add(-time.Minute)
	if !n.Snooze(due.ID, snoozedAt) || !n.Snooze(later.ID, now.Add(time.Hour)) {
		t.Fatal("打标失败")
	}
	got := n.RemountDue(now.Add(time.Minute))
	if len(got) != 1 || got[0].ID != due.ID {
		t.Fatalf("巡检应只重挂到点的 due，got %v", got)
	}
	if got[0].Read {
		t.Fatal("重挂条目应为未读（Read 打标前已置 true）")
	}
	if got[0].SnoozeUntil != nil {
		t.Fatalf("重挂后 SnoozeUntil 应清空，got %v", got[0].SnoozeUntil)
	}
	if !got[0].Time.After(snoozedAt) {
		t.Fatalf("重挂条目时间戳应前移到巡检时刻，got %v", got[0].Time)
	}
	for _, item := range n.List(0) {
		if item.ID == later.ID && (item.SnoozeUntil == nil || !item.SnoozeUntil.After(now.Add(time.Minute))) {
			t.Fatalf("延后中的条目不应被波及，got %+v", item)
		}
		if item.ID == due.ID && item.SnoozeUntil != nil {
			t.Fatalf("重挂后落盘记录应已清标记，got %+v", item)
		}
	}

	// 幂等：下一轮巡检对已重挂条目零命中（标记已清）
	if got := n.RemountDue(now.Add(2 * time.Minute)); len(got) != 0 {
		t.Fatalf("重挂应幂等（下一轮零命中），got %d 条", len(got))
	}
}

// TestNotificationRepo_WebhookURLCrypto webhook URL 加密落盘 + 启动期明文迁移
// （P-20261002-31；同 sshkey MigrateLegacyPem 用例形态：落盘态 enc:、
// 读路径/API 态明文、迁移幂等）
func TestNotificationRepo_WebhookURLCrypto(t *testing.T) {
	dir := t.TempDir()
	// filestore 布局：<dir>/data/<kind>/<key>.json（同 newSSHKeyTestStore 约定）
	docPath := filepath.Join(dir, "data", "notifprefs", "default.json")
	s := store.New(filestore.New(dir))
	store.SetDefault(s)

	// SavePrefs：URL（含推送密钥）加密落盘，内存回读为明文
	prefs := notification.DefaultPrefs()
	prefs.Webhook = notification.WebhookPrefs{
		Enabled: true, Mode: notification.WebhookModePost,
		URL: "https://api.day.app/secret-key?title={title}", Scope: notification.WebhookScopeAll,
	}
	if err := s.Notification.SavePrefs(prefs); err != nil {
		t.Fatalf("SavePrefs: %v", err)
	}
	raw, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatalf("read raw prefs: %v", err)
	}
	if strings.Contains(string(raw), "secret-key") {
		t.Fatalf("webhook url stored in plaintext: %s", raw)
	}
	if !strings.Contains(string(raw), "enc:") {
		t.Fatalf("expected enc: prefixed url at rest: %s", raw)
	}
	got := s.Notification.GetPrefs()
	if got.Webhook.URL != prefs.Webhook.URL {
		t.Fatalf("GetPrefs should return plaintext url, got %q", got.Webhook.URL)
	}

	// 启动期迁移：直接写入历史明文形态的偏好文档 → 迁移补加密
	legacy := `{"enabled":{"git":true},"longTaskThresholdMs":5000,"desktopNotify":true,` +
		`"webhook":{"enabled":true,"mode":"post","url":"https://ntfy.sh/legacy-topic-key","scope":"important"}}`
	if err := os.WriteFile(docPath, []byte(legacy), 0600); err != nil {
		t.Fatalf("write legacy prefs: %v", err)
	}
	// 新 Store 实例（独立内存缓存）模拟重启后迁移
	s2 := store.New(filestore.New(dir))
	n, err := s2.Notification.MigrateLegacyWebhookURL()
	if err != nil || n != 1 {
		t.Fatalf("MigrateLegacyWebhookURL = %d, %v", n, err)
	}
	raw, err = os.ReadFile(docPath)
	if err != nil {
		t.Fatalf("read migrated prefs: %v", err)
	}
	if strings.Contains(string(raw), "legacy-topic-key") || !strings.Contains(string(raw), "enc:") {
		t.Fatalf("legacy url not migrated to encrypted at rest: %s", raw)
	}
	// 幂等：已加密不再计数
	if n, err := s2.Notification.MigrateLegacyWebhookURL(); err != nil || n != 0 {
		t.Fatalf("migration should be idempotent, got n=%d err=%v", n, err)
	}
	// 迁移后读路径解密还原明文
	if got := s2.Notification.GetPrefs(); got.Webhook.URL != "https://ntfy.sh/legacy-topic-key" {
		t.Fatalf("migrated url should decrypt back, got %q", got.Webhook.URL)
	}
}

// TestNotificationRepo_ProjectMute 项目×类别二维静音（P-20261003-168）：
// 静音组合不入账（站内落库与广播共用 Add 判定点，此处验落库面），二维 AND
// 语义（同项目异类别/异项目同类别照常入账）；设置解除（SavePrefs 移除静音）
// 后同组合恢复入账
func TestNotificationRepo_ProjectMute(t *testing.T) {
	s := setupNotificationStore(t)
	n := s.Notification

	if err := n.SavePrefs(notification.Prefs{
		Enabled: notification.DefaultPrefs().Enabled,
		ProjectMutes: []notification.ProjectMute{
			{ProjectID: "proj-1", Category: notification.CategoryGit},
		},
	}); err != nil {
		t.Fatalf("SavePrefs: %v", err)
	}

	added := func(projectID, category, title string) bool {
		n.Add(notification.Notification{Type: "info", Category: category, Title: title, ProjectID: projectID})
		for _, item := range n.List(0) {
			if item.Title == title {
				return true
			}
		}
		return false
	}

	if added("proj-1", notification.CategoryGit, "muted-combo") {
		t.Fatal("静音组合（proj-1×git）不应入账")
	}
	if !added("proj-1", notification.CategoryTask, "same-proj-other-cat") {
		t.Fatal("同项目异类别应照常入账")
	}
	if !added("proj-2", notification.CategoryGit, "other-proj-same-cat") {
		t.Fatal("异项目同类别应照常入账")
	}
	// 无项目归属的系统级通知不受项目静音影响
	if !added("", notification.CategoryGit, "no-project") {
		t.Fatal("无 projectId 的通知不应被项目静音拦截")
	}

	// 解除（保存不含静音的偏好）→ 同组合恢复入账；GetPrefs 回读即归一值
	if err := n.SavePrefs(notification.Prefs{Enabled: notification.DefaultPrefs().Enabled}); err != nil {
		t.Fatalf("SavePrefs unmute: %v", err)
	}
	if mutes := n.GetPrefs().ProjectMutes; len(mutes) != 0 {
		t.Fatalf("解除后静音清单应为空，got %v", mutes)
	}
	if !added("proj-1", notification.CategoryGit, "unmuted-combo") {
		t.Fatal("解除后同组合应恢复入账")
	}
}
