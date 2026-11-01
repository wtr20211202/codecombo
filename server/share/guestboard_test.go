package share

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// 访客留言端点（P-20261006-13）纪律锁：同门（口令守卫）、限长/清洗、
// 双维度频控、通知缓冲与冲刷、附表未装配降级——写入面的四道防线逐条
// 可执行化，防后续演进放水

// fakeMsgBoard MessageBoard 测试替身（记录写入，List 回放）
type fakeMsgBoard struct {
	mu    sync.Mutex
	msgs  map[string][]*store.ShareMessage
	adds  int
	alive map[string]bool // token 存活表（ErrNotFound 模拟）
}

func newFakeMsgBoard(alive ...string) *fakeMsgBoard {
	m := &fakeMsgBoard{msgs: map[string][]*store.ShareMessage{}, alive: map[string]bool{}}
	for _, t := range alive {
		m.alive[t] = true
	}
	return m
}

func (f *fakeMsgBoard) Add(token, nickname, text string, now time.Time) (*store.ShareMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.alive[token] {
		return nil, store.ErrNotFound
	}
	f.adds++
	m := &store.ShareMessage{ID: fakeMsgID(f.adds), Token: token, Nickname: nickname, Text: text, CreatedAt: now}
	f.msgs[token] = append([]*store.ShareMessage{m}, f.msgs[token]...)
	return m, nil
}

func (f *fakeMsgBoard) List(token string, limit int) ([]store.ShareMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.alive[token] {
		return nil, store.ErrNotFound
	}
	list := f.msgs[token]
	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	out := make([]store.ShareMessage, 0, len(list))
	for _, m := range list {
		out = append(out, *m)
	}
	return out, nil
}

// fakeMsgID 形如 newMsgID 的定宽时序 id（首段定长数字，键序即序的形态契约）
func fakeMsgID(n int) string {
	base := "0000000000000000000"
	s := []rune(base + itoa(n))
	return string(s[len(s)-19:]) + "-zzzz"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// boardTestEnv 起一个带留言附表与存活分享的访客子服务（httptest）
func boardTestEnv(t *testing.T, token string, locked bool) (*httptest.Server, *fakeMsgBoard) {
	t.Helper()
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindFile, ProjectID: "p1", Name: "guestboard"}}
	if locked {
		shares[token].PassphraseHash = "$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5B0C1V4uS1F1Gj2Qy5i5y5y5y5y5y"
	}
	board := newFakeMsgBoard(token)
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithMessageBoard(board)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, board
}

func boardURL(srv *httptest.Server, path string) string { return srv.URL + path }

