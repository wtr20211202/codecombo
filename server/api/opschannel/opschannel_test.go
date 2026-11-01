package opschannel

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/metrics"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
)

// 广播队列丢弃观测面（P-20261004-70）单测：
// 丢弃计数/消费滞后 gauge / debug 聚合节流 / 风暴自愈一次性 info 汇总 / 并发安全。
//
// 确定性手法：包级 h 换成不带 dispatchLoop 的小容量 hub——init() 拉起的常驻
// dispatchLoop 持有的是换出前那个 h（go 语句求值时机），换出后无人向旧队列
// 发送，旧 loop 永久阻塞在 receive 上无害；测试 hub 无消费者，入队满即丢弃，
// 结果完全可预期。用毕还原 h，后续用例照常走真实 hub。

// swapTestHub 换入容量 n、无消费者 loop 的测试 hub，返回后用 t.Cleanup 还原
func swapTestHub(t *testing.T, n int) {
	t.Helper()
	old := h
	h = &hub{clients: make(map[*wssafe.Conn]struct{}), queue: make(chan Event, n)}
	t.Cleanup(func() { h = old })
}

// resetDrops 复位风暴聚合器与指标面（与 ai 包 setupRateLimitTest 的
// metrics.ResetForTesting 同思路：聚合器窗口跨用例共享，不复位互相污染）
func resetDrops(t *testing.T) {
	t.Helper()
	metrics.ResetForTesting()
	old := drops
	drops = &dropTracker{byType: make(map[string]int64)}
	t.Cleanup(func() { drops = old; metrics.ResetForTesting() })
}

// snapshotDrops 聚合器状态快照（同包测试观测口）
func snapshotDrops() (total int64, byType map[string]int64) {
	drops.mu.Lock()
	defer drops.mu.Unlock()
	total = drops.total
	byType = make(map[string]int64, len(drops.byType))
	for k, c := range drops.byType {
		byType[k] = c
	}
	return total, byType
}

// captureLogs 接管默认 slog（Debug 级全收），返回缓冲区，用毕还原
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

// TestBroadcastDropCountsByTypeAndQueueDepth 队列满丢弃按 type 计数 +
// 消费滞后 gauge 两侧同步：满 2 条后第 3 条丢弃，计数器带 type 标签进
// /api/metrics，gauge 停在队列深度（丢弃路径不改变水位）
func TestBroadcastDropCountsByTypeAndQueueDepth(t *testing.T) {
	swapTestHub(t, 2)
	resetDrops(t)

	BroadcastEvent(EventApprovalResolved, gin.H{"id": "a"})
	BroadcastEvent(EventTerminalsChanged, gin.H{"sessions": []string{"s1"}})
	BroadcastEvent(EventApprovalResolved, gin.H{"id": "b"}) // 队列满，丢弃

	render := metrics.Render()
	if !strings.Contains(render, `sc_ops_channel_broadcast_dropped_total{type="approval.resolved"} 1`) {
		t.Fatalf("metrics expect dropped counter approval.resolved=1, got:\n%s", render)
	}
	if strings.Contains(render, `sc_ops_channel_broadcast_dropped_total{type="terminals.changed"`) {
		t.Fatalf("queued event must not be counted as dropped, got:\n%s", render)
	}
	if !strings.Contains(render, "sc_ops_channel_queue_depth 2") {
		t.Fatalf("metrics expect queue depth gauge 2, got:\n%s", render)
	}

	total, byType := snapshotDrops()
	if total != 1 || byType[EventApprovalResolved] != 1 {
		t.Fatalf("tracker expect total=1 byType[approval.resolved]=1, got total=%d byType=%v", total, byType)
	}
}

// TestDropStormDebugAggregationThrottled 风暴进行中 debug 聚合按间隔节流：
// 窗口内多次丢弃只发一条聚合，窗口过后首丢再发且携带跨窗口累计
// （发射点=窗口后首个丢弃，持续风暴下即周期性累计口径）
func TestDropStormDebugAggregationThrottled(t *testing.T) {
	swapTestHub(t, 1)
	resetDrops(t)
	oldInterval := dropDebugInterval
	dropDebugInterval = 50 * time.Millisecond
	t.Cleanup(func() { dropDebugInterval = oldInterval })
	buf := captureLogs(t)

	// 首丢即发（聚合器零值起算，total=1）
	drops.recordDrop(EventApprovalPending)
	if got := strings.Count(buf.String(), "dropping events"); got != 1 {
		t.Fatalf("first drop must emit one debug line, got %d:\n%s", got, buf.String())
	}

	// 窗口内连发：节流不加行
	for i := 0; i < 5; i++ {
		drops.recordDrop(EventApprovalPending)
	}
	if got := strings.Count(buf.String(), "dropping events"); got != 1 {
		t.Fatalf("debug aggregation must throttle to 1 line in window, got %d:\n%s", got, buf.String())
	}

	// 窗口过后首丢再发：累计口径跨窗口（6 approval.pending + 1 navigate = 7）
	time.Sleep(150 * time.Millisecond)
	drops.recordDrop(EventNavigate)
	if got := strings.Count(buf.String(), "dropping events"); got != 2 {
		t.Fatalf("expect second debug line after interval, got %d:\n%s", got, buf.String())
	}
	if !strings.Contains(buf.String(), "droppedTotal=7") ||
		!strings.Contains(buf.String(), `byType="approval.pending×6, navigate×1"`) {
		t.Fatalf("second line must carry storm-cumulative totals/distribution:\n%s", buf.String())
	}

	// 新窗口内继续丢弃：仍只有 2 行
	drops.recordDrop(EventNavigate)
	if got := strings.Count(buf.String(), "dropping events"); got != 2 {
		t.Fatalf("in-window drop must not emit, got %d lines:\n%s", got, buf.String())
	}
}

