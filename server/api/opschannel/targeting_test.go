package opschannel

import (
	"testing"

	"codecombo/server/wssafe"
)

// 设备定向路由（P-20261117-4）单测：收件面过滤 / 单浏览器启发式 / 在线判定 /
// 事件族白名单 / browserId 形态守卫 / 定向发布入口的回落守卫。
//
// 路由决策不依赖真连接 IO：recipients/SoleConnectedBrowser/BrowserOnline 只读
// clients/browsers 两张 map，测试直接簿记假连接键（零值 &wssafe.Conn{}，永不
// 被写——写路径在 broadcast 的锁外段，测试不经由它）。

// bookConn 向当前 hub 簿记一条假连接及其 browserId（同锁纪律，用毕由 restoreHub 清）
func bookConn(c *wssafe.Conn, browserId string) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.browsers[c] = browserId
	h.mu.Unlock()
}

// TestRecipientsTargetFilter 收件面过滤：定向事件只含路由键匹配的连接，未携带
// 身份的连接（空 browserId）与其他浏览器一律跳过；空 Target 全量（向后兼容：
// 既有广播零变化）
func TestRecipientsTargetFilter(t *testing.T) {
	swapTestHub(t, 8)
	cA1 := &wssafe.Conn{}
	cA2 := &wssafe.Conn{} // 同浏览器 A 的第二个标签
	cB := &wssafe.Conn{}  // 浏览器 B
	cUnknown := &wssafe.Conn{}
	bookConn(cA1, "bA")
	bookConn(cA2, "bA")
	bookConn(cB, "bB")
	bookConn(cUnknown, "")

	got := hubRecipientsIDs(Event{TargetBrowserId: "bA"})
	if len(got) != 2 {
		t.Fatalf("target bA expect 2 recipients (tab1+tab2), got %d: %v", len(got), got)
	}

	got = hubRecipientsIDs(Event{TargetBrowserId: "bB"})
	if len(got) != 1 {
		t.Fatalf("target bB expect 1 recipient, got %d: %v", len(got), got)
	}

	got = hubRecipientsIDs(Event{TargetBrowserId: "bGone"}) // 不在线的浏览器
	if len(got) != 0 {
		t.Fatalf("target offline browser expect 0 recipients, got %d: %v", len(got), got)
	}

	got = hubRecipientsIDs(Event{}) // 空 Target = 全广播
	if len(got) != 4 {
		t.Fatalf("empty target expect full broadcast 4, got %d: %v", len(got), got)
	}
}

// hubRecipientsIDs recipients 的 id 化观测口（测试专用）
func hubRecipientsIDs(ev Event) []string {
	h.mu.Lock()
	ids := make([]string, 0, len(h.browsers))
	idByConn := map[*wssafe.Conn]string{}
	for c, b := range h.browsers {
		idByConn[c] = b
	}
	h.mu.Unlock()
	for _, c := range h.recipients(ev) {
		ids = append(ids, idByConn[c])
	}
	return ids
}

// TestSoleConnectedBrowser 单浏览器启发式：全部连接同属一个 browserId → 该 id；
// 多浏览器并存 / 在册空 id 连接 / 零连接 → 空串（不猜）
func TestSoleConnectedBrowser(t *testing.T) {
	swapTestHub(t, 8)

	if got := SoleConnectedBrowser(); got != "" {
		t.Fatalf("zero connections expect empty, got %q", got)
	}

	c1 := &wssafe.Conn{}
	bookConn(c1, "only")
	if got := SoleConnectedBrowser(); got != "only" {
		t.Fatalf("single browser expect 'only', got %q", got)
	}

	c3 := &wssafe.Conn{}
	bookConn(c3, "other")
	if got := SoleConnectedBrowser(); got != "" {
		t.Fatalf("multi browsers expect empty, got %q", got)
	}

	// 回到单浏览器，但多了一条未携带身份的旧客户端连接：作用面不可判定
	h.mu.Lock()
	delete(h.clients, c3)
	delete(h.browsers, c3)
	h.mu.Unlock()
	bookConn(&wssafe.Conn{}, "")
	if got := SoleConnectedBrowser(); got != "" {
		t.Fatalf("blank-id conn in registry expect empty, got %q", got)
	}
}