func postMessage(t *testing.T, srv *httptest.Server, token string, body string) (*http.Response, map[string]any) {
	t.Helper()
	res, err := http.Post(boardURL(srv, "/s/"+token+"/messages"), "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post message: %v", err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

func TestGuestMessagePostListRoundtrip(t *testing.T) {
	token := fixedToken("gbok")
	srv, board := boardTestEnv(t, token, false)

	// 空态：列表为空数组（不是 null——前端零防御消费）
	res, err := http.Get(boardURL(srv, "/s/"+token+"/messages"))
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("get empty: %v %d", err, res.StatusCode)
	}
	var empty struct {
		Messages []store.ShareMessage `json:"messages"`
		Count    int                  `json:"count"`
	}
	_ = json.NewDecoder(res.Body).Decode(&empty)
	res.Body.Close()
	if empty.Messages == nil || len(empty.Messages) != 0 || empty.Count != 0 {
		t.Fatalf("empty list shape wrong: %+v", empty)
	}

	// 写入：昵称 + 正文回执
	res, out := postMessage(t, srv, token, `{"nickname":" bob ","text":"这个配置为什么这样写？"}`)
	if res.StatusCode != 200 {
		t.Fatalf("post: %d", res.StatusCode)
	}
	msgObj, _ := out["message"].(map[string]any)
	if msgObj == nil || msgObj["text"] != "这个配置为什么这样写？" {
		t.Fatalf("post response missing message: %v", out)
	}
	if msgObj["nickname"] != "bob" {
		t.Fatalf("nickname not trimmed: %v", msgObj["nickname"])
	}
	if board.adds != 1 {
		t.Fatalf("board adds = %d, want 1", board.adds)
	}

	// 列表可见（写入即可见——POST 响应即持久化回执）
	res2, _ := http.Get(boardURL(srv, "/s/"+token+"/messages"))
	var got struct {
		Messages []store.ShareMessage `json:"messages"`
		Count    int                  `json:"count"`
	}
	_ = json.NewDecoder(res2.Body).Decode(&got)
	res2.Body.Close()
	if got.Count != 1 || len(got.Messages) != 1 || got.Messages[0].Text != "这个配置为什么这样写？" {
		t.Fatalf("list after post: %+v", got)
	}
}

func TestGuestMessageValidation(t *testing.T) {
	token := fixedToken("gbval")
	srv, board := boardTestEnv(t, token, false)

	cases := []struct {
		name string
		body string
		want int
	}{
		{"空文本", `{"text":""}`, 400},
		{"纯空白", `{"text":"   \n  "}`, 400},
		{"超 500 rune", `{"text":"` + strings.Repeat("字", 501) + `"}`, 400},
		{"坏 JSON", `{not-json`, 400},
	}
	for _, c := range cases {
		res, _ := postMessage(t, srv, token, c.body)
		if res.StatusCode != c.want {
			t.Fatalf("%s: status = %d, want %d", c.name, res.StatusCode, c.want)
		}
	}
	if board.adds != 0 {
		t.Fatalf("rejected payloads must not consume board writes: %d", board.adds)
	}

	// 恰 500 rune 合法；控制字符被清洗（\r\n 归一、\t 折叠空格）
	long := strings.Repeat("字", 500)
	res, out := postMessage(t, srv, token, `{"text":"`+long+`"}`)
	if res.StatusCode != 200 {
		t.Fatalf("exact-500 rejected: %d", res.StatusCode)
	}
	if msgObj, _ := out["message"].(map[string]any); msgObj == nil || len([]rune(msgObj["text"].(string))) != 500 {
		t.Fatalf("exact-500 text lost: %v", out)
	}
	res, out = postMessage(t, srv, token, `{"text":"line1\r\nline2\tend"}`)
	if res.StatusCode != 200 {
		t.Fatalf("sanitize case rejected: %d", res.StatusCode)
	}
	if msgObj, _ := out["message"].(map[string]any); msgObj["text"] != "line1\nline2  end" {
		t.Fatalf("control chars not sanitized: %q", msgObj["text"])
	}
}

func TestGuestMessageRateLimit(t *testing.T) {
	token := fixedToken("gbrl")
	srv, _ := boardTestEnv(t, token, false)

	// 每 (token, IP) 每分钟 guestMsgMaxPerIP 条：第 6 条起 429 + Retry-After
	for i := 0; i < guestMsgMaxPerIP; i++ {
		res, _ := postMessage(t, srv, token, `{"text":"hi"}`)
		if res.StatusCode != 200 {
			t.Fatalf("post #%d limited unexpectedly: %d", i+1, res.StatusCode)
		}
	}
	res, _ := postMessage(t, srv, token, `{"text":"over"}`)
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("overflow status = %d, want 429", res.StatusCode)
	}
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
	// 垃圾载荷不消耗配额：429 后发坏载荷仍 400（校验先于频控计数）
	res, _ = postMessage(t, srv, token, `{bad`)
	if res.StatusCode != 400 {
		t.Fatalf("invalid payload after limit = %d, want 400", res.StatusCode)
	}
}

