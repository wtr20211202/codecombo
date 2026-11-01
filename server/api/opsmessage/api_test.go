package opsmessage

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 端点单测：gin 测试上下文直驱 handler（不经路由表，鉴权由中间件层另行负责，
// agentchain api_test 同款）；存储用真实 filestore，目标会话在册判定换桩，
// 广播流挂测试观察者捕获事件载荷。

type testEnv struct {
	events []opschannel.Event
	mu     sync.Mutex
}

func newAPIEnv(t *testing.T) *testEnv {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
	origAlive := sessionAlive
	sessionAlive = func(sessionID string) bool { return sessionID == "agent-live" }
	t.Cleanup(func() { sessionAlive = origAlive })

	env := &testEnv{}
	origObserver := opschannel.AddObserver(func(ev opschannel.Event) {
		env.mu.Lock()
		env.events = append(env.events, ev)
		env.mu.Unlock()
	})
	t.Cleanup(origObserver)
	return env
}

// eventsOf 快照已捕获事件（按 type 过滤）
func (env *testEnv) eventsOf(typ string) []opschannel.Event {
	env.mu.Lock()
	defer env.mu.Unlock()
	out := make([]opschannel.Event, 0, len(env.events))
	for _, ev := range env.events {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}

// call 直驱单个 handler；hdr 为请求头（X-Session-ID）
func call(t *testing.T, handler gin.HandlerFunc, method, body, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	if body != "" {
		c.Request = httptest.NewRequest(method, "/api/ops-message", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
	} else {
		c.Request = httptest.NewRequest(method, "/api/ops-message", nil)
	}
	if sessionID != "" {
		c.Request.Header.Set("X-Session-ID", sessionID)
	}
	handler(c)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response: %v\nbody: %s", err, w.Body.String())
	}
	return m
}

// TestSendMessage_Validation 校验面：载荷缺失/发送方头缺失/超上限/目标不在册，
// 各自稳定错误码且不落库
func TestSendMessage_Validation(t *testing.T) {
	env := newAPIEnv(t)
	for _, tc := range []struct {
		body, sessionID, wantCode string
	}{
		{`{"body":"x"}`, "agent-live", "ops.message_payload_invalid"},                                                        // 缺 to
		{`{"to":"agent-live"}`, "agent-live", "ops.message_payload_invalid"},                                                 // 缺 body
		{`{"to":"agent-live","body":"x"}`, "", "ops.message_payload_invalid"},                                                // 缺发送方头
		{`{"to":"agent-live","body":"` + strings.Repeat("x", bodyMax+1) + `"}`, "agent-live", "ops.message_payload_invalid"}, // 超 2KB
		{`{"to":"agent-ghost","body":"x"}`, "agent-live", "ops.message_target_not_found"},                                    // 目标不在册 404
	} {
		w := call(t, SendMessage, http.MethodPost, tc.body, tc.sessionID)
		if w.Code != http.StatusBadRequest && w.Code != http.StatusNotFound {
			t.Fatalf("body %s: status = %d, want 400/404", tc.body, w.Code)
		}
		m := decode(t, w)
		if code, _ := m["code"].(string); code != tc.wantCode {
			t.Fatalf("body %s: code = %q, want %q", tc.body, code, tc.wantCode)
		}
	}
	// 坏载荷与死地址均不落库
	if in, _ := store.Get().Inbox.Get("agent-live"); in != nil {
		t.Fatalf("rejected payloads must not persist, got %+v", in)
	}
	if n := len(env.eventsOf(opschannel.EventTerminalMessage)); n != 0 {
		t.Fatalf("rejected payloads must not broadcast, got %d events", n)
	}
}

// TestSendMessage_DeliversAndBroadcasts 成功链路：落库 → 审计（仅元数据）→
// 通知弱条目（Action 直达目标会话）→ terminal.message 广播（摘要不含全文长尾）
func TestSendMessage_DeliversAndBroadcasts(t *testing.T) {
	env := newAPIEnv(t)
	longBody := "配置在 scripts/test.env\n第二行细节……（正文可以多行，摘要只取首行）"
	w := call(t, SendMessage, http.MethodPost, `{"to":"agent-live","body":`+jsonQuote(longBody)+`}`, "agent-a")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body: %s", w.Code, w.Body.String())
	}

	// 落库：目标收件箱 1 条未读
	in, err := store.Get().Inbox.Get("agent-live")
	if err != nil || in == nil || len(in.Messages) != 1 {
		t.Fatalf("inbox after send = %+v, %v", in, err)
	}
	msg := in.Messages[0]
	if msg.From != "agent-a" || msg.Body != longBody || msg.Read {
		t.Fatalf("message = %+v, want from agent-a unread", msg)
	}

	// 广播载荷：from/to/摘要（首行），全文不上广播面
	evs := env.eventsOf(opschannel.EventTerminalMessage)
	if len(evs) != 1 {
		t.Fatalf("terminal.message events = %d, want 1", len(evs))
	}
	pl, _ := evs[0].Payload.(map[string]any)
	if pl["from"] != "agent-a" || pl["to"] != "agent-live" {
		t.Fatalf("broadcast payload = %+v", pl)
	}
	if s, _ := pl["summary"].(string); s != "配置在 scripts/test.env" {
		t.Fatalf("summary = %q, want first line only", s)
	}

	// 审计：仅元数据（from/to/bytes），正文不出现
	events, _, _ := store.Get().Audit.List(50, 0)
	found := false
	for _, e := range events {
		if e.Action != store.AuditOpsMessageSend {
			continue
		}
		found = true
		if strings.Contains(e.Detail, "test.env") || strings.Contains(e.Detail, "第二行") {
			t.Fatalf("audit must not contain body, detail = %q", e.Detail)
		}
		if !strings.Contains(e.Detail, "from=agent-a") || !strings.Contains(e.Detail, "to=agent-live") {
			t.Fatalf("audit detail = %q, want from/to metadata", e.Detail)
		}
	}
	if !found {
		t.Fatalf("opsmessage.send audit event missing")
	}

	// 通知弱条目：Action 直达目标会话
	notifs := store.Get().Notification.List(50)
	hit := false
	for _, n := range notifs {
		if n.TitleKey == "opsmessage.notify.title" {
			hit = true
			if n.ActionPayload != "agent-live" {
				t.Fatalf("notification actionPayload = %q, want target session id", n.ActionPayload)
			}
		}
	}
	if !hit {
		t.Fatalf("opsmessage.notify notification missing")
	}
}

