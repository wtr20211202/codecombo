package liveterm

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSession 可编程桩会话：手工派发输出/注销，回看返回录制的历史
type fakeSession struct {
	mu         sync.Mutex
	handlers   map[int]func([]byte)
	nextID     int
	scrollback []byte
	cols, rows uint16
}

func newFakeSession(scrollback []byte) *fakeSession {
	return &fakeSession{handlers: map[int]func([]byte){}, scrollback: scrollback, cols: 100, rows: 30}
}

func (f *fakeSession) OnOutput(h func([]byte)) (unregister func()) {
	f.mu.Lock()
	id := f.nextID
	f.nextID++
	f.handlers[id] = h
	f.mu.Unlock()
	return func() {
		f.mu.Lock()
		delete(f.handlers, id)
		f.mu.Unlock()
	}
}

func (f *fakeSession) CaptureScrollback(int) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scrollback, nil
}

func (f *fakeSession) Size() (uint16, uint16) { return f.cols, f.rows }

func (f *fakeSession) emit(data []byte) {
	f.mu.Lock()
	hs := make([]func([]byte), 0, len(f.handlers))
	for _, h := range f.handlers {
		hs = append(hs, h)
	}
	f.mu.Unlock()
	for _, h := range hs {
		h(data)
	}
}

func (f *fakeSession) handlerCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.handlers)
}

