package kernel

import (
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
type EventBus struct {
	mu   sync.RWMutex
	subs []subscription
	next int
}

type subscription struct {
	id  int
	topic string
	h   Handler
}

// NewEventBus 创建事件总线
func NewEventBus() *EventBus { return &EventBus{} }

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
// 单个 handler 的 panic 被吞掉（记录即可——总线不能被业务代码拖垮）。
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
		safeInvoke(h, env)
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

func safeInvoke(h Handler, env Envelope) {
	defer func() { _ = recover() }()
	h(env)
}
