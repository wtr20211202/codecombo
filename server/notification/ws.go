package notification

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"codecombo/server/metrics"
	"codecombo/server/wssafe"
)

var (
	storeMu sync.Mutex
	hub     *Hub
)

// setHub 设置通知 Hub。必须与 GetHub 同持 storeMu：InitHub 在测试里可与
// 服务期 handler goroutine 的 GetHub 读并发（裸全局读写是 -race 实测数据竞争）
func setHub(h *Hub) {
	storeMu.Lock()
	defer storeMu.Unlock()
	hub = h
}

// GetHub 获取当前 hub
func GetHub() *Hub {
	storeMu.Lock()
	defer storeMu.Unlock()
	return hub
}

// 传输层参数（P-20261006-40，对齐 opschannel 队列模式的同款取舍）：
// 通知是 UI 实时提醒信号非数据面——落库在 store 层与广播无关，前端有
// GET /api/notifications 全量拉取兑底 + 通知中心打开即对账，可丢且需可观测
const (
	// writeTimeout 单次写超时：停滞客户端（NAT 掉线/对端断电）最多阻塞广播
	// loop 一个超时周期，写失败即被剔除，不会拖垮整个 hub
	writeTimeout = 10 * time.Second
	// broadcastQueueDepth 广播队列深度：满时丢弃事件（宁丢不阻塞发布方），
	// 杜绝无界堆积。历史同步广播下 N 个停滞客户端会把触发通知的 API 响应
	// 线性拖慢至写超时×N；队列化后入账调用方零阻塞。丢弃有观测面
	//（计数 + 节流日志，见 dropThrottle）
	broadcastQueueDepth = 256
)

// 队列满丢弃观测面（对齐 opschannel dropstats.go 的最小子集）：
//  1. 丢弃即按消息类型计数 sc_notification_broadcast_dropped_total{type}
//     （notification.new / notification.snoozeDue / sync.progress 等白名单
//     事件序列，基数有界——新增 type 须为代码内常量不开放用户输入）——
//     GET /api/metrics（router.go 既有出口）可抓取可告警
//  2. 消费滞后 gauge sc_notification_queue_depth——入队/出队两侧同步
const (
	droppedCounterName = "sc_notification_broadcast_dropped_total"
	queueDepthName     = "sc_notification_queue_depth"
)

// dropLogInterval 队列满日志的节流窗：var 仅为测试可缩窗（opschannel
// dropDebugInterval 同手法）
var dropLogInterval = 10 * time.Second

// outbound 队列元素：消息类型（new / snoozeDue）+ 载荷。raw 非 nil = 自由
// 载荷消息（BroadcastEvent，如 sync.progress）——绕开 Notification 形状约束
// 的增量扩展口（协议只增不改：既有消费者对未知 type 忽略，前端
// notification store 按需分发为窗口事件）
type outbound struct {
	msgType string
	n       Notification
	raw     []byte
}

// Hub 维护所有已连接的全局通知 WS 客户端，Add 时经队列异步广播。
// 连接以 wssafe.Conn 持有（A9）：并发广播对同一 conn 的写经锁串行化。
//
// 广播异步化（P-20261006-40，模式照搬 opschannel）：入队即返 + 单一
// dispatchLoop 串行外发——通知入账是高频面（审批裁决/任务事件/告警/分享
// 命中全走 Notification.Add），历史同步广播把写循环放在调用方 goroutine，
// 一个半开连接就能把 API 响应拖慢一个写超时、N 个停滞客户端线性叠加
type Hub struct {
	mu      sync.Mutex
	clients map[*wssafe.Conn]struct{}
	queue   chan outbound
	// stop 关闭即令 dispatchLoop 退出（停机窗口在途通知可弃，见 Close）。
	// queue 本体不 close：Close 后入队路径免锁即无向已关闭 channel 发送的
	// panic 风险，代价只是关停后排队的消息滞留缓冲（容量有界，可弃）
	stop     chan struct{}
	stopOnce sync.Once
}

