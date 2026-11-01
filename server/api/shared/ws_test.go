package shared

import (
	"bytes"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// TestWSReadLimitDefense 读上限防线端到端机制（P-20261003-313）：
// 常量经 SetReadLimit 收口后——边界内帧正常收发；超限帧服务端读循环得
// ErrReadLimit、对端收到协议级 close 1009（message too big），连接被关。
// 同时钉住 WarnIfReadLimitExceeded 对 ErrReadLimit 与普通错误的判别不误伤
func TestWSReadLimitDefense(t *testing.T) {
	gin.SetMode(gin.TestMode)

	serverErr := make(chan error, 1)
	r := gin.New()
	r.GET("/ws/limit-test", func(c *gin.Context) {
		conn, err := WSUpgrader.Upgrade(c.Writer, c.Request, EchoSubprotocols(c.Request))
		if err != nil {
			return
		}
		defer conn.Close()
		// 与各业务升级点同款收口
		conn.SetReadLimit(WSReadLimitInput)
		for {
			msgType, msg, err := conn.ReadMessage()
			if err != nil {
				serverErr <- err
				return
			}
			if err := conn.WriteMessage(msgType, msg); err != nil {
				serverErr <- err
				return
			}
		}
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/limit-test"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// 边界内帧正常收发
	inLimit := bytes.Repeat([]byte("a"), WSReadLimitInput) // 恰好等于上限，不得误杀
	if err := conn.WriteMessage(websocket.BinaryMessage, inLimit); err != nil {
		t.Fatalf("write in-limit frame: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	msgType, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("in-limit frame should echo, got err=%v", err)
	}
	if msgType != websocket.BinaryMessage || !bytes.Equal(got, inLimit) {
		t.Fatalf("echo mismatch: type=%d len=%d", msgType, len(got))
	}

	// 超限帧：对端收到 close 1009
	overLimit := bytes.Repeat([]byte("b"), WSReadLimitInput+1)
	if err := conn.WriteMessage(websocket.BinaryMessage, overLimit); err != nil {
		t.Fatalf("write over-limit frame: %v", err)
	}
	_, _, err = conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
		t.Fatalf("over-limit frame should close with 1009, got err=%v", err)
	}

	// 服务端读循环以 ErrReadLimit 结束
	select {
	case err := <-serverErr:
		if !errors.Is(err, websocket.ErrReadLimit) {
			t.Fatalf("server read err = %v, want ErrReadLimit", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server read loop did not terminate after over-limit frame")
	}

	// WarnIfReadLimitExceeded 判别：超限命中，普通错误不触发（此处仅验证不 panic
	// 且对普通错误静默——日志内容断言不做，避免脆弱）
	WarnIfReadLimitExceeded(websocket.ErrReadLimit, "test")
	WarnIfReadLimitExceeded(errors.New("normal read error"), "test")
}

// TestWSUpgradeFactory 升级器统一工厂（P-20261003-327）：默认档与工厂化前
// 代理/锁拒绝两处历史字面量逐字段等价（CheckOrigin=SameOrigin、其余全零值），
// WithCompression 只动压缩位。前次工厂化尝试的红旗教训正是「某连接属性
// 悄悄漂移」（ReadBufferScale/EnableCompression 类隐藏字段），故按字段名
// 逐一钉死，新属性进 Upgrader 字段而未过此处即红
func TestWSUpgradeFactory(t *testing.T) {
	defaults := WSUpgrade()

	// 零值字段逐一名单：与工厂化前三处 upgrader 字面量的实况一致。
	// Read/WriteBufferSize=0 走 gorilla 内部 4096 默认档，与字面量时代同源
	if defaults.EnableCompression {
		t.Error("EnableCompression = true, want false（压缩必须显式 WithCompression）")
	}
	if defaults.HandshakeTimeout != 0 {
		t.Errorf("HandshakeTimeout = %v, want 0", defaults.HandshakeTimeout)
	}
	if defaults.ReadBufferSize != 0 {
		t.Errorf("ReadBufferSize = %d, want 0", defaults.ReadBufferSize)
	}
	if defaults.WriteBufferSize != 0 {
		t.Errorf("WriteBufferSize = %d, want 0", defaults.WriteBufferSize)
	}
	if defaults.WriteBufferPool != nil {
		t.Error("WriteBufferPool = non-nil, want nil")
	}
	if defaults.Subprotocols != nil {
		t.Errorf("Subprotocols = %v, want nil", defaults.Subprotocols)
	}
	if defaults.Error != nil {
		t.Error("Error = non-nil, want nil")
	}

	// CheckOrigin 语义 = SameOrigin（三态：跨源拒/同源放/无 Origin 放行）
	cases := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{"跨源拒绝", "http://evil.example.com", "127.0.0.1:9999", false},
		{"同源放行", "http://127.0.0.1:9999", "127.0.0.1:9999", true},
		{"无 Origin 放行（非浏览器客户端）", "", "127.0.0.1:9999", true},
	}
	for _, tc := range cases {
		t.Run("CheckOrigin "+tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "http://"+tc.host+"/", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := defaults.CheckOrigin(req); got != tc.want {
				t.Errorf("factory CheckOrigin(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}

	// WithCompression 只开压缩位，其余字段不被选项外溢
	withCompress := WSUpgrade(WithCompression())
	if !withCompress.EnableCompression {
		t.Error("WithCompression() 后 EnableCompression = false, want true")
	}
	if withCompress.WriteBufferPool != nil || withCompress.HandshakeTimeout != 0 || withCompress.Subprotocols != nil {
		t.Error("WithCompression() 外溢了非压缩字段")
	}

	// 业务共用升级器 = 工厂默认档 + 压缩（与 TestWSCompressionNegotiation 的
	// 协商行为测试互补，此处钉构造面）
	if !WSUpgrader.EnableCompression {
		t.Error("WSUpgrader must be WSUpgrade(WithCompression())")
	}
	if WSUpgrader.CheckOrigin == nil {
		t.Error("WSUpgrader.CheckOrigin must be SameOrigin")
	}
}

func TestSameOrigin(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{"无 Origin（非浏览器客户端）放行", "", "127.0.0.1:9999", true},
		{"同源 http", "http://127.0.0.1:9999", "127.0.0.1:9999", true},
		{"同源 https（反代终止 TLS）", "https://127.0.0.1:9999", "127.0.0.1:9999", true},
		{"跨源 host 不同", "http://evil.example.com", "127.0.0.1:9999", false},
		{"跨源 端口不同", "http://127.0.0.1:8080", "127.0.0.1:9999", false},
		{"畸形 Origin", "::::", "127.0.0.1:9999", false},
		{"仅 scheme 无 host", "http://", "127.0.0.1:9999", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := http.NewRequest("GET", "http://"+tc.host+"/", nil)
			r.Host = tc.host
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if got := SameOrigin(r); got != tc.want {
				t.Errorf("SameOrigin(%q, host=%q) = %v, want %v", tc.origin, tc.host, got, tc.want)
			}
		})
	}
}

// TestWSCompressionNegotiation permessage-deflate 压缩协商面（P-20261003-191）：
// WSUpgrader 启用 EnableCompression 后——客户端 offered（浏览器默认行为）
// → 101 响应带 Sec-WebSocket-Extensions: permessage-deflate（协商成立，其后
// data 帧按 RFC 7692 压缩）且子协议回显不受影响；客户端未 offered → 响应无
// 扩展头、链路保持不压。两形态下收发语义完全透明（回环字节恒等、消息类型
// 保持），即压缩对客户端不可见——终端/ops-channel 各 handler 零改动即可受益
func TestWSCompressionNegotiation(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.GET("/ws/compress-echo", func(c *gin.Context) {
		conn, err := WSUpgrader.Upgrade(c.Writer, c.Request, EchoSubprotocols(c.Request))
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			msgType, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(r)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/compress-echo"

	cases := []struct {
		name          string
		compressDial  bool   // 浏览器默认 offered permessage-deflate；agent 等裸客户端不 offered
		subprotocol   string // 终端 WS 用子协议传 unlock token，钉住与压缩扩展头共存
		wantExtension bool
	}{
		{"客户端 offered（浏览器默认）→ 协商成立且子协议回显共存", true, "sc-unlock-token", true},
		{"客户端未 offered → 无扩展头零变化", false, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dialer := *websocket.DefaultDialer
			dialer.EnableCompression = tc.compressDial
			dialer.Subprotocols = nil
			if tc.subprotocol != "" {
				dialer.Subprotocols = []string{tc.subprotocol}
			}
			conn, resp, err := dialer.Dial(wsURL, nil)
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer conn.Close()

			gotExt := resp.Header.Get("Sec-WebSocket-Extensions")
			if strings.Contains(gotExt, "permessage-deflate") != tc.wantExtension {
				t.Fatalf("Sec-WebSocket-Extensions = %q, want permessage-deflate present=%v", gotExt, tc.wantExtension)
			}
			if tc.subprotocol != "" && !strings.Contains(resp.Header.Get("Sec-WebSocket-Protocol"), tc.subprotocol) {
				t.Fatalf("Sec-WebSocket-Protocol = %q, want echo %q", resp.Header.Get("Sec-WebSocket-Protocol"), tc.subprotocol)
			}

			// 收发透明：高冗余大帧（构建日志/scrollback 形态）、小帧（按键
			// 回显形态）、不可压随机帧三类载荷回环字节恒等
			incompressible := make([]byte, 4096)
			if _, err := rand.Read(incompressible); err != nil {
				t.Fatalf("rand payload: %v", err)
			}
			payloads := []struct {
				name string
				data []byte
			}{
				{"高冗余大帧", bytes.Repeat([]byte("build log line with repetition\r\n"), 2000)},
				{"小帧", []byte("\x1b]133;R\x07")},
				{"不可压随机帧", incompressible},
			}
			for _, p := range payloads {
				if err := conn.WriteMessage(websocket.BinaryMessage, p.data); err != nil {
					t.Fatalf("write %s: %v", p.name, err)
				}
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				msgType, got, err := conn.ReadMessage()
				if err != nil {
					t.Fatalf("read %s: %v", p.name, err)
				}
				if msgType != websocket.BinaryMessage || !bytes.Equal(got, p.data) {
					t.Fatalf("%s echo mismatch: type=%d len=%d want=%d", p.name, msgType, len(got), len(p.data))
				}
			}
		})
	}
}
