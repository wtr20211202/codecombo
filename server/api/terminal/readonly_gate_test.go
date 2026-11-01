package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// 服务端只读闸（P-20261008-17）API 层单测：
//   - input-lock 端点：接管会话翻转/幂等同值不入账（审计条目计数）/自建会话
//     400/缺会话 404/缺 locked 字段 400
//   - WS 写链拦截：接管+闸开时输入帧被拒（TextMessage 稳定标记帧、PTY 无回显、
//     连接保活），解锁后同连接写通——「广播豁免不读本标记」的服务端结构面由
//     server/terminal/serverreadonly_test.go 的 BroadcastExempt 用例守
//
// 会话夹具走真实 PTY（Windows ConPTY / Unix creak-pty），不可用环境如实跳过
// （terminal_sensitive_test 同惯例）。

func setupReadOnlyGateTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.PUT("/api/terminals/:id/input-lock", SetTerminalInputLock)
	return r
}

func putInputLock(t *testing.T, r *gin.Engine, id, body string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/terminals/"+id+"/input-lock", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

// newExternalTestSession 真实 PTY 会话夹具，并把来源与闸改写为接管形态：
// Origin=external + serverReadOnly=true（= AttachExternalSession 落点后的
// 状态，接管初值本身由 server/terminal 包的真实接管用例守）——本文件守的是
// API/WS 层按 Origin+标记的裁决，origin 是创建后不变的登记字段
func newExternalTestSession(t *testing.T, id string) *terminal.Session {
	t.Helper()
	s, err := terminal.DefaultManager.CreateSession(id, id, t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(id) })
	s.Origin = terminal.OriginExternal
	s.SetServerReadOnly(true)
	return s
}

func TestSetTerminalInputLock_Roundtrip(t *testing.T) {
	r := setupReadOnlyGateTest(t)
	s := newExternalTestSession(t, "ro-lock-1")

	// 接管会话缺省闸开（接管时置位）：读出 locked=true
	if !s.ServerReadOnly() {
		t.Fatal("external fixture must start gated (attach-time default)")
	}

	// 请求路径一律用 s.ID：tmux 后端（Linux）把请求 id 改写为 sc-<hash>-<suffix>，
	// 字面 id 在该后端查无此会话（native 后端同名直通，两平台同断言）
	// 解锁：200 且闸关
	if code, body := putInputLock(t, r, s.ID, `{"locked":false}`); code != http.StatusOK {
		t.Fatalf("unlock status = %d, body = %s", code, body)
	} else if !strings.Contains(body, `"locked":false`) {
		t.Fatalf("unlock body missing state echo: %s", body)
	}
	if s.ServerReadOnly() {
		t.Fatal("unlock must release the server gate")
	}

	// 重锁：200 且闸开
	if code, _ := putInputLock(t, r, s.ID, `{"locked":true}`); code != http.StatusOK {
		t.Fatal("re-lock must succeed")
	}
	if !s.ServerReadOnly() {
		t.Fatal("re-lock must engage the server gate")
	}

	// 幂等同值：200，闸状态不变
	if code, _ := putInputLock(t, r, s.ID, `{"locked":true}`); code != http.StatusOK {
		t.Fatal("idempotent set must succeed")
	}
	if !s.ServerReadOnly() {
		t.Fatal("idempotent set must keep state")
	}
}

func TestSetTerminalInputLock_Rejections(t *testing.T) {
	r := setupReadOnlyGateTest(t)
	sExt := newExternalTestSession(t, "ro-lock-2")

	// 缺会话：404（原文 "session not found" 与 WS handler 同文，前端既有映射）
	if code, body := putInputLock(t, r, "ro-missing", `{"locked":true}`); code != http.StatusNotFound || !strings.Contains(body, "session not found") {
		t.Fatalf("missing session: status=%d body=%s", code, body)
	}

	// 自建会话：400（闸只对接管面有意义——自建 pane 锁是纯 UI）。
	// 路径用 s2.ID（tmux 后端改名同上注）
	s2, err := terminal.DefaultManager.CreateSession("ro-lock-self", "ro-lock-self", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s2.ID) })
	if code, body := putInputLock(t, r, s2.ID, `{"locked":true}`); code != http.StatusBadRequest {
		t.Fatalf("self-origin session: status=%d body=%s, want 400", code, body)
	}

	// 缺 locked 字段 / 非 JSON：400（terminal.payload_invalid）
	if code, _ := putInputLock(t, r, sExt.ID, `{}`); code != http.StatusBadRequest {
		t.Fatalf("missing locked field: status=%d, want 400", code)
	}
	if code, _ := putInputLock(t, r, sExt.ID, `not-json`); code != http.StatusBadRequest {
		t.Fatalf("non-json body: status=%d, want 400", code)
	}
}

