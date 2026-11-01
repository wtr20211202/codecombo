package opschannel

import (
	"encoding/json"
	"sync"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/metrics"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// 智能操作通道（AI Native 协议的传输层）：
// - 前端常驻订阅 /ws/ops-channel（token 走 WS subprotocol，与 /ws/notifications 同款）
// - 后端在关键操作后调用 BroadcastEvent 推送联动指令（如项目增删 → 首页列表刷新）
// - 外部 Agent（claude/dsh 等）经 POST /api/ops-notify 发布自定义指令，驱动前端实时配合

const (
	// writeTimeout 单次写超时：停滞客户端最多阻塞广播 loop 一个超时周期，
	// 写失败即被剔除，不会拖垮整个 hub
	writeTimeout = 10 * time.Second
	// readDeadline 读超时：客户端不应发送消息，靠 Pong 续期；半开连接到点即回收
	readDeadline = 60 * time.Second
	// broadcastQueueDepth 广播队列深度：满时丢弃事件（与 deploy/clone 进度广播
	// 同策略——宁丢事件不阻塞发布方），杜绝无界堆积。丢弃有观测面
	// （P-20261004-70，见 dropstats.go）：计数/gauge 进 /api/metrics，
	// 风暴聚合走 debug 周期日志 + 自愈后一次性 info 汇总
	broadcastQueueDepth = 256
)

type Event struct {
	Type    string      `json:"type"`              // 事件类型：projects.changed / settings.changed / navigate / notify / 自定义
	Payload interface{} `json:"payload,omitempty"` // 事件载荷
	Source  string      `json:"source,omitempty"`  // 来源：system / external
	TS      int64       `json:"ts"`
}

type hub struct {
	mu      sync.Mutex
	clients map[*wssafe.Conn]struct{}
	queue   chan Event
}

var h = &hub{
	clients: make(map[*wssafe.Conn]struct{}),
	queue:   make(chan Event, broadcastQueueDepth),
}

func init() {
	// 单一广播 goroutine：事件串行化外发，替代历史上每事件一 goroutine——
	// 客户端停滞时旧实现会在锁上无界堆积 goroutine 并冻结 register/unregister
	go h.dispatchLoop()
}

func (x *hub) dispatchLoop() {
	for ev := range x.queue {
		x.broadcast(ev)
		// 消费滞后 gauge（P-20261004-70）：出队侧同步，与入队侧共同呈现
		// 队列排空过程；事件量低（业务事件，非终端输出流），逐事件 SetGauge 可忽略
		metrics.SetGauge(queueDepthName, int64(len(x.queue)))
	}
}

func (x *hub) register(c *wssafe.Conn) {
	x.mu.Lock()
	x.clients[c] = struct{}{}
	x.mu.Unlock()
	metrics.AddGauge("sc_ws_connections", 1, "endpoint", "ops-channel")
}

// remove 剔除并关闭失效连接。gauge 只在条目确实存在时递减，
// 防止广播错误路径与 handler defer 双重递减导致指标漂移。
func (x *hub) remove(c *wssafe.Conn) {
	x.mu.Lock()
	_, ok := x.clients[c]
	delete(x.clients, c)
	x.mu.Unlock()
	if !ok {
		return
	}
	_ = c.Conn.Close()
	metrics.AddGauge("sc_ws_connections", -1, "endpoint", "ops-channel")
}

func (x *hub) broadcast(ev Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	x.mu.Lock()
	snapshot := make([]*wssafe.Conn, 0, len(x.clients))
	for c := range x.clients {
		snapshot = append(snapshot, c)
	}
	x.mu.Unlock()

	// 锁外写：单个停滞客户端最多阻塞本 loop 至 writeTimeout，不拖累 register/unregister；
	// 写失败的连接立即剔除，防止死连接滞留 map 长期占用广播预算。
	// deadline 循环内逐 client 生成：共享同一个绝对时间会让排在停滞客户端
	// 之后的健康客户端继承所剩无几的窗口而被误杀
	for _, c := range snapshot {
		_ = c.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			x.remove(c)
		}
	}
}

