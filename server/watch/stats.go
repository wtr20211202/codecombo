package watch

import (
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

// 监听器运行统计（P-20261124-1 S1⑥b）：诊断包回答「事件还在来吗、有没有
// 溢出丢事件、最后一次错误是什么类别」——溢出（inotify IN_Q_OVERFLOW）意味着
// 「文件改了但前端没收到」，是排障时最容易被误判为前端 bug 的一类。
//
// 只出计数/类别，不出路径、不出 error 原文：路径含项目名/用户名，error 原文
// 可能带被监听的完整路径。maxQueuedEvents 读 /proc/sys/fs/inotify 只取数值。
//
// 统计经 watchapi.Control.WatcherStats() 桥接（api 层不 import watch，与
// FallbackStatus 同一注入模式），未装配/未 Start/已 Stop 写 skipped。

// watcherStats 原子计数域（零值可用）
type watcherStats struct {
	eventsTotal    atomic.Int64
	overflowTotal  atomic.Int64
	lastOverflow   atomic.Int64 // unix nano
	lastErrorClass atomic.Value // string
	started        atomic.Bool
	stopped        atomic.Bool
}

// WatcherStats 诊断包注入面（JSON 字段即包内 state/runtime.json 的 watcher 段）
type WatcherStats struct {
	Status          string `json:"status"` // ok | skipped
	Reason          string `json:"reason,omitempty"`
	EventsTotal     int64  `json:"eventsTotal"`
	OverflowTotal   int64  `json:"overflowTotal"`
	LastOverflowAt  string `json:"lastOverflowAt,omitempty"`
	LastErrorClass  string `json:"lastErrorClass,omitempty"`
	WatchCount      int    `json:"watchCount"`
	MaxQueuedEvents int64  `json:"maxQueuedEvents,omitempty"`
	MaxQueuedStatus string `json:"maxQueuedStatus,omitempty"`
	Note            string `json:"note"`
}

// noteEvent 记一条成功进入循环的 fs 事件
func (rw *RepoWatcher) noteEvent() { rw.stats.eventsTotal.Add(1) }

// noteError 记一条 Errors 通道错误（只留类别，不留原文/路径）
func (rw *RepoWatcher) noteError(err error) {
	class := classifyWatchError(err)
	rw.stats.lastErrorClass.Store(class)
	if class == "overflow" {
		rw.stats.overflowTotal.Add(1)
		rw.stats.lastOverflow.Store(time.Now().UnixNano())
	}
}

func classifyWatchError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, fsnotify.ErrEventOverflow):
		return "overflow"
	case errors.Is(err, fsnotify.ErrNonExistentWatch):
		return "non_existent_watch"
	case strings.Contains(strings.ToLower(err.Error()), "too many open files"):
		return "too_many_open_files"
	case strings.Contains(strings.ToLower(err.Error()), "no space"):
		return "no_space"
	default:
		return "other"
	}
}

// Stats 当前监听统计（未 Start / 已 Stop 时 status=skipped）
func (rw *RepoWatcher) Stats() WatcherStats {
	st := WatcherStats{
		Note: "counts/classes only — no watched paths and no raw error text are recorded",
	}
	if rw == nil {
		st.Status = "skipped"
		st.Reason = "watch module not initialized"
		return st
	}
	if class, _ := rw.stats.lastErrorClass.Load().(string); class != "" {
		st.LastErrorClass = class
	}
	if ts := rw.stats.lastOverflow.Load(); ts > 0 {
		st.LastOverflowAt = time.Unix(0, ts).Format(time.RFC3339)
	}
	st.EventsTotal = rw.stats.eventsTotal.Load()
	st.OverflowTotal = rw.stats.overflowTotal.Load()
	if rw.watcher != nil {
		st.WatchCount = len(rw.watcher.WatchList())
	}
	st.MaxQueuedEvents, st.MaxQueuedStatus = maxQueuedEvents()
	switch {
	case !rw.stats.started.Load():
		st.Status = "skipped"
		st.Reason = "watcher not started"
		return st
	case rw.stats.stopped.Load():
		st.Status = "skipped"
		st.Reason = "watcher stopped"
		return st
	}
	st.Status = "ok"
	return st
}

// maxQueuedEvents inotify 队列上限（仅 Linux 有该内核参数；其它平台显式 skipped）
func maxQueuedEvents() (int64, string) {
	if runtime.GOOS != "linux" {
		return 0, "skipped: not a Linux inotify host"
	}
	b, err := os.ReadFile("/proc/sys/fs/inotify/max_queued_events")
	if err != nil {
		return 0, "skipped: " + classifyProcReadError(err)
	}
	n, perr := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if perr != nil {
		return 0, "skipped: unparsable /proc/sys/fs/inotify/max_queued_events"
	}
	return n, "ok"
}

// classifyProcReadError /proc 读取失败类别（不把路径/原始错误带进包）
func classifyProcReadError(err error) string {
	switch {
	case os.IsNotExist(err):
		return "not present"
	case os.IsPermission(err):
		return "permission denied"
	default:
		return "read error"
	}
}
