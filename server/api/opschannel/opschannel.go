package opschannel

import (
	"encoding/json"
	"strings"
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
	// TargetBrowserId 设备定向收件面（P-20261117-4，可选）：非空 = 本事件只投递
	// 到该浏览器实例的 WS 连接（frontend.* 设备效应原语的「单一浏览器效应」语义
	// ——详见 IsDeviceEffectEvent）；空 = 全广播（向后兼容：旧客户端 JSON 未知
	// 字段忽略，行为零变化）。只过滤 hub.broadcast 的 WS 收件面——观察者链
	// （BroadcastEvent/AddObserver）/通知中心/录制联动保持全量可见（评审必改②）
	TargetBrowserId string `json:"targetBrowserId,omitempty"`
}

// deviceEffectEvents 设备效应事件白名单（P-20261117-4 评审必改⑥）：TargetBrowserId
// 只允许填在这四个 frontend 动词族事件上——它们的语义本就是「单一浏览器效应」
// （capabilities.go 注册表自述）。白名单钉死在此（与常量同文件同源，加新原子
// 时显式登记）：其余事件族（approval.pending/resolved、input.request 等注意力类）
// 一律空 Target 全广播——定向审批卡会让他端窗口期漏卡，补账两路（挂载
// seedPending/重连 refetch）都不覆盖实时窗口。
// IsDeviceEffectEvent 供发布口判定：true = 允许定向（发布口解析会话绑定后填
// Target）；false = 全广播（Target 恒空）。未在册事件（agent 自定义 type）恒 false
func IsDeviceEffectEvent(eventType string) bool {
	switch eventType {
	case EventFrontendDownload, EventFrontendClipboard, EventFrontendOpen, EventFrontendReload:
		return true
	}
	return false
}

// browserIdMax 握手携带的 browserId 形态上限：与 clipRelay 自生成 id 同量级
// （时间戳 base36 + 随机段），64 字节充裕；超限/非法字符即视为未携带——
// browserId 是路由标签非安全边界，放宽只会退化为广播（宁可多广播不误丢）
const browserIdMax = 64

// SanitizeBrowserId 握手/请求携带的 browserId 形态守卫：trim + 白名单字符集
// [A-Za-z0-9._-] + 64 字节上限，非法/超限返回空串（= 未携带，该连接只收全广播
// 事件、不参与定向路由与单浏览器启发式）。前端生成走 opsBrowserId（clipRelay
// 自生成 id 同款复合形态，禁 crypto.randomUUID——LAN http 非安全上下文 undefined）
func SanitizeBrowserId(raw string) string {
	id := strings.TrimSpace(raw)
	if id == "" || len(id) > browserIdMax {
		return ""
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return ""
		}
	}
	return id
}

type hub struct {
	mu sync.Mutex
	// clients 已注册连接集；browsers 连接 → 浏览器实例 id（握手 query 携带，
	// 经 SanitizeBrowserId 守卫；空串 = 未携带，收不到定向事件）。两 map 同锁
	// 同生命周期：register 成对写入、remove 成对清——设备定向的收件面与
	// 单浏览器启发式的依据面（评审必改⑤：conn→browserId 索引随 remove/
	// lock closer 关闭路径统一清，后者经 defer h.remove(conn) 汇合）
	clients  map[*wssafe.Conn]struct{}
	browsers map[*wssafe.Conn]string
	queue    chan Event
}