// collectFor 聚合实时字节直到断言通过或超时（tap 回调异步，输出到达有时序抖动）
func collectFor(t *testing.T, s Subscription, until func([]byte) bool) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var out []byte
	for time.Now().Before(deadline) {
		select {
		case b, ok := <-s.Live():
			if !ok {
				return out
			}
			out = append(out, b...)
			if until(out) {
				return out
			}
		case <-s.Done():
			return out
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatal("collectFor timeout")
	return nil
}

// ── 步骤 1：直播源（tap 收到输出、注销后停流） ──

func TestWireTapReceivesOutput(t *testing.T) {
	sess := newFakeSession([]byte("seed-screen\r\n"))
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	sub, err := h.Subscribe("tok1", "s-1")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(sub.Release)

	// 播种：创建时回看的 scrollback 已遮蔽化进尾流快照
	if !bytes.Contains(sub.Tail(), []byte("seed-screen")) {
		t.Fatalf("tail missing seed scrollback: %q", sub.Tail())
	}
	cols, rows := sub.Size()
	if cols != 100 || rows != 30 {
		t.Fatalf("size = %dx%d, want 100x30", cols, rows)
	}

	sess.emit([]byte("hello-live"))
	got := collectFor(t, sub, func(b []byte) bool { return bytes.Contains(b, []byte("hello-live")) })
	if !bytes.Contains(got, []byte("hello-live")) {
		t.Fatalf("live output missing: %q", got)
	}
}

func TestUnwireStopsStream(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	if sess.handlerCount() != 1 {
		t.Fatalf("tap not registered: %d", sess.handlerCount())
	}
	sub, err := h.Subscribe("tok1", "s-1")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Release()

	h.Unwire("tok1")
	<-sub.Done() // 馈线终结信号即时可达
	if sess.handlerCount() != 0 {
		t.Fatalf("tap not unregistered after unwire: %d", sess.handlerCount())
	}
	sess.emit([]byte("after-unwire"))
	select {
	case b := <-sub.Live():
		t.Fatalf("output after unwire: %q", b)
	case <-time.After(100 * time.Millisecond):
	}
}

// 会话被移除（关闭）→ AddOnChange 对账终结馈线、tap 注销
func TestSessionCloseEndsFeed(t *testing.T) {
	sess := newFakeSession(nil)
	present := map[string]bool{"s-alive": true}
	SetSessionLookup(func(id string) LiveSession {
		if present[id] {
			return sess
		}
		return nil // 会话已从 manager 移除
	})
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-gone")
	sub, err := h.Subscribe("tok1", "s-gone")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Release()
	if !sub.Ended() {
		t.Fatal("feed for vanished session should be ended")
	}
	// 对账路径：先 Wire 后会话消失
	h.Wire("tok2", "s-alive")
	sub2, err := h.Subscribe("tok2", "s-alive")
	if err != nil {
		t.Fatalf("subscribe2: %v", err)
	}
	defer sub2.Release()
	if sub2.Ended() {
		t.Fatal("feed for alive session should not be ended")
	}
	present["s-alive"] = false // 会话关闭：manager 移除 + notifyChange
	h.reconcile()
	select {
	case <-sub2.Done():
	case <-time.After(time.Second):
		t.Fatal("reconcile should end feed of vanished session")
	}
}

// ── 步骤 2：遮蔽管道（跨 Write 分片敏感值零残留，P-108 语料） ──

// 语料与 server/mask/mask_test.go 同源（sc 令牌 / password 赋值 / AWS key 三模式），
// 分片边界刻意落在敏感值中段——流式遮蔽器的跨 Write 状态必须把值吞全
func TestCrossChunkSensitiveZeroResidue(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	sub, err := h.Subscribe("tok1", "s-1")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Release()

	// 三段敏感值跨 Write 分片派发（分片边界落在敏感值中段）
	chunks := [][]byte{
		[]byte("export CC_LOCK_TOKEN="), []byte("sca_"), []byte("Ab12"),
		[]byte("Cd34"), []byte("Ef56"), []byte("Gh78"), []byte(" tail\r\n"),
		[]byte("password=\"SuperSecret99\" done\r\n"),
		[]byte("key=AKIA"), []byte("IOS"), []byte("WODP"), []byte("LE3X"), []byte("AMPLE\r\n"),
	}
	for _, c := range chunks {
		sess.emit(c)
	}
	// 完成哨兵 = 末段遮蔽形态（裸值尾 "AMPLE" 被吞，永远不会出现）
	got := collectFor(t, sub, func(b []byte) bool { return bytes.Contains(b, []byte("key=***")) })

	for _, secret := range []string{"sca_Ab12Cd34Ef56Gh78", "SuperSecret99", "AKIAIOSWODPLE3XAMPLE"} {
		if bytes.Contains(got, []byte(secret)) {
			t.Fatalf("sensitive value %q leaked across chunks", secret)
		}
		if bytes.Contains(sub.Tail(), []byte(secret)) {
			t.Fatalf("sensitive value %q leaked into tail snapshot", secret)
		}
	}
	for _, want := range []string{"export CC_LOCK_TOKEN=***", "password=***", "key=***"} {
		if !bytes.Contains(got, []byte(want)) {
			t.Fatalf("masked form %q missing in %q", want, got)
		}
	}
	if !bytes.Contains(got, []byte(" tail\r\n")) {
		t.Fatalf("non-sensitive context damaged: %q", got)
	}
}

// 每枚 token 独立 Masker 实例：A token 的遮蔽器状态不泄漏到 B token 流
// （跨 Write 状态机若共享会把 A 的半截候选吞掉 B 的首字节）
func TestPerTokenMaskerIsolation(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tokA", "s-1")
	h.Wire("tokB", "s-1")
	subA, err := h.Subscribe("tokA", "s-1")
	if err != nil {
		t.Fatalf("subscribe A: %v", err)
	}
	defer subA.Release()
	subB, err := h.Subscribe("tokB", "s-1")
	if err != nil {
		t.Fatalf("subscribe B: %v", err)
	}
	defer subB.Release()

	// 同会话双 token（同会话可开两条直播）各自持独立 Masker：若共享一枚，
	// "sca_" 半截候选滞留只会进先到的那枚状态机——两路必有一路缺 ***
	// 或吐出裸值。独立实例下两路各自得到同样的遮蔽形态
	sess.emit([]byte("sca_"))
	sess.emit([]byte("plain text after\r\n"))

	gotA := collectFor(t, subA, func(b []byte) bool { return bytes.Contains(b, []byte("*** text")) })
	gotB := collectFor(t, subB, func(b []byte) bool { return bytes.Contains(b, []byte("*** text")) })
	for name, got := range map[string][]byte{"A": gotA, "B": gotB} {
		if bytes.Contains(got, []byte("sca_plain")) {
			t.Fatalf("token %s: masker state leaked across tokens: %q", name, got)
		}
		if !bytes.Contains(got, []byte("*** text after")) {
			t.Fatalf("token %s: masked form missing (masker not per-token): %q", name, got)
		}
		if bytes.Count(got, []byte("***")) != 1 {
			t.Fatalf("token %s: expected exactly one mask per stream, got %q", name, got)
		}
	}
}

// ── 步骤 5：单 token 并发访客 ≤5 限流 ──

func TestGuestLimitPerToken(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	var subs []Subscription
	for i := 0; i < MaxGuestsPerToken; i++ {
		s, err := h.Subscribe("tok1", "s-1")
		if err != nil {
			t.Fatalf("guest %d rejected: %v", i, err)
		}
		subs = append(subs, s)
	}
	if _, err := h.Subscribe("tok1", "s-1"); err != ErrTooManyGuests {
		t.Fatalf("guest %d: err = %v, want ErrTooManyGuests", MaxGuestsPerToken, err)
	}
	// 释放一路后名额即刻回归
	subs[0].Release()
	if s, err := h.Subscribe("tok1", "s-1"); err != nil {
		t.Fatalf("subscribe after release: %v", err)
	} else {
		s.Release()
	}
	// 限流按 token 独立：另一 token 不受影响
	if s, err := h.Subscribe("tok2", "s-1"); err != nil {
		t.Fatalf("other token should not be limited: %v", err)
	} else {
		s.Release()
	}
}

// 慢消费者被踢出：通道灌满后 done 关闭（EventSource 重连走尾流快照对账），
// 绝不阻塞 tap 热路径
func TestSlowConsumerKicked(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	slow, err := h.Subscribe("tok1", "s-1")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer slow.Release()

	payload := bytes.Repeat([]byte("x"), 64)
	for i := 0; i < 4096 && !subDone(slow); i++ { // 256 cap × 16 倍灌满
		sess.emit(payload)
	}
	select {
	case <-slow.Done():
		// 被踢：预期
	case <-time.After(2 * time.Second):
		t.Fatal("slow consumer not kicked")
	}
}

func subDone(s Subscription) bool {
	select {
	case <-s.Done():
		return true
	default:
		return false
	}
}

// 尾流有界：超限截头保尾，快照不超 maxTailBytes（内存红线）
func TestTailBounded(t *testing.T) {
	sess := newFakeSession(nil)
	SetSessionLookup(func(string) LiveSession { return sess })
	t.Cleanup(func() { SetSessionLookup(nil) })
	h := NewHub()
	t.Cleanup(h.Stop)

	h.Wire("tok1", "s-1")
	big := bytes.Repeat([]byte("y"), 32<<10)
	for i := 0; i < 8; i++ { // 256KB > 128KB 上限
		sess.emit(big)
	}
	sub, err := h.Subscribe("tok1", "s-1")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Release()
	if len(sub.Tail()) > maxTailBytes {
		t.Fatalf("tail = %d bytes, want <= %d", len(sub.Tail()), maxTailBytes)
	}
	if !strings.Contains(string(sub.Tail()), "yyyy") {
		t.Fatal("tail lost recent content")
	}
}
