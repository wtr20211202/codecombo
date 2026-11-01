package notification

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/metrics"
	"codecombo/server/wssafe"

	"github.com/gorilla/websocket"
)

// 广播队列化（P-20261006-40）单测：入队即返（零同步写）/ 串行外发保序与
// 线上消息形态 / 写失败剔除 / 队列满丢弃计数与节流日志 / Close 幂等。
//
// 确定性手法（同 opschannel 测试的 swapTestHub）：需要「队列满/无消费者」
// 的用例构造不带 dispatchLoop 的 parked hub——结果完全可预期；需要真实外发
// 的用例走 InitHub 真实 loop + httptest 升级的真 WS 客户端。

// initTestHub 拉起带真实 dispatchLoop 的 hub 并接管全局注册表，用毕停机还原
func initTestHub(t *testing.T) *Hub {
	t.Helper()
	metrics.ResetForTesting()
	h := InitHub()
	t.Cleanup(func() {
		h.Close()
		setHub(nil)
		metrics.ResetForTesting()
	})
	return h
}

// newParkedHub 构造无 dispatchLoop 消费者的小容量 hub（入队满即丢弃），
// 并接管全局注册表让包级 Broadcast/BroadcastSnoozeDue 命中它
func newParkedHub(t *testing.T, depth int) *Hub {
	t.Helper()
	metrics.ResetForTesting()
	h := &Hub{
		clients: make(map[*wssafe.Conn]struct{}),
		queue:   make(chan outbound, depth),
		stop:    make(chan struct{}),
	}
	old := hub
	setHub(h)
	t.Cleanup(func() {
		setHub(old)
		metrics.ResetForTesting()
	})
	return h
}

// dialTestClient 经 httptest 拉起升级后注册进 hub 的 WS 服务并拨号一个真实
// 客户端，返回客户端侧 conn。服务端 handler 注册后阻塞读（同时消费控制帧，
// handler 退出时幂等注销），等到注册确认才返回——保证后续 Broadcast 必然
// 命中该客户端。
// 注册确认必须来自 handler 本体（注册指针回传）：并发用例里其他客户端的
// 接断会让「注册表计数 +1」的推断互相踩踏（前一个客户端的异步 Unregister
// 随时落账），只有本连接的注册指针是无歧义信号。
// cleanup 等待 handler 退出：WS 升级是 hijack 连接，httptest srv.Close 不等
// hijack 的 handler——否则 defer 里的 Unregister（含 gauge 递减）可能落在
// 下一个用例的 metrics.ResetForTesting 之后，-1 泄漏串扰后续用例
func dialTestClient(t *testing.T, h *Hub) *websocket.Conn {
	t.Helper()
	// 测试面用裸 Upgrader（拨号方不带 Origin，默认校验即过）：shared.WSUpgrade
	// 工厂经 helpers.go 依赖 store，而 store 依赖本包——测试引入即 import 环；
	// 与 preview/tlsutil 包测试的既有先例同款（P-327 工厂纪律面向生产升级器）
	upgrader := websocket.Upgrader{}
	registered := make(chan *wssafe.Conn, 1)
	handlerDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		raw, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := wssafe.New(raw)
		h.Register(conn)
		registered <- conn
		defer h.Unregister(conn)
		for {
			if _, _, err := raw.ReadMessage(); err != nil {
				return
			}
		}
	}))

	u := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		srv.Close()
		t.Fatalf("dial test ws client: %v", err)
	}
	select {
	case <-registered:
	case <-time.After(2 * time.Second):
		_ = c.Close()
		srv.Close()
		t.Fatal("test client must be registered in hub")
	}
	t.Cleanup(func() {
		_ = c.Close()
		select {
		case <-handlerDone:
		case <-time.After(2 * time.Second):
		}
		srv.Close()
	})
	return c
}

// captureLogs 接管默认 slog（Debug 级全收），返回缓冲区，用毕还原
func captureLogs(t *testing.T) *strings.Builder {
	t.Helper()
	var buf strings.Builder
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

// waitFor 轮询等待条件成立（异步路径的最终态断言），超时即失败
func waitFor(t *testing.T, timeout time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

// readAll 依次读 n 条消息（逐条 5s deadline），返回原文
func readAll(t *testing.T, c *websocket.Conn, n int) []string {
	t.Helper()
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, p, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read message %d: %v", i, err)
		}
		out = append(out, string(p))
	}
	return out
}

