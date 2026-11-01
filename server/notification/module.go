package notification

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"codecombo/server/kernel"
)

// TopicNew 通知新消息 topic：store.Add 出站发布 → 事件总线 → 本模块订阅桥回 WS。
// 线上格式与历史直连广播完全一致（{"type":"notification.new","notification":…}）
const TopicNew = "notification.new"

// TopicApprovalPending 审批挂起 topic（P-20261002-31）：审批创建路径经组合根
// 桥发布到总线，本模块订阅后供 webhook 外发转发器推送手机。载荷为
// store.AgentApproval（结构子集经 JSON 往返提取，见 ApprovalInfo）
const TopicApprovalPending = "approval.pending"

// Module 通知中心模块（roadmap M1.1）：WS Hub 生命周期 + 总线 topic 桥接。
//
// 依赖关系：存储层（store.NotificationStore）在 Add 时经组合根注入的出站口
// 向事件总线发布 TopicNew；本模块订阅该 topic 并以原有格式广播到
// /ws/notifications 的全部客户端——store 不再直接依赖 WS hub 运行时。
// P-20261002-31 起同一订阅点旁路 webhook 外发转发器（站内事件 → 手机）。
type Module struct {
	k   kernel.Kernel
	hub *Hub
	fw  *Forwarder
	// snoozeDueFn 稍后提醒到期重挂扫描口（P-20261003-36，组合根注入
	// store.Get().Notification.RemountDue——本包不能反向 import store，
	// 同 prefsFn 注入惯例；nil = 无重挂巡检，单测/未装配态）。返回本巡检轮
	// 重挂的条目，模块经 /ws/notifications 广播 snoozeDue（仅站内重挂，
	// 不重弹桌面通知、不走 webhook 外发）
	snoozeDueFn func(now time.Time) []Notification
	unsubs      []func()
}

// NewModule 创建通知模块。prefsFn 外发推送偏好读取口、snoozeDueFn 到期重挂
// 扫描口（均可传 nil——单测/未装配时转发器停摆、无重挂巡检，与 store.New
// 的 notifyOut 变参同惯例）
func NewModule(prefsFn func() Prefs, snoozeDueFn func(time.Time) []Notification) *Module {
	m := &Module{snoozeDueFn: snoozeDueFn}
	if prefsFn != nil {
		m.fw = NewForwarder(prefsFn)
	}
	return m
}

func (m *Module) Name() string        { return "notify" }
func (m *Module) DependsOn() []string { return nil }

// Init 创建 WS Hub（/ws/notifications handler 经 GetHub 取用）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	m.hub = InitHub()
	return nil
}

// Start 订阅总线 topic：新通知广播到全部 WS 客户端（既有），旁路 webhook
// 外发（P-20261002-31）；审批挂起 topic 单独订阅（无 WS 广播语义）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	if m.hub == nil {
		return errors.New("notification: hub not initialized")
	}
	m.unsubs = append(m.unsubs, k.Events().Subscribe(TopicNew, func(env kernel.Envelope) {
		n, ok := env.Payload.(Notification)
		if !ok {
			slog.Warn("notification: unexpected payload on topic", "topic", env.Topic)
			return
		}
		// 入队即返（P-20261006-40）：总线 Publish 是同步派发，历史在此直发会把
		// 停滞客户端的写超时逐 client 转嫁给 store 调用方；队列化后由 hub 的
		// dispatchLoop 串行外发，队列满丢弃可观测（ws.go）
		m.hub.enqueue(msgNew, n)
		// 外发转发：过滤在 Forwarder 内完成（未配置时零开销返回），
		// HTTP 外发在其内部 goroutine，绝不阻塞总线派发
		m.fw.OnNotification(n)
	}))
	m.unsubs = append(m.unsubs, k.Events().Subscribe(TopicApprovalPending, func(env kernel.Envelope) {
		m.fw.OnApprovalPending(env.Payload)
	}))
	// 稍后提醒到期重挂巡检（P-20261003-36）：内核调度器为间隔制，分钟级巡检
	// 同日报（report 模块）调度位；数据变更在 store 层，这里只广播
	if m.snoozeDueFn != nil {
		if !k.Scheduler().AddTicker("notify-snooze", time.Minute, func(context.Context) {
			for _, n := range m.snoozeDueFn(time.Now()) {
				BroadcastSnoozeDue(n)
			}
		}) {
			return errors.New("notification: notify-snooze ticker already registered")
		}
	}
	return nil
}

// Stop 退订总线、停广播 loop 并关闭全部客户端连接（GetHub 归 nil，handler 拒
// 新连）。停机窗口在途的排队通知可弃——前端重连后 GET /api/notifications 全量
// 拉取兑底，落库面零丢失（ws.go Close 注记）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	for _, unsub := range m.unsubs {
		unsub()
	}
	m.unsubs = nil
	if m.hub != nil {
		m.hub.Close()
		m.hub = nil
	}
	setHub(nil)
	return nil
}
