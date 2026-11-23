package store_test

// 失败路径必产日志断言（P-20261122-12 必改4）：静默失败审计的修复点都要有
// 「写盘失败 → 至少一行 WARN」的可执行证据，而不是只靠人工阅读。全部经
// slog 捕获 handler + 注入型 DocumentStore 桩实证（不落真实数据目录、不依赖
// 磁盘满/权限等外部条件）。本包测试无 t.Parallel，slog.SetDefault 包级替换
// 安全（测试结束由 t.Cleanup 还原）。

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// logCapture slog.Handler 捕获器：记录全部 Warn 及以上消息。
type logCapture struct {
	mu   sync.Mutex
	msgs []string
}

func (c *logCapture) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelWarn
}
func (c *logCapture) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var b strings.Builder
	b.WriteString(r.Message)
	r.Attrs(func(a slog.Attr) bool {
		b.WriteString(" ")
		b.WriteString(a.Key)
		b.WriteString("=")
		b.WriteString(a.Value.String())
		return true
	})
	c.msgs = append(c.msgs, b.String())
	return nil
}
func (c *logCapture) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *logCapture) WithGroup(string) slog.Handler      { return c }

// captureSlog 把默认 logger 换成捕获器（测试结束还原）。
func captureSlog(t *testing.T) *logCapture {
	t.Helper()
	c := &logCapture{}
	orig := slog.Default()
	slog.SetDefault(slog.New(c))
	t.Cleanup(func() { slog.SetDefault(orig) })
	return c
}