// TestBroadcastEnqueueAndReturnNoSyncWrite 入队即返：Broadcast 只写队列不写
// 网络——无消费者的 parked hub 上连发 3 条（第 3 条满丢弃），已注册客户端
// 在窗口内收不到任何推送（若有同步写回归此处即红），丢弃计数与滞后 gauge
// 进 /api/metrics 文本出口
func TestBroadcastEnqueueAndReturnNoSyncWrite(t *testing.T) {
	h := newParkedHub(t, 2)
	c := dialTestClient(t, h)

	start := time.Now()
	Broadcast(Notification{ID: "n1"})
	Broadcast(Notification{ID: "n2"})
	Broadcast(Notification{ID: "n3"}) // 队列满，丢弃
	if el := time.Since(start); el > time.Second {
		t.Fatalf("Broadcast must return immediately without writing, took %v", el)
	}

	render := metrics.Render()
	if !strings.Contains(render, `sc_notification_broadcast_dropped_total{type="notification.new"} 1`) {
		t.Fatalf("metrics expect dropped counter notification.new=1, got:\n%s", render)
	}
	if !strings.Contains(render, "sc_notification_queue_depth 2") {
		t.Fatalf("metrics expect queue depth gauge 2, got:\n%s", render)
	}

	// 零同步写证据：无 loop 消费，客户端窗口内读不到任何帧
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("Broadcast must not deliver synchronously; client got a frame")
	}
}

// TestDispatchLoopDeliversInOrderShapeUnchanged 串行外发：单一 loop 保证
// 客户端按入账顺序收到推送，多客户端全量收到；线上消息形态
// {"type":"notification.new"|"notification.snoozeDue","notification":…}
// 冻结在此（前端零改动的契约面）
func TestDispatchLoopDeliversInOrderShapeUnchanged(t *testing.T) {
	h := initTestHub(t)
	c1 := dialTestClient(t, h)
	c2 := dialTestClient(t, h)

	Broadcast(Notification{ID: "n1", Title: "t1"})
	BroadcastSnoozeDue(Notification{ID: "n2", Title: "t2"})
	Broadcast(Notification{ID: "n3", Title: "t3"})

	type frame struct {
		Type         string `json:"type"`
		Notification struct {
			ID string `json:"id"`
		} `json:"notification"`
	}
	wantTypes := []string{msgNew, msgSnoozeDue, msgNew}
	wantIDs := []string{"n1", "n2", "n3"}

	clients := []struct {
		name string
		conn *websocket.Conn
	}{{"client1", c1}, {"client2", c2}}
	for _, cl := range clients {
		got := readAll(t, cl.conn, 3)
		for i := range wantIDs {
			var f frame
			if err := json.Unmarshal([]byte(got[i]), &f); err != nil {
				t.Fatalf("%s msg %d unmarshal: %v (%s)", cl.name, i, err, got[i])
			}
			if f.Type != wantTypes[i] || f.Notification.ID != wantIDs[i] {
				t.Fatalf("%s msg %d = {type:%q id:%q}, want {type:%q id:%q} (order/shape broken)",
					cl.name, i, f.Type, f.Notification.ID, wantTypes[i], wantIDs[i])
			}
		}
	}

	// 出队侧 gauge 同步：排空后水位归零
	waitFor(t, 2*time.Second, func() bool {
		return strings.Contains(metrics.Render(), "sc_notification_queue_depth 0")
	}, "queue depth gauge must drain to 0 after delivery")
}

// TestBroadcastWriteFailureUnregistersClient 写失败剔除：本端关闭已注册连接
// 后写必然立即失败（不依赖对端/TCP 缓冲语义，三平台一致）。handler 挂起不读
// 不注册——剔除只可能来自 dispatchLoop 的广播写失败路径，gauge 随之归零
func TestBroadcastWriteFailureUnregistersClient(t *testing.T) {
	h := initTestHub(t)

	connCh := make(chan *websocket.Conn, 1)
	release := make(chan struct{})
	handlerDone := make(chan struct{})
	upgrader := websocket.Upgrader{} // 同 dialTestClient：shared 工厂对本包测试是导入环
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		raw, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connCh <- raw
		<-release // 挂起：无读循环、无 defer Unregister，不与广播路径竞争
	}))
	t.Cleanup(func() {
		close(release)
		select {
		case <-handlerDone:
		case <-time.After(2 * time.Second):
		}
		srv.Close()
	})

	u := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial test ws client: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })

	var raw *websocket.Conn
	select {
	case raw = <-connCh:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not hand over conn")
	}
	sc := wssafe.New(raw)
	h.Register(sc)

	_ = sc.Close() // 服务端本端关闭：后续写立即失败
	Broadcast(Notification{ID: "n1"})

	waitFor(t, 2*time.Second, func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.clients) == 0
	}, "write-failed conn must be unregistered by dispatch loop")
	if got := metrics.GaugeValue("sc_ws_connections"); got != 0 {
		t.Fatalf("ws gauge must return to 0 after unregister, got %d, render:\n%s", got, metrics.Render())
	}
}