func TestGuestMessageGateAndDeadShare(t *testing.T) {
	token := fixedToken("gbgate")
	srv, _ := boardTestEnv(t, token, true)

	// 口令记录未持门会话：留言读写同内容子资源一律 401（守卫层收口）
	res, _ := postMessage(t, srv, token, `{"text":"hi"}`)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("locked post = %d, want 401", res.StatusCode)
	}
	lg, err := http.Get(boardURL(srv, "/s/"+token+"/messages"))
	if err != nil || lg.StatusCode != http.StatusUnauthorized {
		t.Fatalf("locked get = %v %d, want 401", err, lg.StatusCode)
	}
	lg.Body.Close()

	// 已撤销分享（附表 alive 表摘除模拟 ErrNotFound）：404 不借尸还魂
	srv2, board2 := boardTestEnv(t, token, false)
	res, _ = postMessage(t, srv2, token, `{"text":"hi"}`)
	if res.StatusCode != 200 {
		t.Fatalf("pre-revoke post = %d", res.StatusCode)
	}
	board2.mu.Lock()
	delete(board2.alive, token)
	board2.mu.Unlock()
	res, _ = postMessage(t, srv2, token, `{"text":"after revoke"}`)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("post to revoked share = %d, want 404", res.StatusCode)
	}
}

func TestGuestNoteBufferFlush(t *testing.T) {
	token := fixedToken("gbnote")
	srv, _ := boardTestEnv(t, token, false)
	svc := NewService(fakeShares{token: {Token: token, Kind: store.ShareKindFile}}, fakeRoots{}, nil)
	_ = srv

	// 攒批 → 冲刷 → 入账形态（模板键 + 参数 + panel 直达）
	svc.notes.Add(guestNote(&store.Share{Token: token, Name: "配置分享"},
		&store.ShareMessage{ID: "m1", Token: token, Nickname: "bob", Text: strings.Repeat("问", 100), CreatedAt: time.Now()}))
	svc.notes.Add(guestNote(&store.Share{Token: token, Name: "配置分享"},
		&store.ShareMessage{ID: "m2", Token: token, Text: "匿名留言", CreatedAt: time.Now()}))

	var got []notification.Notification
	n := svc.FlushGuestNotes(func(note notification.Notification) { got = append(got, note) })
	if n != 2 || len(got) != 2 {
		t.Fatalf("flushed = %d, got = %d", n, len(got))
	}
	first := got[0]
	if first.TitleKey != "share.msg.notify.title" || first.BodyKey != "share.msg.notify.body" {
		t.Fatalf("template keys missing: %+v", first)
	}
	if first.Action != "panel" || first.ActionPayload != "share-manager" {
		t.Fatalf("action missing: %+v", first)
	}
	if first.Type != "info" || first.Category != "system" {
		t.Fatalf("type/category wrong: %+v", first)
	}
	if got[0].MsgParams["nick"] != "bob" {
		t.Fatalf("nick param wrong: %v", got[0].MsgParams["nick"])
	}
	// 匿名占位 + 正文摘录截断（100 rune → 80 + 省略号）
	if got[1].MsgParams["nick"] == "" {
		t.Fatal("anonymous nick param should fall back to placeholder")
	}
	if text, _ := got[0].MsgParams["text"].(string); !strings.HasSuffix(text, "…") {
		t.Fatalf("long text should be excerpted, got len %d", len([]rune(text)))
	}

	// 冲刷即清：二次冲刷零条
	if n := svc.FlushGuestNotes(func(notification.Notification) {}); n != 0 {
		t.Fatalf("second flush = %d, want 0", n)
	}
}

func TestGuestMessageBoardNotWired(t *testing.T) {
	token := fixedToken("gbnil")
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindFile}}
	svc := NewService(shares, fakeRoots{}, nil) // 不注入 MessageBoard
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// GET 降级空态；POST 降级 503（装配面缺席是部署态，不是访客错误）
	res, err := http.Get(boardURL(srv, "/s/"+token+"/messages"))
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("unwired get: %v %d", err, res.StatusCode)
	}
	res.Body.Close()
	res, _ = postMessage(t, srv, token, `{"text":"hi"}`)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unwired post = %d, want 503", res.StatusCode)
	}
}
