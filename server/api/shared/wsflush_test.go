package shared

import (
	"strings"
	"testing"
	"time"
)

// ============== WSOutputAggregator 单测（P-20261004-26） ==============
// 门限注入用小值拉大时序裕度：窗口断言两侧留 6 倍以上余量，CI 慢机不抖。

// TestWSOutputAggregatorCoalescesBurst 窗口内到达的多块拼成单帧、字节序完整
func TestWSOutputAggregatorCoalescesBurst(t *testing.T) {
	agg := &WSOutputAggregator{window: 200 * time.Millisecond, maxBytes: 1 << 20}
	ch := make(chan []byte, 8)
	for _, s := range []string{"b", "c", "d"} {
		ch <- []byte(s)
	}
	done := make(chan struct{})

	frame, ok := agg.Collect([]byte("a"), ch, done)
	if !ok {
		t.Fatal("Collect should succeed without done")
	}
	if got := string(frame); got != "abcd" {
		t.Fatalf("frame = %q, want %q (burst coalesced in order)", got, "abcd")
	}
	// 无后续数据：等满窗口才落帧（此时 200ms 窗口刚过即返回，此处只验证内容）
	if len(ch) != 0 {
		t.Fatalf("channel should be drained, %d chunks left", len(ch))
	}
}

// TestWSOutputAggregatorFlushesAtByteCap 字节上限先于窗口触发：聚合即时落帧、
// 不等满窗口（写延迟不随流量增长）
func TestWSOutputAggregatorFlushesAtByteCap(t *testing.T) {
	agg := &WSOutputAggregator{window: 2 * time.Second, maxBytes: 8}
	ch := make(chan []byte, 8)
	ch <- []byte("5678")
	done := make(chan struct{})

	start := time.Now()
	frame, ok := agg.Collect([]byte("1234"), ch, done)
	elapsed := time.Since(start)
	if !ok {
		t.Fatal("Collect should succeed")
	}
	if got := string(frame); got != "12345678" {
		t.Fatalf("frame = %q, want %q (cap flush)", got, "12345678")
	}
	if elapsed >= agg.window {
		t.Fatalf("cap hit must flush before window: elapsed=%v >= window=%v", elapsed, agg.window)
	}
	// 裕度断言：正常应在窗口前一小段内返回（防睡眠式实现碰巧过线）
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("cap flush should be immediate, took %v", elapsed)
	}
}

// TestWSOutputAggregatorWaitsWindowWhenIdle 孤块（交互回显形态）：无后续数据
// 时等满窗口才落帧——延迟上界 = 窗口（此处以 50ms 窗口实证「等窗」语义）
func TestWSOutputAggregatorWaitsWindowWhenIdle(t *testing.T) {
	agg := &WSOutputAggregator{window: 50 * time.Millisecond, maxBytes: 1 << 20}
	ch := make(chan []byte, 1)
	done := make(chan struct{})

	start := time.Now()
	frame, ok := agg.Collect([]byte("x"), ch, done)
	elapsed := time.Since(start)
	if !ok {
		t.Fatal("Collect should succeed")
	}
	if string(frame) != "x" {
		t.Fatalf("frame = %q, want %q", frame, "x")
	}
	if elapsed < 45*time.Millisecond {
		t.Fatalf("idle chunk must wait out the window: elapsed=%v < 45ms", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("window wait should not hang: elapsed=%v", elapsed)
	}
}

// TestWSOutputAggregatorAbortsOnDone done 关闭（客户端断开）提前放弃：
// ok=false 且不阻塞到窗口到期（主循环即时退出，连接位/资源即时释放）
func TestWSOutputAggregatorAbortsOnDone(t *testing.T) {
	agg := &WSOutputAggregator{window: 5 * time.Second, maxBytes: 1 << 20}
	ch := make(chan []byte, 1)
	done := make(chan struct{})

	go func() {
		time.Sleep(30 * time.Millisecond)
		close(done)
	}()

	start := time.Now()
	frame, ok := agg.Collect([]byte("x"), ch, done)
	elapsed := time.Since(start)
	if ok {
		t.Fatal("Collect should abort on done")
	}
	if frame != nil {
		t.Fatalf("aborted Collect should return nil frame, got %q", frame)
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("abort must not wait out the window: elapsed=%v", elapsed)
	}
}

// TestWSOutputAggregatorCapMidDrainKeepsLeftover 上限触发时通道内未消费块
// 留给下一次 Collect——合帧绝不丢数据（反压满载路径同语义）
func TestWSOutputAggregatorCapMidDrainKeepsLeftover(t *testing.T) {
	agg := &WSOutputAggregator{window: time.Second, maxBytes: 4}
	ch := make(chan []byte, 8)
	ch <- []byte("bb")
	ch <- []byte("cc")
	done := make(chan struct{})

	frame1, ok := agg.Collect([]byte("aa"), ch, done)
	if !ok || string(frame1) != "aabb" {
		t.Fatalf("frame1 = %q ok=%v, want %q", frame1, ok, "aabb")
	}
	// "cc" 仍在通道：第二次 Collect 以其为首块拼出
	frame2, ok := agg.Collect([]byte("dd"), ch, done)
	if !ok || string(frame2) != "ddcc" {
		t.Fatalf("frame2 = %q ok=%v, want %q (leftover preserved)", frame2, ok, "ddcc")
	}
}

// TestWSOutputAggregatorNoCarryover 内部缓冲跨调用复用：上一帧字节不得混入
// 下一帧（回归缓冲复位语义）
func TestWSOutputAggregatorNoCarryover(t *testing.T) {
	agg := &WSOutputAggregator{window: 20 * time.Millisecond, maxBytes: 1 << 20}
	ch := make(chan []byte, 1)
	done := make(chan struct{})

	first, ok := agg.Collect([]byte(strings.Repeat("A", 100)), ch, done)
	if !ok || len(first) != 100 {
		t.Fatalf("first frame len = %d, want 100", len(first))
	}
	second, ok := agg.Collect([]byte(strings.Repeat("B", 50)), ch, done)
	if !ok {
		t.Fatal("second Collect should succeed")
	}
	if got := string(second); got != strings.Repeat("B", 50) {
		t.Fatalf("second frame carried over first's bytes: %q", got[:min(len(got), 60)])
	}
}

// TestWSOutputAggregatorZeroWindowDegenerate window=0 时 timer 立即到期：
// 退化为「首块直通」，不 panic 不阻塞（防御性——生产恒用构造器默认门限）
func TestWSOutputAggregatorZeroWindowDegenerate(t *testing.T) {
	agg := &WSOutputAggregator{maxBytes: 1 << 20}
	ch := make(chan []byte, 1)
	ch <- []byte("late")
	done := make(chan struct{})

	frame, ok := agg.Collect([]byte("x"), ch, done)
	// timer 到期与通道就绪竞争（select 随机）：返回 "x" 或拼上残留的 "xlate" 皆合法
	if !ok || (string(frame) != "x" && string(frame) != "xlate") {
		t.Fatalf("frame = %q ok=%v, want degenerate passthrough", frame, ok)
	}
}