// TestBrowserOnline 在线判定：按 browserId 精确匹配；空 id 恒 false；remove
// 清索引后在线状态随之消亡
func TestBrowserOnline(t *testing.T) {
	swapTestHub(t, 8)

	if BrowserOnline("") {
		t.Fatalf("empty browserId must be offline")
	}
	c1 := &wssafe.Conn{}
	bookConn(c1, "b1")
	if !BrowserOnline("b1") {
		t.Fatalf("b1 expect online")
	}
	if BrowserOnline("b2") {
		t.Fatalf("b2 expect offline")
	}
	// 关闭路径清索引的效果（remove 会 Close 真连接，假连接直接簿记清理——
	// remove 的 map 清理行为已被 TestRecipientsTargetFilter 间接覆盖）
	h.mu.Lock()
	delete(h.clients, c1)
	delete(h.browsers, c1)
	h.mu.Unlock()
	if BrowserOnline("b1") {
		t.Fatalf("after index clear b1 must be offline")
	}
}

// TestIsDeviceEffectEvent 事件族白名单钉死（评审必改⑥）：仅 frontend.* 四事件
// 可定向；approval.pending/resolved 等注意力类与 agent 自定义 type 恒不可——
// 定向审批卡会让他端窗口期漏卡
func TestIsDeviceEffectEvent(t *testing.T) {
	for _, ev := range []string{EventFrontendDownload, EventFrontendClipboard, EventFrontendOpen, EventFrontendReload} {
		if !IsDeviceEffectEvent(ev) {
			t.Fatalf("%s must be a device effect event", ev)
		}
	}
	for _, ev := range []string{EventApprovalPending, EventApprovalResolved, EventInputRequest, EventNavigate, EventNotify, EventTaskProgress, "custom.agent.type"} {
		if IsDeviceEffectEvent(ev) {
			t.Fatalf("%s must NOT be a device effect event", ev)
		}
	}
}

// TestSanitizeBrowserId 形态守卫：合法（clipRelay/opsBrowserId 同族生成形态），
// 非法（空白/控制符/斜杠/超限/空）一律空串 = 未携带
func TestSanitizeBrowserId(t *testing.T) {
	valid := []string{"ops-lx3k9-abc123", "clip-abc-def", "A9._-z", "0"}
	for _, in := range valid {
		if got := SanitizeBrowserId(in); got != in {
			t.Fatalf("sanitize %q expect identity, got %q", in, got)
		}
	}
	if got := SanitizeBrowserId("  ops-x  "); got != "ops-x" {
		t.Fatalf("trim expected, got %q", got)
	}
	invalid := []string{
		"", "   ", // 空/纯空白
		"ops/x", "ops\\x", // 路径分隔
		"ops x",                              // 空白
		"ops\tx",                             // 控制符
		"中文",                                 // 非 ASCII
		string(make([]byte, browserIdMax+1)), // 超限
	}
	for _, in := range invalid {
		if got := SanitizeBrowserId(in); got != "" {
			t.Fatalf("sanitize %q expect empty, got %q", in, got)
		}
	}
}