// BroadcastEvent 系统内部发布入口（handler / store 层调用，异步不阻塞请求）
// observers 事件观察者（模块 Init 装配）：B6 任务事件落库、P-20261001-15 审批
// 窗口录制联动等——广播路径之外旁路消费，观察者故障互不传染
var (
	obsMu     sync.Mutex
	observers []observerEntry
	nextObsID int
)

// observerEntry 观察者条目：身份 id 供退订匹配——SetObserver 截断复用底层数组，
// 按下标置 nil 会让旧退订闭包误删同位置的新观察者，必须按 id 找
type observerEntry struct {
	id int
	fn func(Event)
}

// AddObserver 追加事件观察者，返回退订函数（幂等）。多模块并行消费同一事件流
// 的装配口；观察者在 BroadcastEvent 调用方 goroutine 内同步执行且逐个 recover
func AddObserver(fn func(Event)) (unsubscribe func()) {
	obsMu.Lock()
	nextObsID++
	e := observerEntry{id: nextObsID, fn: fn}
	observers = append(observers, e)
	obsMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			obsMu.Lock()
			for i, o := range observers {
				if o.id == e.id {
					observers = append(observers[:i], observers[i+1:]...)
					break
				}
			}
			obsMu.Unlock()
		})
	}
}

// SetObserver 覆盖式设置观察者（nil = 清空）——历史单观察者语义，测试环境
// 复位/替换仍走此口；生产模块装配一律用 AddObserver
func SetObserver(fn func(Event)) {
	obsMu.Lock()
	observers = observers[:0]
	if fn != nil {
		nextObsID++
		observers = append(observers, observerEntry{id: nextObsID, fn: fn})
	}
	obsMu.Unlock()
}

func BroadcastEvent(eventType string, payload interface{}) {
	ev := Event{Type: eventType, Payload: payload, Source: "system", TS: time.Now().UnixMilli()}
	select {
	case h.queue <- ev:
		// 风暴自愈检查（P-20261004-70）：常态走 atomic 快速路径零开销，
		// 仅风暴标记在场才进锁复核静默窗
		drops.maybeSummarize()
	default:
		// 队列满：丢弃事件，绝不阻塞业务调用方——观测面见 dropstats.go：
		// 按 type 计数进 /api/metrics，风暴聚合走周期 debug + 自愈 info 汇总
		metrics.IncCounter(droppedCounterName, "type", ev.Type)
		drops.recordDrop(ev.Type)
	}
	metrics.SetGauge(queueDepthName, int64(len(h.queue)))
	obsMu.Lock()
	snapshot := make([]func(Event), 0, len(observers))
	for _, o := range observers {
		snapshot = append(snapshot, o.fn)
	}
	obsMu.Unlock()
	for _, o := range snapshot {
		func() {
			defer func() { _ = recover() }() // 观察者故障不传染广播主链路
			o(ev)
		}()
	}
}

// HandleWS 前端订阅端点。路由：GET /ws/ops-channel（WithWSLockAuth 校验 token）
func HandleWS(c *gin.Context) {
	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		return
	}
	// 输入帧上限防线（P-20261003-313）：客户端不应发消息，上限只作失控客户端兜底
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化（与 notifications WS 同款）：hello 写与广播路径并发写同一 conn
	// 会触发 gorilla "concurrent write" panic
	conn := wssafe.New(rawConn)
	// NAT/防火墙保活：25s 间隔 Ping 防空闲超时
	defer conn.StartPing()()

	lockToken := middleware.ExtractLockToken(c.Request)
	closerID := store.Get().Lock.RegisterWSConn(lockToken, func() { rawConn.Close() })
	defer store.Get().Lock.UnregisterWSConn(lockToken, closerID)

	// 读超时 + pong 续期：客户端不应发送消息，Pong 即存活证据；
	// 半开连接（NAT 掉线、对端断电）到点即回收 handler goroutine
	_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	h.register(conn)
	defer h.remove(conn)

	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello","source":"system"}`))

	// 客户端不应发送消息；读取仅为感知断开
	for {
		_, _, err := rawConn.ReadMessage()
		if err != nil {
			shared.WarnIfReadLimitExceeded(err, "ops-channel")
			return
		}
	}
}