// TestGetInbox_DrainAndReadBroadcast 拉取即读：首次拉取返回全部未读（投递序）
// 并广播 read 事件；再次拉取为空且无第二次广播
func TestGetInbox_DrainAndReadBroadcast(t *testing.T) {
	env := newAPIEnv(t)
	mustSend(t, "agent-a", `{"to":"agent-live","body":"first"}`)
	mustSend(t, "agent-b", `{"to":"agent-live","body":"second"}`)

	w := call(t, GetInbox, http.MethodGet, "", "agent-live")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Data []store.InboxMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Data) != 2 || resp.Data[0].Body != "first" || resp.Data[1].Body != "second" {
		t.Fatalf("inbox drain = %+v, want first/second in order", resp.Data)
	}
	if !resp.Data[0].Read || !resp.Data[1].Read {
		t.Fatalf("drained messages must be marked read")
	}

	// read 广播：count=2
	reads := env.eventsOf(opschannel.EventTerminalMessageRead)
	if len(reads) != 1 {
		t.Fatalf("terminal.message.read events = %d, want 1", len(reads))
	}
	if pl, _ := reads[0].Payload.(map[string]any); pl["sessionId"] != "agent-live" {
		t.Fatalf("read payload = %+v", pl)
	}

	// 再拉为空，无新 read 广播
	w2 := call(t, GetInbox, http.MethodGet, "", "agent-live")
	var resp2 struct {
		Data []store.InboxMessage `json:"data"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &resp2)
	if len(resp2.Data) != 0 {
		t.Fatalf("second drain = %+v, want empty", resp2.Data)
	}
	if n := len(env.eventsOf(opschannel.EventTerminalMessageRead)); n != 1 {
		t.Fatalf("read events after empty drain = %d, want still 1", n)
	}
}

// TestGetInbox_RequiresSessionHeader 缺发送方/归属头 400
func TestGetInbox_RequiresSessionHeader(t *testing.T) {
	newAPIEnv(t)
	w := call(t, GetInbox, http.MethodGet, "", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if code, _ := decode(t, w)["code"].(string); code != "ops.message_payload_invalid" {
		t.Fatalf("code = %q", code)
	}
}

// TestSendMessage_RateLimited 同会话超限静默丢弃：200 同响应、不落库、
// system:rate-limited 回告载荷形状与 ops-notify 一致
func TestSendMessage_RateLimited(t *testing.T) {
	env := newAPIEnv(t)
	limiter := opsMessageLimiter
	// 烧完本会话预算（含已往测试用量；Hit 恒递增，补打至上限）
	for limiter.Hit("sid:agent-spam") <= opsMessageRateLimit {
	}
	w := call(t, SendMessage, http.MethodPost, `{"to":"agent-live","body":"x"}`, "agent-spam")
	if w.Code != http.StatusOK {
		t.Fatalf("rate limited status = %d, want 200 (silent drop)", w.Code)
	}
	if in, _ := store.Get().Inbox.Get("agent-live"); in != nil {
		t.Fatalf("dropped message must not persist")
	}
	evs := env.eventsOf(opschannel.EventRateLimited)
	if len(evs) == 0 {
		t.Fatalf("rate limited feedback event missing")
	}
	last := evs[len(evs)-1]
	// 载荷按线上形态（WS JSON）解析——观察者拿到的是构造时的结构体，
	// 消费方经序列化读取，测试同口径
	raw, _ := json.Marshal(last.Payload)
	var pl map[string]any
	if json.Unmarshal(raw, &pl) != nil {
		t.Fatalf("rate limited payload not JSON-object: %+v", last.Payload)
	}
	if pl["dimension"] != "session" || pl["key"] != "agent-spam" {
		t.Fatalf("rate limited payload = %+v", pl)
	}
}

// TestMessageSummary 广播摘要形态：首行截取 + rune 截断不腰斩
func TestMessageSummary(t *testing.T) {
	if got := MessageSummary("first line\nsecond"); got != "first line" {
		t.Fatalf("summary = %q, want first line", got)
	}
	long := strings.Repeat("汉", summaryMax+10)
	got := MessageSummary(long)
	if want := strings.Repeat("汉", summaryMax) + "…"; got != want {
		t.Fatalf("rune truncation mismatch: len = %d", len([]rune(got)))
	}
	if got := MessageSummary("plain"); got != "plain" {
		t.Fatalf("summary = %q, want unchanged", got)
	}
}

// ── helpers ──

func mustSend(t *testing.T, from, body string) {
	t.Helper()
	if w := call(t, SendMessage, http.MethodPost, body, from); w.Code != http.StatusOK {
		t.Fatalf("send from %s: status = %d, body: %s", from, w.Code, w.Body.String())
	}
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