// TestBroadcastEventTargetedGuards 定向发布入口的最后防线：白名单外事件或空
// target 回落全广播（Target 字段恒空）；白名单内定向事件带 Target 入队且
// 观察者照常收到全量（评审必改②：定向只滤 WS 收件面，观察者链不感知定向）
func TestBroadcastEventTargetedGuards(t *testing.T) {
	swapTestHub(t, 8)

	// 白名单外事件：即便给了 target 也回落全广播
	BroadcastEventTargeted(EventApprovalPending, nil, "bA")
	ev := <-h.queue
	if ev.TargetBrowserId != "" {
		t.Fatalf("non-device event must fall back to full broadcast, got target %q", ev.TargetBrowserId)
	}

	// 白名单内但 target 空：同样回落全广播
	BroadcastEventTargeted(EventFrontendDownload, nil, "  ")
	ev = <-h.queue
	if ev.TargetBrowserId != "" {
		t.Fatalf("blank target must fall back to full broadcast, got %q", ev.TargetBrowserId)
	}

	// 白名单内 + 合法 target：定向入队，观察者同步收到带 Target 的事件
	var seen Event
	unsub := AddObserver(func(e Event) { seen = e })
	BroadcastEventTargeted(EventFrontendDownload, gin_H_helper(), "bA")
	unsub()
	if seen.TargetBrowserId != "bA" || seen.Type != EventFrontendDownload {
		t.Fatalf("observer must see targeted event, got %+v", seen)
	}
	// 合法定向事件在队（先收走，防与下一条回落事件顺序纠缠）
	ev = <-h.queue
	if ev.TargetBrowserId != "bA" {
		t.Fatalf("queued targeted event expected, got %+v", ev)
	}
	// 非法 target 形态（字符集外）被守卫：回落全广播
	BroadcastEventTargeted(EventFrontendDownload, nil, "bA/x")
	ev = <-h.queue
	if ev.TargetBrowserId != "" {
		t.Fatalf("illegal target form must fall back, got %q", ev.TargetBrowserId)
	}
}

// gin_H_helper 占位载荷（本测试只关心 Event 元字段）
func gin_H_helper() map[string]string { return map[string]string{"k": "v"} }

// TestRouteDeviceEffect 路由决策全矩阵（P-20261117-4）：绑定在线→定向 / 绑定
// 不在场→降级 offline / 无绑定+单浏览器启发式→定向（覆盖「重启恢复绑定丢失」
// 「纯脚本会话」两大常见态）/ 无绑定+多浏览器→降级 unbound / 无绑定+旧客户端
// 未携带身份连接在册→降级 unbound（不猜）/ 零连接→降级 unbound
func TestRouteDeviceEffect(t *testing.T) {
	swapTestHub(t, 8)

	// 零连接：无绑定会话降级 unbound
	if r := RouteDeviceEffect(""); r.Target != "" || r.Reason != "unbound" {
		t.Fatalf("no conns + unbound expect degrade unbound, got %+v", r)
	}

	cA := &wssafe.Conn{}
	bookConn(cA, "bA")

	// 单浏览器启发式：无绑定 → 定向唯一浏览器
	if r := RouteDeviceEffect(""); r.Target != "bA" {
		t.Fatalf("unbound + sole browser expect target bA, got %+v", r)
	}
	// 绑定命中该浏览器：定向
	if r := RouteDeviceEffect("bA"); r.Target != "bA" || r.Reason != "" {
		t.Fatalf("bound online expect target bA, got %+v", r)
	}
	// 绑定指向不在场的浏览器：降级 offline
	if r := RouteDeviceEffect("bGone"); r.Target != "" || r.Reason != "offline" {
		t.Fatalf("bound offline expect degrade offline, got %+v", r)
	}

	// 多浏览器并存：无绑定不猜 → unbound；绑定仍可定向各自浏览器
	cB := &wssafe.Conn{}
	bookConn(cB, "bB")
	if r := RouteDeviceEffect(""); r.Target != "" || r.Reason != "unbound" {
		t.Fatalf("multi browsers + unbound expect degrade unbound, got %+v", r)
	}
	if r := RouteDeviceEffect("bB"); r.Target != "bB" {
		t.Fatalf("multi browsers + bound online expect target bB, got %+v", r)
	}

	// 旧客户端（未携带身份）在册：启发式失效 → unbound
	cU := &wssafe.Conn{}
	bookConn(cU, "")
	h.mu.Lock()
	delete(h.clients, cB)
	delete(h.browsers, cB)
	h.mu.Unlock()
	if r := RouteDeviceEffect(""); r.Target != "" || r.Reason != "unbound" {
		t.Fatalf("blank-id conn in roster expect degrade unbound, got %+v", r)
	}
}