// found 是否捕获到包含全部子串的消息。
func (c *logCapture) found(substrs ...string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.msgs {
		ok := true
		for _, s := range substrs {
			if !strings.Contains(m, s) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// dump 失败时的现场输出。
func (c *logCapture) dump() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprintf("%v", c.msgs)
}

var errInjected = fmt.Errorf("injected persist failure")

// failingDoc 注入型 DocumentStore：按开关让指定写操作失败，其余委托真实
// filestore。updateFailOrdinal>0 时仅第 N 次 Update 失败（轮换链的
// generateLocked 写 + Rotate 回写 CreatedAt 是同一条 Update 路径，须区分次序）。
type failingDoc struct {
	inner             store.DocumentStore
	failCreate        bool
	failPatch         bool
	failPatchBatch    bool
	failClear         bool
	failDeleteKeys    map[string]bool
	updateFailOrdinal int
	updateCalls       int
}

func (d *failingDoc) Create(kind, key string, data []byte) error {
	if d.failCreate {
		return errInjected
	}
	return d.inner.Create(kind, key, data)
}
func (d *failingDoc) Update(kind, key string, data []byte) error {
	d.updateCalls++
	if d.updateFailOrdinal > 0 && d.updateCalls == d.updateFailOrdinal {
		return errInjected
	}
	return d.inner.Update(kind, key, data)
}
func (d *failingDoc) Patch(kind, key string, patch map[string]any) error {
	if d.failPatch {
		return errInjected
	}
	return d.inner.Patch(kind, key, patch)
}
func (d *failingDoc) Get(kind, key string) ([]byte, error) { return d.inner.Get(kind, key) }
func (d *failingDoc) Delete(kind, key string) error {
	if d.failDeleteKeys[key] {
		return errInjected
	}
	return d.inner.Delete(kind, key)
}
func (d *failingDoc) Has(kind, key string) (bool, error) { return d.inner.Has(kind, key) }
func (d *failingDoc) Upsert(kind, key string, data []byte) error {
	return d.inner.Upsert(kind, key, data)
}
func (d *failingDoc) GetBatch(kind string, keys []string) (map[string][]byte, error) {
	return d.inner.GetBatch(kind, keys)
}
func (d *failingDoc) CreateBatch(kind string, items map[string][]byte) error {
	return d.inner.CreateBatch(kind, items)
}
func (d *failingDoc) UpdateBatch(kind string, items map[string][]byte) error {
	return d.inner.UpdateBatch(kind, items)
}
func (d *failingDoc) PatchBatch(kind string, patches map[string]map[string]any) error {
	if d.failPatchBatch {
		return errInjected
	}
	return d.inner.PatchBatch(kind, patches)
}
func (d *failingDoc) DeleteBatch(kind string, keys []string) error {
	return d.inner.DeleteBatch(kind, keys)
}
func (d *failingDoc) Clear(kind string) error {
	if d.failClear {
		return errInjected
	}
	return d.inner.Clear(kind)
}
func (d *failingDoc) List(kind string, opts store.ListOpts) ([]string, int, error) {
	return d.inner.List(kind, opts)
}
func (d *failingDoc) Count(kind string, opts store.ListOpts) (int, error) {
	return d.inner.Count(kind, opts)
}

// newRealStore 真实 filestore 支撑的 store（种子数据写入用）。
func newRealStore(t *testing.T) (*store.Store, store.DocumentStore) {
	t.Helper()
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	return store.New(doc), doc
}

// seedNotification 直接落一条通知，返回其 ID。
func seedNotification(t *testing.T, s *store.Store, title string) string {
	t.Helper()
	s.Notification.Add(notification.Notification{Type: "info", Category: "git", Title: title})
	for _, n := range s.Notification.List(0) {
		if n.Title == title {
			return n.ID
		}
	}
	t.Fatalf("种子通知 %q 未落库", title)
	return ""
}

// TestNotificationPersistFailureLogs：通知仓储全部写路径失败都必须留 WARN
// （用户可感知形态：通知丢失 / 已读又变未读 / 删了又回来）。
func TestNotificationPersistFailureLogs(t *testing.T) {
	cases := []struct {
		name   string
		fail   func(d *failingDoc, seededID string)
		setup  func(t *testing.T, doc store.DocumentStore) func(n store.NotificationStore)
		expect []string
	}{
		{
			name: "create",
			fail: func(d *failingDoc, _ string) { d.failCreate = true },
			setup: func(t *testing.T, doc store.DocumentStore) func(store.NotificationStore) {
				return func(n store.NotificationStore) {
					n.Add(notification.Notification{Type: "info", Category: "git", Title: "t"})
				}
			},
			expect: []string{"notification persist failed", "op=create", "err="},
		},
		{
			name: "mark-all-read",
			fail: func(d *failingDoc, _ string) { d.failPatchBatch = true },
			setup: func(t *testing.T, doc store.DocumentStore) func(store.NotificationStore) {
				seed := store.New(doc)
				seedNotification(t, seed, "seed-markall")
				return func(n store.NotificationStore) { n.MarkAllRead() }
			},
			expect: []string{"notification persist failed", "op=mark-all-read"},
		},
		{
			name: "mark-read",
			fail: func(d *failingDoc, _ string) { d.failPatch = true },
			setup: func(t *testing.T, doc store.DocumentStore) func(store.NotificationStore) {
				seed := store.New(doc)
				id := seedNotification(t, seed, "seed-mark")
				return func(n store.NotificationStore) { n.MarkRead(id) }
			},
			expect: []string{"notification persist failed", "op=mark-read", "id="},
		},
		{
			name: "dismiss",
			fail: func(d *failingDoc, seededID string) { d.failDeleteKeys = map[string]bool{seededID: true} },
			setup: func(t *testing.T, doc store.DocumentStore) func(store.NotificationStore) {
				seed := store.New(doc)
				id := seedNotification(t, seed, "seed-dismiss")
				return func(n store.NotificationStore) { n.Dismiss(id) }
			},
			expect: []string{"notification persist failed", "op=dismiss"},
		},
		{
			name: "clear",
			fail: func(d *failingDoc, _ string) { d.failClear = true },
			setup: func(t *testing.T, doc store.DocumentStore) func(store.NotificationStore) {
				return func(n store.NotificationStore) { n.Clear() }
			},
			expect: []string{"notification persist failed", "op=clear"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			capture := captureSlog(t)
			_, doc := newRealStore(t)
			// 种子写入走真实 doc；动作经注入桩触发失败
			run := tc.setup(t, doc)
			var seededID string
			if list := store.New(doc).Notification.List(0); len(list) > 0 {
				seededID = list[0].ID
			}
			wrapped := &failingDoc{inner: doc}
			tc.fail(wrapped, seededID)
			run(store.New(wrapped).Notification)
			if !capture.found(tc.expect...) {
				t.Fatalf("未捕获期望日志 %v，实得 %s", tc.expect, capture.dump())
			}
		})
	}
}

// TestNotificationDismissManyAggregatesFailures：批量删除失败聚合成一条
// Warn（含 failed 计数与首个 ID），且条目本就不存在（ErrNotFound）不告警。
func TestNotificationDismissManyAggregatesFailures(t *testing.T) {
	capture := captureSlog(t)
	_, doc := newRealStore(t)
	seed := store.New(doc)
	a := seedNotification(t, seed, "batch-a")
	b := seedNotification(t, seed, "batch-b")

	wrapped := &failingDoc{inner: doc, failDeleteKeys: map[string]bool{a: true}}
	store.New(wrapped).Notification.DismissMany([]string{a, b, "already-gone"})
	if !capture.found("notification batch dismiss partially failed", "failed=1") {
		t.Fatalf("批量删除未聚合成一条 Warn，实得 %s", capture.dump())
	}
	if capture.found("op=") || capture.found("mark-read") {
		t.Fatalf("ErrNotFound 不应产生告警，实得 %s", capture.dump())
	}
}

// TestNotificationDismissMissingIsSilent：单条 Dismiss 对已不存在的条目
// （ErrNotFound）静默——并发删除是幂等终态，不该刷 WARN。
func TestNotificationDismissMissingIsSilent(t *testing.T) {
	capture := captureSlog(t)
	_, doc := newRealStore(t)
	store.New(doc).Notification.Dismiss("not-exist-id")
	if capture.found("notification persist failed") {
		t.Fatalf("ErrNotFound 不应告警，实得 %s", capture.dump())
	}
}

// TestAgentTokenRotateCreatedAtRestoreFailureLogs：轮换链第二笔写（回写
// CreatedAt）失败要留 WARN——令牌本体已在首笔写盘，失败只影响元信息，
// 但静默会让「创建时间莫名变成轮换时间」永远无从归因。
func TestAgentTokenRotateCreatedAtRestoreFailureLogs(t *testing.T) {
	capture := captureSlog(t)
	seed, doc := newRealStore(t)
	if err := seed.AgentToken.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	// 第 1 次 Update 来自 generateLocked（必须成功），第 2 次是 CreatedAt 回写（失败）
	wrapped := &failingDoc{inner: doc, updateFailOrdinal: 2}
	plain, err := store.New(wrapped).AgentToken.Rotate()
	if err != nil {
		t.Fatalf("Rotate 本体不应因元信息回写失败而报错: %v", err)
	}
	if !strings.HasPrefix(plain, "sca_") {
		t.Fatalf("轮换后令牌形态异常: %q", plain)
	}
	if !capture.found("agent token created-at restore failed", "err=") {
		t.Fatalf("未捕获 CreatedAt 回写失败告警，实得 %s", capture.dump())
	}
}