var h = &hub{
	clients:  make(map[*wssafe.Conn]struct{}),
	browsers: make(map[*wssafe.Conn]string),
	queue:    make(chan Event, broadcastQueueDepth),
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

func (x *hub) register(c *wssafe.Conn, browserId string) {
	x.mu.Lock()
	x.clients[c] = struct{}{}
	x.browsers[c] = browserId
	x.mu.Unlock()
	metrics.AddGauge("sc_ws_connections", 1, "endpoint", "ops-channel")
}

// remove 剔除并关闭失效连接。gauge 只在条目确实存在时递减，
// 防止广播错误路径与 handler defer 双重递减导致指标漂移。
func (x *hub) remove(c *wssafe.Conn) {
	x.mu.Lock()
	_, ok := x.clients[c]
	delete(x.clients, c)
	delete(x.browsers, c)
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
	snapshot := x.recipients(ev)

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

// recipients 收件面快照（设备定向的过滤点，P-20261117-4）：TargetBrowserId
// 非空只收该浏览器的连接（含未携带 browserId 的连接在内一律跳过——路由键
// 不匹配即不投递，旧客户端行为可预期：收不到定向事件，全广播面零变化）；
// 空 Target = 全量（既有行为）。独立成法便于单测钉路由决策（不必起真连接）
func (x *hub) recipients(ev Event) []*wssafe.Conn {
	x.mu.Lock()
	defer x.mu.Unlock()
	snapshot := make([]*wssafe.Conn, 0, len(x.clients))
	for c := range x.clients {
		if ev.TargetBrowserId != "" && x.browsers[c] != ev.TargetBrowserId {
			continue
		}
		snapshot = append(snapshot, c)
	}
	return snapshot
}

// BrowserOnline 查询某浏览器实例当前是否有 WS 连接在册（设备效应定向前的
// 在线判定：绑定指向的浏览器不在线 → 发布口降级通知化，P-20261117-4）
func BrowserOnline(browserId string) bool {
	if browserId == "" {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, b := range h.browsers {
		if b == browserId {
			return true
		}
	}
	return false
}

// SoleConnectedBrowser 单浏览器启发式（P-20261117-4 评审必改③）：当前全部已连
// WS 共属同一（非空）browserId 时返回该 id，否则返回空串。发布口对「无绑定的
// 会话」以此兜底定向——覆盖「更新重启后 tmux 会话恢复绑定丢失」与「纯脚本
// 会话」两大常见态，单浏览器用户零回退；多浏览器并存或存在未携带 browserId
// 的连接（旧客户端）时不猜（无法判定作用面即不定向），交给降级通知化。
// 连接量为个位数~几十（浏览器数），全扫可忽略
func SoleConnectedBrowser() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	sole := ""
	for _, b := range h.browsers {
		if b == "" {
			return "" // 未携带身份的连接在册：作用面不可判定，不猜
		}
		if sole == "" {
			sole = b
		} else if b != sole {
			return "" // 多浏览器并存
		}
	}
	return sole
}

// DeviceRoute 设备效应路由判定结果（P-20261117-4）：Target 非空 = 定向广播；
// 空 = 不定向（发布方降级通知化），Reason 如实区分两种成因供通知文案
type DeviceRoute struct {
	Target string // 定向收件浏览器（空 = 不定向）
	Reason string // 降级成因：unbound=多浏览器并存且会话无绑定 / offline=绑定浏览器不在场
}

// RouteDeviceEffect 设备效应的路由决策（判定与 hub 在线状态同源同文件，发布口
// 只做适配）：绑定在案且浏览器在线 → 定向；绑定在案但浏览器不在场 → 降级
// offline；无绑定 → 单浏览器启发式命中即定向（命中值必在线），否则降级 unbound。
// 决策只读 hub 簿记态，纯查询可单测全矩阵
func RouteDeviceEffect(binding string) DeviceRoute {
	if binding != "" {
		if BrowserOnline(binding) {
			return DeviceRoute{Target: binding}
		}
		return DeviceRoute{Reason: "offline"}
	}
	if sole := SoleConnectedBrowser(); sole != "" {
		return DeviceRoute{Target: sole}
	}
	return DeviceRoute{Reason: "unbound"}
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

// publish 入队 + 观察者分发的公共路径（BroadcastEvent/BroadcastEventTargeted
// 同一出口）：入队承载 WS 广播面（定向与否由 ev.TargetBrowserId 在 broadcast
// 内过滤），观察者在发布方 goroutine 内同步执行且与定向无关——设备效应的
// 定向只收 WS 收件面，观察者链/通知中心/录制联动保持全量可见（评审必改②）
func publish(ev Event) {
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

func BroadcastEvent(eventType string, payload interface{}) {
	publish(Event{Type: eventType, Payload: payload, Source: "system", TS: time.Now().UnixMilli()})
}

// BroadcastEventTargeted 设备定向发布入口（P-20261117-4）：仅 frontend.* 设备效应
// 事件经此发布（调用方负责 IsDeviceEffectEvent 白名单判定与 targetBrowserId
// 非空校验——此处的守卫是最后防线，白名单外/空 target 一律回落全广播）。
// targetBrowserId 是路由标签非安全边界：同实例信任域内伪造 browserId 只能
// 收到本就发给同实例某浏览器的设备效应，无越权面
func BroadcastEventTargeted(eventType string, payload interface{}, targetBrowserId string) {
	targetBrowserId = SanitizeBrowserId(targetBrowserId)
	if targetBrowserId == "" || !IsDeviceEffectEvent(eventType) {
		BroadcastEvent(eventType, payload)
		return
	}
	publish(Event{
		Type:            eventType,
		Payload:         payload,
		Source:          "system",
		TS:              time.Now().UnixMilli(),
		TargetBrowserId: targetBrowserId,
	})
}

// HandleWS 前端订阅端点。路由：GET /ws/ops-channel（WithWSLockAuth 校验 token）。
// browserId 走握手 query 参数（P-20261117-4 评审必改⑤：hello 帧违反「客户端
// 不应发送消息」契约 :225-231，query 是升级期一次性携带的单处注入点）——
// 设备定向的路由键；缺省/非法 = 未携带（只收全广播，不参与定向与单浏览器
// 启发式，向后兼容旧客户端零影响）
func HandleWS(c *gin.Context) {
	browserId := SanitizeBrowserId(c.Query("browserId"))
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

	h.register(conn, browserId)
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
