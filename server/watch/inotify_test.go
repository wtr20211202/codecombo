package watch

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// recorder 通知投递收集器（注入用）：按序收集断言构造与去重
type recorder struct{ got []notification.Notification }

func (r *recorder) add(n notification.Notification) { r.got = append(r.got, n) }

// TestIsENOSPC_ClassifiesQuotaError ENOSPC 特征识别：fsnotify 透传的
// syscall.Errno 及其常见包装（os.SyscallError / fmt.Errorf %w）都必须命中；
// 非 ENOSPC 错误（关闭态/不存在/EOF/nil）不得误报
func TestIsENOSPC_ClassifiesQuotaError(t *testing.T) {
	positive := []error{
		syscall.ENOSPC,
		os.NewSyscallError("inotify_add_watch", syscall.ENOSPC),
		fmt.Errorf("add watch: %w", os.NewSyscallError("inotify_add_watch", syscall.ENOSPC)),
	}
	for _, err := range positive {
		if !isENOSPC(err) {
			t.Errorf("isENOSPC(%v) = false, want true", err)
		}
	}
	negative := []error{
		nil,
		io.EOF,
		syscall.ENOENT,
		errors.New("fsnotify: watcher is already closed"),
		os.NewSyscallError("inotify_add_watch", syscall.ENOENT),
	}
	for _, err := range negative {
		if isENOSPC(err) {
			t.Errorf("isENOSPC(%v) = true, want false", err)
		}
	}
}

// TestInotifyCheck_ExhaustedNotification ENOSPC 实际发生 → 事实告警：
// 构造（warning/system/模板键/中文回退/参数 n+limit）与一次性去重
func TestInotifyCheck_ExhaustedNotification(t *testing.T) {
	rec := &recorder{}
	g := &inotifyGuard{
		notify: rec.add,
		limit:  func() (int, bool) { return 8192, true },
	}
	g.check(10, 13, 3)
	if len(rec.got) != 1 {
		t.Fatalf("first check produced %d notifications, want 1", len(rec.got))
	}
	n := rec.got[0]
	if n.Type != "warning" || n.Category != notification.CategorySystem {
		t.Errorf("type/category = %s/%s, want warning/system", n.Type, n.Category)
	}
	if n.TitleKey != "notify.inotify.exhausted.title" || n.BodyKey != "notify.inotify.exhausted.body" {
		t.Errorf("template keys = %s/%s", n.TitleKey, n.BodyKey)
	}
	if n.Title == "" {
		t.Error("Title fallback must be non-empty (webhook/desktop consumers)")
	}
	if n.MsgParams["n"] != 3 {
		t.Errorf("MsgParams n = %v, want 3", n.MsgParams["n"])
	}
	if n.MsgParams["limit"] != "8192" {
		t.Errorf("MsgParams limit = %v, want \"8192\"", n.MsgParams["limit"])
	}

	// 一次性去重：后续轮次再失败不重复告警
	g.check(10, 20, 10)
	if len(rec.got) != 1 {
		t.Fatalf("second check produced %d notifications, want 0 more", len(rec.got)-1)
	}
}

// TestInotifyCheck_ExhaustedLimitUnknown 上限读不到时告警仍应发出，
// limit 参数显式标注未知（不假装可读）
func TestInotifyCheck_ExhaustedLimitUnknown(t *testing.T) {
	rec := &recorder{}
	g := &inotifyGuard{
		notify: rec.add,
		limit:  func() (int, bool) { return 0, false },
	}
	g.check(0, 4, 4)
	if len(rec.got) != 1 {
		t.Fatalf("produced %d notifications, want 1", len(rec.got))
	}
	if got := rec.got[0].MsgParams["limit"]; got != "unknown" {
		t.Errorf("MsgParams limit = %v, want \"unknown\"", got)
	}
}

// TestInotifyCheck_NearLimitRatio 预判线：总数恰好 80% 不报（不越线不扰），
// 越过 80% 报一次预警后去重；预判与事实是两个独立类别
func TestInotifyCheck_NearLimitRatio(t *testing.T) {
	rec := &recorder{}
	g := &inotifyGuard{
		notify: rec.add,
		limit:  func() (int, bool) { return 100, true },
	}
	g.check(80, 80, 0)
	if len(rec.got) != 0 {
		t.Fatalf("80%% of limit should not warn, got %d", len(rec.got))
	}
	g.check(81, 81, 0)
	if len(rec.got) != 1 {
		t.Fatalf("81%% of limit should warn once, got %d", len(rec.got))
	}
	n := rec.got[0]
	if n.TitleKey != "notify.inotify.near.title" {
		t.Errorf("TitleKey = %s, want notify.inotify.near.title", n.TitleKey)
	}
	if n.MsgParams["count"] != 81 || n.MsgParams["limit"] != "100" {
		t.Errorf("MsgParams = %v, want count=81 limit=100", n.MsgParams)
	}
	if n.MsgParams["pct"] != 81 {
		t.Errorf("MsgParams pct = %v, want 81", n.MsgParams["pct"])
	}
	g.check(90, 90, 0)
	if len(rec.got) != 1 {
		t.Errorf("near-limit must fire only once, got %d", len(rec.got))
	}
}

