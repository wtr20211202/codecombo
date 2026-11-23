package terminal

// owner 终端 WS 拒绝帧分义（P-20261122-17）：分享持权闸优先回
// input_held_by_share（恢复路径在分享中心），真·接管只读才回
// readonly_external（input-lock 解锁可恢复）——两个稳定码是 agent/前端
// 可编程区分两类拒绝的契约。

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// newNativeTestSession 自建会话夹具（原生 PTY；不可用环境如实跳过）
func newNativeTestSession(t *testing.T, id string) *terminal.Session {
	t.Helper()
	s, err := terminal.DefaultManager.CreateSession(id, id, t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(id) })
	return s
}

// readRejectCode 从连接上读到下一枚 input_rejected 控制帧的 code（跳过
// 二进制重放/提示符字节；超时失败）
func readRejectCode(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		mt, payload, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read reject frame: %v", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		var frame struct {
			Type string `json:"type"`
			Code string `json:"code"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil {
			continue
		}
		if frame.Type == "input_rejected" {
			return frame.Code
		}
	}
	t.Fatal("no input_rejected frame within deadline")
	return ""
}

func dialTerminalWS(t *testing.T, srv *httptest.Server, sessionID string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminal/" + sessionID
	dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second}
	conn, resp, err := dialer.Dial(url, nil)
	if err != nil {
		t.Skipf("ws dial unavailable: %v", err)
	}
	if resp != nil {
		resp.Body.Close()
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestTerminalWS_RejectCodeSplitByGateSource(t *testing.T) {
	_ = setupReadOnlyGateTest(t) // store 默认装配（会话夹具依赖）
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/ws/terminal/:id", HandleTerminalWS)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 接管会话双闸同时在场：分享持权优先（input-lock 解不了分享闸，文案必须
	// 指向分享中心）
	s := newExternalTestSession(t, "ro-split-1")
	s.SetDirectInputHold(true)
	conn := dialTerminalWS(t, srv, s.ID)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo SC-HELD\r")); err != nil {
		t.Fatalf("write while held: %v", err)
	}
	if code := readRejectCode(t, conn); code != "input_held_by_share" {
		t.Fatalf("dual-gate reject code = %q, want input_held_by_share", code)
	}

	// 分享持权解除后回落到真接管只读码（既有契约不回归）
	s.SetDirectInputHold(false)
	conn2 := dialTerminalWS(t, srv, s.ID)
	if err := conn2.WriteMessage(websocket.BinaryMessage, []byte("echo SC-RO\r")); err != nil {
		t.Fatalf("write while readonly: %v", err)
	}
	if code := readRejectCode(t, conn2); code != "readonly_external" {
		t.Fatalf("readonly reject code = %q, want readonly_external", code)
	}
}

func TestTerminalWS_DirectInputHeldOnSelfBuiltSession(t *testing.T) {
	_ = setupReadOnlyGateTest(t) // store 默认装配（会话夹具依赖）
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/ws/terminal/:id", HandleTerminalWS)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// 自建会话（无 serverReadOnly）：只有分享持权一闸也回专属码
	s := newNativeTestSession(t, "held-native-1")
	s.SetDirectInputHold(true)
	conn := dialTerminalWS(t, srv, s.ID)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo SC-HELD2\r")); err != nil {
		t.Fatalf("write while held: %v", err)
	}
	if code := readRejectCode(t, conn); code != "input_held_by_share" {
		t.Fatalf("self-built session reject code = %q, want input_held_by_share", code)
	}
	// 解除后同形态输入被接受（连接保活：写不报错即可；回显按终端可用性不强断）
	s.SetDirectInputHold(false)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo SC-PASS2\r")); err != nil {
		t.Fatalf("write after hold release: %v", err)
	}
}
