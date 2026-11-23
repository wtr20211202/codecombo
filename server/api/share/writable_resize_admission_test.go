package shareapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	sharecore "codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gorilla/websocket"
)

// ── 视口反喂准入的 owner 附着门（P-20261122-16 ④）装配层单测 ──
//
// 三层断言：
//  1. writableAdapter.WritableResizeDenyReason 三态（空/owner_active/external_
//     session/session_missing）——owner 附着计数是「主人在本机开着该会话」的
//     唯一事实源；
//  2. **share 的 /termws 不计数**：访客上行桥建连后 AttachedClients 仍为 0
//     （否则访客一接入就把自己挡在门外、owner_active 恒真），而 HandleTerminal
//     WS 的 AttachClient/DetachClient 才驱动计数；
//  3. 同一会话 attach 期间准入拒绝、detach 后恢复允许——拒绝可恢复。
//
// 会话夹具走真实 PTY（不可用环境如实跳过，server/api/terminal 同惯例）。

// admTestShares 终端直播分享的最小 ShareLookup（token 精确命中）
type admTestShares map[string]*store.Share

func (f admTestShares) Get(token string) (*store.Share, error) {
	if s, ok := f[token]; ok {
		return s, nil
	}
	return nil, store.ErrNotFound
}

func (f admTestShares) Delete(token string) error {
	delete(f, token)
	return nil
}

// admTestRoots 本用例不取项目根（终端形态无快照锚点）
type admTestRoots struct{}

func (admTestRoots) RootOf(string) (string, error) {
	return "", fmt.Errorf("no roots in admission test")
}

// newAdmissionSession 真实 PTY 会话夹具（PTY 不可用如实跳过）。CreateSession
// 读 store.Get().Settings（后端选择）——按 server/api/terminal 同款先装临时
// 文档 store，避免 nil 解引用
func newAdmissionSession(t *testing.T, id string) *terminal.Session {
	t.Helper()
	if store.Get() == nil {
		store.SetDefault(store.New(filestore.New(t.TempDir())))
		t.Cleanup(func() { store.SetDefault(nil) })
	}
	s, err := terminal.DefaultManager.CreateSession(id, id, t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s.ID) })
	return s
}

func TestWritableResizeDenyReasonStates(t *testing.T) {
	adapter := writableAdapter{}

	// 会话不在/空 id：session_missing（准入口如实区分，不让访客以为是节流）
	if got := adapter.WritableResizeDenyReason(""); got != "session_missing" {
		t.Fatalf("empty session id reason = %q, want session_missing", got)
	}
	if got := adapter.WritableResizeDenyReason("definitely-not-a-session"); got != "session_missing" {
		t.Fatalf("unknown session reason = %q, want session_missing", got)
	}

	s := newAdmissionSession(t, "adm-owner-1")
	// 无附着：允许（空原因）
	if got := adapter.WritableResizeDenyReason(s.ID); got != "" {
		t.Fatalf("no attached client reason = %q, want allow", got)
	}
	// 主人本机有交互客户端附着（HandleTerminalWS 的计数面）：owner_active
	s.AttachClient()
	if got := adapter.WritableResizeDenyReason(s.ID); got != "owner_active" {
		t.Fatalf("attached client reason = %q, want owner_active", got)
	}
	// 主人关闭终端（detach）：恢复允许——拒绝可恢复，不是永久停驱动
	s.DetachClient()
	if got := adapter.WritableResizeDenyReason(s.ID); got != "" {
		t.Fatalf("after detach reason = %q, want allow", got)
	}
	// 外部接管会话优先于附着：external_session（真机 tmux window-size 未定义）
	s.Origin = terminal.OriginExternal
	s.AttachClient()
	t.Cleanup(func() { s.DetachClient() })
	if got := adapter.WritableResizeDenyReason(s.ID); got != "external_session" {
		t.Fatalf("external session reason = %q, want external_session", got)
	}
}

// TestShareWritableWSDoesNotCountOwnerClients 访客上行桥不冒充「主人在场」：
// /s/{token}/termws 建连后 owner 依附计数必须仍为 0——否则访客一接入就
// owner_active 恒真，视口反喂永远被自己的桥挡下（owner 附着门只认系统内终端
// WS 这一个事实源）
func TestShareWritableWSDoesNotCountOwnerClients(t *testing.T) {
	s := newAdmissionSession(t, "adm-owner-ws")
	token := "admtermwstoken01"
	shares := admTestShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: s.ID,
		Name: "adm", Writable: true, CreatedAt: time.Now(),
	}}
	// 装配真实键入落点（share 上行桥要求 sink 在场，否则诚实 503；本用例不发
	// 键入帧，sink 只会被 gateLedger 的闸迁移碰到）
	svc := sharecore.NewService(shares, admTestRoots{}, nil).WithWritableSink(writableAdapter{})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/s/" + token + "/termws?visitorId=v-adm"
	hdr := http.Header{}
	hdr.Set("Origin", wsURL) // 同源握手（服务端 CheckOrigin 判据，见 share wsUpgrader）
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		t.Fatalf("dial share termws: %v (status %d)", err, code)
	}
	t.Cleanup(func() { conn.Close() })
	// 读到 hello = 上行桥接线成立（开放直入：hello 即键入资格）
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var frame map[string]any
	if err := conn.ReadJSON(&frame); err != nil {
		t.Fatalf("read hello: %v", err)
	}
	if frame["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", frame)
	}
	if got := s.AttachedClients(); got != 0 {
		t.Fatalf("share /termws must not count as an owner client, AttachedClients = %d", got)
	}
	// 对照：系统内终端 WS 的计数面（AttachClient/DetachClient）才让 owner_active 成立
	s.AttachClient()
	if got := (writableAdapter{}).WritableResizeDenyReason(s.ID); got != "owner_active" {
		t.Fatalf("owner attached reason = %q, want owner_active", got)
	}
	s.DetachClient()
	if got := (writableAdapter{}).WritableResizeDenyReason(s.ID); got != "" {
		t.Fatalf("owner left reason = %q, want allow", got)
	}
}