// TestDropStormRecoverySummaryOnce 风暴自愈：静默窗过后首个成功入队触发
// 一次性 info 汇总（总数/类型分布）并复位聚合器——复位后短时间内的成功
// 入队不再重复汇总
func TestDropStormRecoverySummaryOnce(t *testing.T) {
	swapTestHub(t, 1)
	resetDrops(t)
	oldQuiet := dropQuietWindow
	dropQuietWindow = 30 * time.Millisecond
	t.Cleanup(func() { dropQuietWindow = oldQuiet })
	buf := captureLogs(t)

	BroadcastEvent(EventApprovalResolved, gin.H{"id": "a"}) // 入队
	BroadcastEvent(EventSettingsChanged, nil)               // 满，丢弃
	BroadcastEvent(EventNavigate, nil)                      // 丢弃

	// 排空队列腾出容量，静默超窗后首个成功入队触发汇总
	<-h.queue
	time.Sleep(100 * time.Millisecond)
	BroadcastEvent(EventProjectsChanged, nil)
	if got := strings.Count(buf.String(), "recovered from drop storm"); got != 1 {
		t.Fatalf("expect exactly 1 recovery summary, got %d:\n%s", got, buf.String())
	}
	if !strings.Contains(buf.String(), "droppedTotal=2") ||
		!strings.Contains(buf.String(), "navigate×1") ||
		!strings.Contains(buf.String(), "settings.changed×1") {
		t.Fatalf("summary missing totals/distribution:\n%s", buf.String())
	}
	if total, _ := snapshotDrops(); total != 0 {
		t.Fatalf("tracker must reset after summary, got total=%d", total)
	}

	// 复位后立即成功入队：stormActive 已清，不重复汇总
	// （先排空上一条——cap=1 不排空则本次走丢弃路径，反而会记新风暴）
	<-h.queue
	before := buf.Len()
	BroadcastEvent(EventProjectsChanged, nil)
	if buf.Len() != before {
		t.Fatalf("no log expected after reset, got:\n%s", buf.String())
	}
}

// TestBroadcastDropConcurrent 并发安全（配 -race 跑）：多 goroutine 并发广播
// 打满小队列，丢弃/入队路径并发进出聚合器——账面守恒：丢弃总数 + 队列滞留
// == 发送总数，且复位与计数无交叉窗口撕裂
func TestBroadcastDropConcurrent(t *testing.T) {
	swapTestHub(t, 8)
	resetDrops(t)
	oldQuiet := dropQuietWindow
	dropQuietWindow = time.Hour // 不让自愈汇总在并发窗口内复位，账面才可对账
	t.Cleanup(func() { dropQuietWindow = oldQuiet })

	const workers, each = 8, 50
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				BroadcastEvent(EventTaskProgress, gin.H{"w": w, "i": i})
			}
		}()
	}
	wg.Wait()

	total, _ := snapshotDrops()
	delivered := len(h.queue)
	if total+int64(delivered) != workers*each {
		t.Fatalf("accounting broken: dropped=%d queued=%d want sum=%d", total, delivered, workers*each)
	}
	if total == 0 {
		t.Fatalf("queue cap 8 vs 400 sends must produce drops")
	}

	// 自愈路径并发复核：排空 + 缩窗后逐条成功入队，汇总恰好一次
	buf := captureLogs(t)
	dropQuietWindow = time.Millisecond
	for delivered > 0 {
		<-h.queue
		delivered--
	}
	time.Sleep(5 * time.Millisecond)
	for i := 0; i < 3; i++ {
		BroadcastEvent(EventSettingsChanged, nil)
	}
	if got := strings.Count(buf.String(), "recovered from drop storm"); got != 1 {
		t.Fatalf("expect exactly 1 recovery summary after drain, got %d:\n%s", got, buf.String())
	}
}