func TestSetTerminalInputLock_AuditOnChangeOnly(t *testing.T) {
	r := setupReadOnlyGateTest(t)
	s := newExternalTestSession(t, "ro-lock-3")

	count := func() int {
		events, _, err := store.Get().Audit.List(100, 0)
		if err != nil {
			t.Fatalf("audit list: %v", err)
		}
		n := 0
		for _, e := range events {
			if e.Action == store.AuditTerminalInputLock {
				n++
			}
		}
		return n
	}

	if got := count(); got != 0 {
		t.Fatalf("no toggle yet, audit rows = %d", got)
	}
	// 幂等同值（闸已开再上锁）：不入账——连点不刷台账
	if code, _ := putInputLock(t, r, s.ID, `{"locked":true}`); code != http.StatusOK {
		t.Fatal("idempotent lock must succeed")
	}
	if got := count(); got != 0 {
		t.Fatalf("idempotent set must not audit, rows = %d", got)
	}
	// 实际翻转：入账，Detail 携会话与方向元数据
	if code, _ := putInputLock(t, r, s.ID, `{"locked":false}`); code != http.StatusOK {
		t.Fatal("unlock must succeed")
	}
	if got := count(); got != 1 {
		t.Fatalf("state change must audit once, rows = %d", got)
	}
	events, _, _ := store.Get().Audit.List(100, 0)
	var found *store.AuditEvent
	for i := range events {
		if events[i].Action == store.AuditTerminalInputLock {
			found = &events[i]
		}
	}
	if found == nil || !strings.Contains(found.Detail, "session="+s.ID) || !strings.Contains(found.Detail, "locked=false") {
		t.Fatalf("audit detail missing session/state: %+v", found)
	}
}

// TestTerminalWS_ReadOnlyGate WS 写链拦截全链（真实 PTY + 真实 WS 升级）：
// 接管+闸开 → 输入帧被拒（收到 readonly_external 标记帧、PTY 无回显、连接
// 活着）→ 端点解锁 → 同连接写通回显。agent 令牌直调 WS 写链的可编程感知
// 面（提案 ②）由此钉死。
// 读侧纪律：gorilla 的 ReadMessage 一旦返回过错误（含 deadline 超时）连接
// 即永久失败——读必须在单一 goroutine 里不带短 deadline 跑完，各阶段经
// channel 协调，不得在主测线程反复 ReadMessage
func TestTerminalWS_ReadOnlyGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	s := newExternalTestSession(t, "ro-ws-1")
	if !s.ServerReadOnly() {
		t.Fatal("external fixture must start gated")
	}

	r := gin.New()
	r.GET("/ws/terminal/:id", HandleTerminalWS)
	r.PUT("/api/terminals/:id/input-lock", SetTerminalInputLock)
	srv := httptest.NewServer(r)
	defer srv.Close()
	// WS URL 与解锁端点都用 s.ID：tmux 后端（Linux）把请求 id 改写为
	// sc-<hash>-<suffix>，字面 id 查无此会话（Roundtrip 用例同注）
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminal/" + s.ID

	dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Skipf("ws dial unavailable: %v", err)
	}
	defer conn.Close()
	if resp != nil {
		resp.Body.Close()
	}

	type wsFrame struct {
		text    bool
		payload string
	}
	frames := make(chan wsFrame, 64)
	readDead := make(chan struct{})
	go func() {
		for {
			mt, payload, err := conn.ReadMessage()
			if err != nil {
				close(readDead)
				return
			}
			frames <- wsFrame{text: mt == websocket.TextMessage, payload: string(payload)}
		}
	}()

	waitFrame := func(timeout time.Duration) (wsFrame, bool) {
		select {
		case f := <-frames:
			return f, true
		case <-readDead:
			return wsFrame{}, false
		case <-time.After(timeout):
			return wsFrame{}, false
		}
	}

	// 闸开：写一帧 → 收到 TextMessage 拒绝帧（稳定 code）
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo SC-RO-WS-REJECT\r")); err != nil {
		t.Fatalf("write while gated: %v", err)
	}
	sawRejection := false
	gatedBinary := ""
	for !sawRejection {
		f, ok := waitFrame(5 * time.Second)
		if !ok {
			t.Fatalf("expected rejection frame, timed out (binary=%q)", gatedBinary)
		}
		if !f.text {
			gatedBinary += f.payload // 重放/提示符等终端字节，攒着做负断言
			continue
		}
		var frame struct {
			Type string `json:"type"`
			Code string `json:"code"`
		}
		if err := json.Unmarshal([]byte(f.payload), &frame); err != nil {
			t.Fatalf("rejection frame not JSON: %v (%s)", err, f.payload)
		}
		if frame.Type != "input_rejected" || frame.Code != "readonly_external" {
			t.Fatalf("rejection frame = %+v, want type=input_rejected code=readonly_external", frame)
		}
		sawRejection = true
	}
	// PTY 无回显：拒绝后再给回显留一个短窗（本地 ConPTY 回显 ms 级到达），
	// 攒下的终端字节里不得出现被拒的标记
	drainDeadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(drainDeadline) {
		f, ok := waitFrame(200 * time.Millisecond)
		if !ok {
			continue
		}
		if !f.text {
			gatedBinary += f.payload
		}
	}
	if strings.Contains(gatedBinary, "SC-RO-WS-REJECT") {
		t.Fatalf("gated input leaked into PTY echo: %q", gatedBinary)
	}

	// 连接保活（拒绝不关连接）：解锁后同连接写通——「解锁→写通」闭环在
	// 同一条 WS 上完成，输出流不受拒绝影响
	if code, _ := putInputLock(t, r, s.ID, `{"locked":false}`); code != http.StatusOK {
		t.Fatal("unlock endpoint must succeed")
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo SC-RO-WS-PASS\r")); err != nil {
		t.Fatalf("write after unlock: %v", err)
	}
	echoed := ""
	echoDeadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(echoDeadline) {
		f, ok := waitFrame(500 * time.Millisecond)
		if !ok {
			continue
		}
		if f.text {
			continue // 防抖窗口尾巴上的旧拒绝帧（如有）不算回显
		}
		echoed += f.payload
		if strings.Contains(echoed, "SC-RO-WS-PASS") {
			return
		}
	}
	t.Fatalf("input after unlock never echoed, accumulated=%q", echoed)
}
