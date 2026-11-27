package watch

import (
	"testing"

	"github.com/fsnotify/fsnotify"
)

// P-20261124-1 S1⑥b：监听统计只出计数/类别，未 Start 写 skipped
func TestWatcherStatsCountsAndSkipState(t *testing.T) {
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Skipf("fsnotify unavailable: %v", err)
	}
	defer rw.Stop()

	if st := rw.Stats(); st.Status != "skipped" {
		t.Fatalf("not started yet: status=%q reason=%q", st.Status, st.Reason)
	}
	rw.noteEvent()
	rw.noteEvent()
	rw.noteError(fsnotify.ErrEventOverflow)
	st := rw.Stats()
	if st.EventsTotal != 2 || st.OverflowTotal != 1 {
		t.Fatalf("events=%d overflow=%d", st.EventsTotal, st.OverflowTotal)
	}
	if st.LastErrorClass != "overflow" || st.LastOverflowAt == "" {
		t.Fatalf("error class/at = %q/%q", st.LastErrorClass, st.LastOverflowAt)
	}
	// Start/Stop 只影响状态判定（真监听不在这里拉起：WatchAll 需要 store）
	rw.stats.started.Store(true)
	if st := rw.Stats(); st.Status != "ok" {
		t.Fatalf("started => ok, got %q", st.Status)
	}
	rw.stats.stopped.Store(true)
	if st := rw.Stats(); st.Status != "skipped" || st.Reason != "watcher stopped" {
		t.Fatalf("stopped => skipped, got %q/%q", st.Status, st.Reason)
	}
	if st := rw.Stats(); st.Note == "" {
		t.Fatal("note must state what is NOT recorded (no paths / no raw error text)")
	}
}
