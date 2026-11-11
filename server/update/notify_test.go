package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 结果观察窗（P-20261109-10）守护：结果文件 → 通知的形态映射、新鲜且未推送
// 才推、推送后 notifiedAt 记账跨重启防重（Timestamp 锚不被改写）、晚到的
// 结果文件（新进程健康检查通过后才落盘）被窗口轮询接住。

func TestResultNotificationShapes(t *testing.T) {
	// 成功：版本取本进程构建版本（中心链结果 version 为 "center" 字面量）
	n, ok := resultNotification(&UpdateResult{Status: "success", Version: "center"}, "1.2.3")
	if !ok || n.Type != "success" || n.TitleKey != notifySuccessTitleKey || n.MsgParams["version"] != "1.2.3" ||
		n.BodyKey != notifySuccessBodyKey {
		t.Fatalf("success shape = %+v", n)
	}
	// 开发构建 + 中心链：无可展示版本 → 无版本号标题
	n, _ = resultNotification(&UpdateResult{Status: "success", Version: "center"}, "dev")
	if n.TitleKey != notifySuccessTitleBareKey {
		t.Fatalf("bare success title key = %s", n.TitleKey)
	}
	// 回滚：warning + 原因进 Body + 动作回面板，正文带被恢复的版本
	n, ok = resultNotification(&UpdateResult{Status: "rolled_back", Version: "9.9.9", Error: "health check failed"}, "1.2.3")
	if !ok || n.Type != "warning" || n.Body != "health check failed" || n.Action != ActionUpdatePanel ||
		n.BodyKey != notifyRolledBackBodyKey || n.MsgParams["version"] != "1.2.3" {
		t.Fatalf("rolled back shape = %+v", n)
	}
	// 子进程侧失败 + 中心链版本：无版本号失败标题，原因进 Body
	n, ok = resultNotification(&UpdateResult{Status: "failed", Version: "center", Error: "backup failed"}, "1.2.3")
	if !ok || n.Type != "error" || n.TitleKey != notifyFailedTitleBareKey || n.Body != "backup failed" {
		t.Fatalf("failed shape = %+v", n)
	}
	if _, ok := resultNotification(&UpdateResult{Status: "weird"}, "1.2.3"); ok {
		t.Fatal("unknown status must not map to a notification")
	}
}

func TestPublishUpdateResultOnceAndMarks(t *testing.T) {
	dd := t.TempDir()
	notes := captureNotifications(t)
	if err := SaveUpdateResult(dd, &UpdateResult{Status: "success", Version: "1.2.3"}); err != nil {
		t.Fatal(err)
	}
	before, _ := LoadUpdateResult(dd)

	if !publishUpdateResult(dd, "1.2.3", time.Now()) {
		t.Fatal("fresh result should be handled")
	}
	if got := notes(); len(got) != 1 || got[0].TitleKey != notifySuccessTitleKey {
		t.Fatalf("want one success notification, got %+v", got)
	}
	after, _ := LoadUpdateResult(dd)
	if after.NotifiedAt == "" || after.Timestamp != before.Timestamp {
		t.Fatalf("notifiedAt must be set and timestamp kept: before=%+v after=%+v", before, after)
	}

	// 再观察（窗口内重启的新进程）：已推送过 → 处置但不重推
	if !publishUpdateResult(dd, "1.2.3", time.Now()) || len(notes()) != 1 {
		t.Fatalf("notified result must not republish, got %d", len(notes()))
	}
}

func TestPublishUpdateResultStaleOrPending(t *testing.T) {
	dd := t.TempDir()
	notes := captureNotifications(t)

	// 无结果文件：未落盘，继续等
	if publishUpdateResult(dd, "1.2.3", time.Now()) {
		t.Fatal("missing result should keep waiting")
	}
	// 半写/坏 JSON：继续等（子进程写盘中）
	if err := os.WriteFile(filepath.Join(dd, "update-result.json"), []byte("{\"status\":"), 0644); err != nil {
		t.Fatal(err)
	}
	if publishUpdateResult(dd, "1.2.3", time.Now()) {
		t.Fatal("corrupt result should keep waiting")
	}
	// 陈旧（超 5 分钟新鲜窗）：处置但不推
	old := &UpdateResult{Status: "success", Version: "1.2.3", Timestamp: time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)}
	if err := writeUpdateResult(dd, old); err != nil {
		t.Fatal(err)
	}
	if !publishUpdateResult(dd, "1.2.3", time.Now()) {
		t.Fatal("stale result should be handled (skipped)")
	}
	if n := len(notes()); n != 0 {
		t.Fatalf("stale result must not notify, got %d", n)
	}
}

// 晚到的结果文件：Start 时尚不存在（新进程健康检查通过后子进程才落盘），
// 观察窗轮询接住并推送一次
func TestWatchUpdateResultCatchesLateResult(t *testing.T) {
	dd := t.TempDir()
	notes := captureNotifications(t)
	origWin, origInt := resultWatchWindow.Load(), resultWatchInterval.Load()
	resultWatchWindow.Store(3 * time.Second)
	resultWatchInterval.Store(10 * time.Millisecond)
	t.Cleanup(func() { resultWatchWindow.Store(origWin); resultWatchInterval.Store(origInt) })

	m := NewModule("1.2.3")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan struct{})
	go func() {
		m.watchUpdateResult(ctx, dd)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)
	if err := SaveUpdateResult(dd, &UpdateResult{Status: "rolled_back", Version: "9.9.9", Error: "health check timeout"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("watcher should finish once the result lands")
	}
	got := notes()
	if len(got) != 1 || got[0].Type != "warning" || got[0].Body != "health check timeout" {
		t.Fatalf("want one rolled-back notification, got %+v", got)
	}
}

// 停机即退出（内核契约「Stop 后无副作用」）
func TestWatchUpdateResultStopsOnCancel(t *testing.T) {
	origWin, origInt := resultWatchWindow.Load(), resultWatchInterval.Load()
	resultWatchWindow.Store(time.Minute)
	resultWatchInterval.Store(10 * time.Millisecond)
	t.Cleanup(func() { resultWatchWindow.Store(origWin); resultWatchInterval.Store(origInt) })

	m := NewModule("1.2.3")
	dd := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.watchUpdateResult(ctx, dd)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("watcher must exit on cancel")
	}
}