// TestCloseIdempotent Close 幂等：二次 Close 不 panic；全部客户端连接被关闭
// （读循环出错即证）；gauge 归零；停机后广播不 panic（在途可弃语义）
func TestCloseIdempotent(t *testing.T) {
	h := initTestHub(t)
	c1 := dialTestClient(t, h)
	c2 := dialTestClient(t, h)

	h.Close()
	h.Close() // 幂等

	for i, c := range []*websocket.Conn{c1, c2} {
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := c.ReadMessage(); err == nil {
			t.Fatalf("client %d must be disconnected by Close", i)
		}
	}
	if got := metrics.GaugeValue("sc_ws_connections"); got != 0 {
		t.Fatalf("ws gauge must return to 0 after Close, got %d", got)
	}
	// 停机后入队不 panic：在途通知可弃（前端重连后 GET /api/notifications 兑底）
	Broadcast(Notification{ID: "after-close"})
	BroadcastSnoozeDue(Notification{ID: "after-close-2"})
}

// TestDropLogThrottled 队列满节流日志：首丢即发一条 Warn，窗口内丢弃只累计
// 不加行，窗口到点首丢再发且携带窗口累计值；成功入队的消息不计丢弃
func TestDropLogThrottled(t *testing.T) {
	newParkedHub(t, 1) // 全局注册表已指向 parked hub，Broadcast 经包级入口命中
	oldInterval := dropLogInterval
	dropLogInterval = 30 * time.Millisecond
	t.Cleanup(func() { dropLogInterval = oldInterval })
	buf := captureLogs(t)

	BroadcastSnoozeDue(Notification{ID: "n1"}) // 入队
	Broadcast(Notification{ID: "n2"})          // 丢 #1，首丢即发
	Broadcast(Notification{ID: "n3"})          // 丢 #2，窗口内节流
	if got := strings.Count(buf.String(), "queue full"); got != 1 {
		t.Fatalf("first drop must emit one warn line, got %d:\n%s", got, buf.String())
	}

	time.Sleep(60 * time.Millisecond)
	Broadcast(Notification{ID: "n4"}) // 丢 #3，窗口到点再发
	if got := strings.Count(buf.String(), "queue full"); got != 2 {
		t.Fatalf("expect second warn line after interval, got %d:\n%s", got, buf.String())
	}
	if !strings.Contains(buf.String(), "droppedSinceLastLog=2") {
		t.Fatalf("second line must carry window-cumulative total:\n%s", buf.String())
	}

	render := metrics.Render()
	if !strings.Contains(render, `sc_notification_broadcast_dropped_total{type="notification.new"} 3`) {
		t.Fatalf("metrics expect dropped counter notification.new=3, got:\n%s", render)
	}
	if strings.Contains(render, `sc_notification_broadcast_dropped_total{type="notification.snoozeDue"`) {
		t.Fatalf("queued message must not be counted as dropped, got:\n%s", render)
	}
}

// TestConcurrentBroadcastRegisterClose 并发安全（配 -race 跑）：多 goroutine
// 并发广播（new/snoozeDue 混流）+ 客户端注册/断开churn + 收尾 Close，
// 串行 loop 写出的帧不撕裂（收到的帧必为合法 JSON 消息形态）
func TestConcurrentBroadcastRegisterClose(t *testing.T) {
	h := initTestHub(t)
	c := dialTestClient(t, h)

	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				if w%2 == 0 {
					Broadcast(Notification{ID: fmt.Sprintf("w%d-%d", w, i)})
				} else {
					BroadcastSnoozeDue(Notification{ID: fmt.Sprintf("w%d-%d", w, i)})
				}
			}
		}(w)
	}
	// 广播进行中反复接断客户端：register/unregister 与 loop 写并发
	for i := 0; i < 5; i++ {
		_ = dialTestClient(t, h).Close()
	}
	wg.Wait()
	h.Close()

	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, p, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("long-lived client must have received frames: %v", err)
	}
	var f struct {
		Type         string `json:"type"`
		Notification struct {
			ID string `json:"id"`
		} `json:"notification"`
	}
	if err := json.Unmarshal(p, &f); err != nil {
		t.Fatalf("frame torn (concurrent write interleave): %v (%s)", err, p)
	}
	if f.Type != msgNew && f.Type != msgSnoozeDue {
		t.Fatalf("unexpected frame type %q", f.Type)
	}
}
