package kernel

import (
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// Envelope 事件信封：统一事件总线上的标准载荷。
// Topic 沿用既有前端约定（file.changed / git.command / projects.changed /
// settings.changed / task.progress / notification.new …），WS 桥接时
// Type=Topic、Data=Payload，线上格式与既有前端完全兼容。
type Envelope struct {
	Topic     string    `json:"topic"`
	ProjectID string    `json:"projectId,omitempty"`
	TS        time.Time `json:"ts"`
	// Payload 任意载荷；WS 桥接场景必须可被 encoding/json 序列化
	Payload any `json:"payload,omitempty"`
}

// Handler 事件处理器。处理器内部不得长时间阻塞（Publish 同步派发以保持顺序）。
type Handler func(Envelope)

// EventBus 进程内事件总线：收敛既有 4 套广播（项目 WS hub / notification hub /
// ops-channel / 任务进度 WS）的发布面。订阅支持精确 topic 与尾随 `*` 的前缀通配
//（如 "git.*"）。Publish 同步派发、逐 handler recover，保证总线自身永不 panic。
//
// 订阅者 panic 留痕（P-20261122-9 必改2）：此前 safeInvoke 是 `_ = recover()`
// 全静默吞——任何订阅者 panic 永久无痕（总线级故障只有「事件没到」这一个症状）。
// 现改为 slog.Error + 堆栈；事件总线是广播热路径，故按时间窗限频（每窗
// busPanicLogMax 条全量、其余计数抑制，窗口滚动时补播一条汇总）
type EventBus struct {
	mu   sync.RWMutex
	subs []subscription
	next int
	// logger panic 留痕出口（kernel.New 注入；零值/直接构造回落 slog.Default）
	logger *slog.Logger
	// panic 限频窗（窗起点/已播条数/被抑制条数），mu 保护
	panicWindow     time.Time
	panicCount      int
	panicSuppressed int
}

// 订阅者 panic 限频（热路径防日志风暴；10 条/分钟足够定位，抑制数滚动补播）
const (
	busPanicLogWindow = time.Minute
	busPanicLogMax    = 10
)

type subscription struct {
	id    int
	topic string
	h     Handler
}

// NewEventBus 创建事件总线（日志出口回落 slog.Default）
func NewEventBus() *EventBus { return &EventBus{logger: slog.Default()} }

// NewEventBusWithLogger 创建带日志出口的事件总线（内核装配用：与调度器共享
// 同一 logger，panic 留痕进当天服务日志）
func NewEventBusWithLogger(logger *slog.Logger) *EventBus {
	if logger == nil {
		logger = slog.Default()
	}
	return &EventBus{logger: logger}
}

// Subscribe 订阅 topic（精确匹配或尾随 `*` 前缀通配）。返回退订函数，退订幂等。
func (b *EventBus) Subscribe(topic string, h Handler) (unsubscribe func()) {
	b.mu.Lock()
	b.next++
	sub := subscription{id: b.next, topic: topic, h: h}
	b.subs = append(b.subs, sub)
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			for i, s := range b.subs {
				if s.id == sub.id {
					b.subs = append(b.subs[:i], b.subs[i+1:]...)
					break
				}
			}
			b.mu.Unlock()
		})
	}
}

// Publish 同步派发事件给全部匹配订阅者。
// 顺序保证：同一 topic 的多个订阅者按订阅顺序执行；
// 单个 handler 的 panic 被围堵并留痕（总线不能被业务代码拖垮，但也不能无声）
func (b *EventBus) Publish(env Envelope) {
	if env.TS.IsZero() {
		env.TS = time.Now()
	}
	b.mu.RLock()
	matched := make([]Handler, 0, len(b.subs))
	for _, s := range b.subs {
		if topicMatch(s.topic, env.Topic) {
			matched = append(matched, s.h)
		}
	}
	b.mu.RUnlock()
	for _, h := range matched {
		b.safeInvoke(h, env)
	}
}

// Close 关闭总线（StopAll 时调用）；Close 后 Publish 为 no-op，Subscribe 仍安全（随即失效）
func (b *EventBus) Close() {
	b.mu.Lock()
	b.subs = nil
	b.mu.Unlock()
}

func topicMatch(pattern, topic string) bool {
	if pattern == topic {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(topic, pattern[:len(pattern)-1])
	}
	return false
}

// safeInvoke 单订阅者围堵（P-20261122-9 必改2）：panic 不再静默吞——记 ERROR +
// 堆栈（订阅者 bug 的唯一现场），按窗限频防广播热路径日志风暴
func (b *EventBus) safeInvoke(h Handler, env Envelope) {
	defer func() {
		if r := recover(); r != nil {
			b.recordHandlerPanic(env.Topic, r)
		}
	}()
	h(env)
}

// recordHandlerPanic 订阅者 panic 的限频落痕：窗内前 busPanicLogMax 条全量
// （topic/panic/堆栈），超出只计数；窗口滚动时补播一条汇总（抑制数不丢）
func (b *EventBus) recordHandlerPanic(topic string, rec any) {
	now := time.Now()
	var suppressed int
	suppressedNow := false

	b.mu.Lock()
	if b.panicWindow.IsZero() || now.Sub(b.panicWindow) >= busPanicLogWindow {
		suppressed = b.panicSuppressed
		b.panicWindow = now
		b.panicCount = 0
		b.panicSuppressed = 0
	}
	if b.panicCount >= busPanicLogMax {
		b.panicSuppressed++
		suppressedNow = true
	} else {
		b.panicCount++
	}
	b.mu.Unlock()

	logger := b.logger
	if logger == nil {
		logger = slog.Default()
	}
	if suppressed > 0 {
		logger.Warn("events: subscriber panics suppressed in the previous window",
			"count", suppressed, "window", busPanicLogWindow.String())
	}
	if suppressedNow {
		return
	}
	logger.Error("events: subscriber panicked",
		"topic", topic, "panic", rec, "stack", string(debug.Stack()))
}