// TestInotifyCheck_ExhaustedSuppressesNearInSameRound 同轮 ENOSPC 已报事实，
// 「接近上限」预判不再叠加（配额已耗尽时预判是冗余打扰）
func TestInotifyCheck_ExhaustedSuppressesNearInSameRound(t *testing.T) {
	rec := &recorder{}
	g := &inotifyGuard{
		notify: rec.add,
		limit:  func() (int, bool) { return 4, true },
	}
	g.check(0, 4, 4) // 100% 越预判线，但同轮已有事实告警
	for _, n := range rec.got {
		if n.TitleKey != "notify.inotify.exhausted.title" {
			t.Errorf("unexpected notification %s, want only exhausted", n.TitleKey)
		}
	}
	if len(rec.got) != 1 {
		t.Fatalf("produced %d notifications, want 1 (exhausted only)", len(rec.got))
	}
}

// TestInotifyCheck_NoChannelSkipsWithoutConsuming 投递口与 store 均未装配
// 时静默跳过：不 panic、不消耗一次性状态（之后装配了仍能告警）
func TestInotifyCheck_NoChannelSkipsWithoutConsuming(t *testing.T) {
	store.SetDefault(nil)
	t.Cleanup(func() { store.SetDefault(nil) })

	g := &inotifyGuard{limit: func() (int, bool) { return 10, true }}
	g.check(0, 9, 9) // 无投递口：跳过

	rec := &recorder{}
	g.notify = rec.add
	g.check(0, 9, 9) // 装配后同轮：应照常告警（状态未被提前消耗）
	if len(rec.got) != 1 {
		t.Fatalf("produced %d notifications after channel assembled, want 1", len(rec.got))
	}
}

// TestReadInotifyWatchesLimit 探测口契约：/proc 文件存在（Linux）时必须读出
// 正值；读不到时返回 ok=false——调用方跳过预判、不猜默认值
func TestReadInotifyWatchesLimit(t *testing.T) {
	limit, ok := readInotifyWatchesLimit()
	if ok {
		if limit <= 0 {
			t.Fatalf("probe returned ok with non-positive limit %d", limit)
		}
		return
	}
	if _, err := os.Stat(inotifyWatchesPath); err == nil {
		t.Fatalf("%s exists but probe failed", inotifyWatchesPath)
	}
}

// TestInotifyCheck_UnreadableLimitSkipsNear 上限读不到（非 Linux）时预判
// 跳过而非误报——平台自适应的回归锚
func TestInotifyCheck_UnreadableLimitSkipsNear(t *testing.T) {
	rec := &recorder{}
	g := &inotifyGuard{
		notify: rec.add,
		limit:  func() (int, bool) { return 0, false },
	}
	g.check(1<<20, 1<<20, 0)
	if len(rec.got) != 0 {
		t.Errorf("unreadable limit must skip near-limit warning, got %d", len(rec.got))
	}
}

// TestAddDirRecursive_WiresQuotaCheck 收口接线验证：真实 fsnotify watcher
// + 极小注入上限 → 健康遍历也能触发预判告警，且跨轮一次性；上限放大后
// 同样健康的遍历零告警（不误扰）
func TestAddDirRecursive_WiresQuotaCheck(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"a", "b", "c"} {
		if err := os.Mkdir(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw.Stop)

	rec := &recorder{}
	rw.inotify.notify = rec.add
	rw.inotify.limit = func() (int, bool) { return 1, true } // 任何目录都越 80% 线

	if _, err := rw.addDirRecursive(root); err != nil {
		t.Fatal(err)
	}
	if len(rec.got) != 1 || rec.got[0].TitleKey != "notify.inotify.near.title" {
		t.Fatalf("wired check should fire near-limit once, got %+v", rec.got)
	}
	if _, err := rw.addDirRecursive(root); err != nil {
		t.Fatal(err)
	}
	if len(rec.got) != 1 {
		t.Fatalf("second round must stay deduped, got %d", len(rec.got))
	}

	// 上限不可达的健康遍历：零告警
	rec2 := &recorder{}
	rw2, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw2.Stop)
	rw2.inotify.notify = rec2.add
	rw2.inotify.limit = func() (int, bool) { return 1 << 30, true }
	if _, err := rw2.addDirRecursive(root); err != nil {
		t.Fatal(err)
	}
	if len(rec2.got) != 0 {
		t.Fatalf("healthy walk should not notify, got %+v", rec2.got)
	}
}
