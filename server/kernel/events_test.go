package kernel

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEventBus_ExactAndWildcardDispatch(t *testing.T) {
	bus := NewEventBus()

	var exact, wildcard atomic.Int32
	unExact := bus.Subscribe("file.changed", func(Envelope) { exact.Add(1) })
	bus.Subscribe("file.*", func(Envelope) { wildcard.Add(1) })

	bus.Publish(Envelope{Topic: "file.changed"})
	bus.Publish(Envelope{Topic: "file.deleted"})

	if exact.Load() != 1 {
		t.Fatalf("exact handler calls = %d, want 1", exact.Load())
	}
	if wildcard.Load() != 2 {
		t.Fatalf("wildcard handler calls = %d, want 2", wildcard.Load())
	}

	// 退订后不再派发
	unExact()
	bus.Publish(Envelope{Topic: "file.changed"})
	if exact.Load() != 1 {
		t.Fatalf("exact handler calls after unsubscribe = %d, want 1", exact.Load())
	}
}

func TestEventBus_HandlerPanicDoesNotAffectOthers(t *testing.T) {
	// 静默 logger：本用例只断言「不外泄/不阻断」，panic 留痕面由专门用例覆盖
	bus := NewEventBusWithLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	var after atomic.Int32
	bus.Subscribe("t", func(Envelope) { panic("boom") })
	bus.Subscribe("t", func(Envelope) { after.Add(1) })

	bus.Publish(Envelope{Topic: "t"}) // 不得 panic 外泄，且第二个 handler 仍执行
	if after.Load() != 1 {
		t.Fatalf("handler after panicking one not called")
	}
}

// 订阅者 panic 留痕（P-20261122-9 必改2）：ERROR + topic + panic 值 + 堆栈——
// 此前 `_ = recover()` 全静默，总线级故障只有「事件没到」一个症状
func TestEventBus_HandlerPanicLoggedWithStack(t *testing.T) {
	var buf bytes.Buffer
	bus := NewEventBusWithLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	bus.Subscribe("git.command", func(Envelope) { panic("boom-logged") })

	bus.Publish(Envelope{Topic: "git.command"})

	out := buf.String()
	for _, want := range []string{"subscriber panicked", "topic=git.command", "boom-logged", "stack="} {
		if !strings.Contains(out, want) {
			t.Fatalf("panic log missing %q, got %q", want, out)
		}
	}
}

// 限频：窗内只播 busPanicLogMax 条全量（热路径防日志风暴），其余计数抑制
func TestEventBus_HandlerPanicLogRateLimited(t *testing.T) {
	var buf bytes.Buffer
	bus := NewEventBusWithLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	bus.Subscribe("hot.topic", func(Envelope) { panic("storm") })

	for i := 0; i < busPanicLogMax+5; i++ {
		bus.Publish(Envelope{Topic: "hot.topic"})
	}
	if got := strings.Count(buf.String(), "subscriber panicked"); got != busPanicLogMax {
		t.Fatalf("logged panics = %d, want %d (rate limit)", got, busPanicLogMax)
	}
}

func TestEventBus_ConcurrentPublishSubscribe(t *testing.T) {
	bus := NewEventBus()
	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() { // 并发订阅/退订
		defer wg.Done()
		i := 0
		for {
			select {
			case <-stop:
				return
			default:
				un := bus.Subscribe("concurrent.topic", func(Envelope) {})
				un()
				i++
			}
		}
	}()
	wg.Add(1)
	go func() { // 并发发布
		defer wg.Done()
		for j := 0; j < 500; j++ {
			bus.Publish(Envelope{Topic: "concurrent.topic"})
			time.Sleep(time.Microsecond)
		}
	}()

	time.Sleep(50 * time.Millisecond)
	close(stop)
	wg.Wait()
}

func TestEventBus_CloseStopsDelivery(t *testing.T) {
	bus := NewEventBus()
	var n atomic.Int32
	bus.Subscribe("x", func(Envelope) { n.Add(1) })
	bus.Close()
	bus.Publish(Envelope{Topic: "x"})
	if n.Load() != 0 {
		t.Fatal("no delivery expected after Close")
	}
}