// InitHub 创建 hub、注入注册表并拉起单一广播 goroutine
func InitHub() *Hub {
	h := &Hub{
		clients: make(map[*wssafe.Conn]struct{}),
		queue:   make(chan outbound, broadcastQueueDepth),
		stop:    make(chan struct{}),
	}
	setHub(h)
	go h.dispatchLoop()
	return h
}

// dispatchLoop 单一广播 goroutine：通知串行化外发，替代历史上每条通知由
// 调用方 goroutine 直写——停滞客户端的写超时代价不再转嫁给每个入账调用方，
// 客户端收到推送的顺序也与入账顺序一致
func (h *Hub) dispatchLoop() {
	for {
		select {
		case <-h.stop:
			return
		case o := <-h.queue:
			if o.raw != nil {
				h.broadcastRaw(o.raw)
			} else {
				h.broadcast(o.msgType, o.n)
			}
			// 消费滞后 gauge（对齐 opschannel）：出队侧同步，与入队侧共同
			// 呈现队列排空过程；通知是低频业务信号，逐条 SetGauge 可忽略
			metrics.SetGauge(queueDepthName, int64(len(h.queue)))
		}
	}
}

// Register 注册一个新客户端连接
func (h *Hub) Register(c *wssafe.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	metrics.AddGauge("sc_ws_connections", 1, "endpoint", "notifications")
}

// Broadcast 广播通知到所有已连接客户端（入队即返，store 层调用方零阻塞）
func Broadcast(n Notification) {
	h := GetHub()
	if h != nil {
		h.enqueue(msgNew, n)
	}
}

// BroadcastSnoozeDue 到点重挂广播（P-20261003-36）：载荷与 notification.new
// 同构、type 不同——前端据以走「同 id 置顶+未读」路径且不重弹桌面通知
// （重挂是既有事件的再次提醒，webhook 外发同样不重发，调用方是重挂巡检）
func BroadcastSnoozeDue(n Notification) {
	h := GetHub()
	if h != nil {
		h.enqueue(msgSnoozeDue, n)
	}
}

// BroadcastEvent 自由载荷事件广播（sync.progress 等非通知形状的消息，
// P-20261023-1）：同一通知 WS 通道承载，消息体 {"type": msgType, "data": payload}。
// 入队即返同纪律；webhook 外发不涉及（事件非通知，无推送语义）。节流责任在
// 调用方（sync 进度 500ms 节流）——本层不做合并，保序串行外发即可
func BroadcastEvent(msgType string, payload any) {
	h := GetHub()
	if h == nil {
		return
	}
	raw, err := json.Marshal(map[string]any{"type": msgType, "data": payload})
	if err != nil {
		slog.Warn("event broadcast marshal failed", "type", msgType, "err", err)
		return
	}
	select {
	case h.queue <- outbound{msgType: msgType, raw: raw}:
	default:
		metrics.IncCounter(droppedCounterName, "type", msgType)
	}
}

// enqueue 入队即返：队列满丢弃并计数（观测面见常量注记），绝不阻塞调用方。
// 丢弃可接受性论证：通知是 UI 实时提醒信号，落库在 store 层与广播无关，
// 前端有 GET /api/notifications 全量拉取兑底 + 通知中心打开即对账
func (h *Hub) enqueue(msgType string, n Notification) {
	select {
	case h.queue <- outbound{msgType: msgType, n: n}:
	default:
		metrics.IncCounter(droppedCounterName, "type", msgType)
		drops.record(msgType, len(h.queue))
	}
	// 消费滞后 gauge（对齐 opschannel）：入队/出队两侧同步，滞后水位可画
	metrics.SetGauge(queueDepthName, int64(len(h.queue)))
}

// dropThrottle 队列满节流日志：窗口内只累计，到点发一条带窗口累计值的日志。
// 零专属 goroutine——刷新挂靠在丢弃路径，由入队方 goroutine 顺带执行
// （opschannel dropTracker 同思路）。取 Warn 而非 opschannel 的 Debug：
// 通知是低频 UI 信号，打满 256 深队列意味着 dispatchLoop 长时间停摆的异常
// 水位，值得生产日志面留痕；节流保证风暴下也不会日志刷屏
type dropThrottle struct {
	mu         sync.Mutex
	sinceLog   int64     // 当前窗口累计丢弃数
	lastEmitAt time.Time // 上条日志时刻（节流基准；零值 = 首丢即发）
}

var drops = &dropThrottle{}

// record 记一次队列满丢弃：计数已在 enqueue 侧落账，这里只管节流日志
func (d *dropThrottle) record(msgType string, queueDepth int) {
	d.mu.Lock()
	d.sinceLog++
	now := time.Now()
	emit := d.lastEmitAt.IsZero() || now.Sub(d.lastEmitAt) >= dropLogInterval
	total := d.sinceLog
	if emit {
		d.lastEmitAt = now
		d.sinceLog = 0
	}
	d.mu.Unlock()
	if emit {
		slog.Warn("notification broadcast queue full, dropping notifications",
			"type", msgType,
			"droppedSinceLastLog", total,
			"queueDepth", queueDepth,
		)
	}
}

// Close 停机（模块 Stop 时调用）：停 dispatchLoop 并关闭全部客户端连接。
// 停机窗口在途的排队通知可弃——落库在 store 层与广播无关，前端重连后
// GET /api/notifications 全量拉取兑底，零数据丢失（P-20261006-40 方案注记）。
// 幂等：stopOnce 保证重复 Close 安全。逐 client 走 Unregister：清空 map 前
// 必须递减 gauge，否则 handler defer 的 Unregister 查不到条目直接跳过，
// 指标永久漂移
func (h *Hub) Close() {
	h.stopOnce.Do(func() {
		close(h.stop)
		h.mu.Lock()
		clients := make([]*wssafe.Conn, 0, len(h.clients))
		for c := range h.clients {
			clients = append(clients, c)
		}
		h.mu.Unlock()
		for _, c := range clients {
			h.Unregister(c)
		}
	})
}

// Unregister 移除客户端。幂等：条目不存在时不重复递减 gauge
// （handler defer 与广播错误路径可能对同一 conn 双重调用）
func (h *Hub) Unregister(c *wssafe.Conn) {
	h.mu.Lock()
	_, ok := h.clients[c]
	delete(h.clients, c)
	h.mu.Unlock()
	if !ok {
		return
	}
	_ = c.Conn.Close()
	metrics.AddGauge("sc_ws_connections", -1, "endpoint", "notifications")
}

// 站内 WS 消息类型：new = 新通知入账；snoozeDue = 稍后提醒到点重挂（P-20261003-36）
const (
	msgNew       = "notification.new"
	msgSnoozeDue = "notification.snoozeDue"
)

// broadcastRaw 串行外发一条自由载荷消息（BroadcastEvent 预序列化体）。
// 逐 client 写语义与 broadcast 一致
func (h *Hub) broadcastRaw(raw []byte) {
	h.mu.Lock()
	clients := make([]*wssafe.Conn, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	for _, c := range clients {
		_ = c.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := c.WriteMessage(websocket.TextMessage, raw); err != nil {
			h.Unregister(c)
		}
	}
}

// broadcast 串行外发一条通知（仅 dispatchLoop goroutine 调用）。
// 锁外写：单个停滞客户端最多阻塞本 loop 一个 writeTimeout，不拖累
// register/unregister；写失败的连接立即剔除，防止死连接滞留 map 长期占用
// 广播预算。deadline 循环内逐 client 生成：共享同一个绝对时间会让排在
// 停滞客户端之后的健康客户端继承所剩无几的窗口而被误杀
func (h *Hub) broadcast(msgType string, n Notification) {
	msg, err := json.Marshal(map[string]interface{}{
		"type":         msgType,
		"notification": n,
	})
	if err != nil {
		slog.Warn("notification marshal failed", "err", err)
		return
	}
	h.mu.Lock()
	clients := make([]*wssafe.Conn, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		_ = c.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			h.Unregister(c)
		}
	}
}
