package remote

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/remoteterminal"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// ============== 终端输出合帧集成测（P-20261004-26） ==============
// 走真实 WS handler（RemoteTerminalWS）+ 可注入假 PTY，协议层断言写侧聚合：
// burst 块合并成远少于块数的帧、字节序完整、孤块不因窗口而滞留。

const (
	fptChunks    = 20
	fptChunkSize = 1024
	fptGap       = 50 * time.Millisecond // > 6× 生产 flush 窗口（8ms），机器抖动跨不过去
)

// framedPTY 测试 PTY：start 关闭后开始产块。产出节奏刻意制造一个确定性跨窗
// 间隙：前 2 块即时连发（同一 8ms 窗口内排空合并），第 3 块起等 50ms 再连发
// 余下 18 块——期望恰 2 帧（1+2KB、18KB），任何调度下也至多 3 帧，远小于
// 20 块。每块 1KB、内容为递增字母，断言合并不乱序不丢字节。
// Read 仅被会话 readLoop 单 goroutine 调用，chunk 计数无需加锁；Write 仅被
// WS 输入读循环单 goroutine 调用，written 关闭无并发双关面
type framedPTY struct {
	chunk   int
	start   chan struct{}
	closed  chan struct{}
	written chan struct{}
}

func newFramedPTY() *framedPTY {
	return &framedPTY{start: make(chan struct{}), closed: make(chan struct{}), written: make(chan struct{})}
}

func (p *framedPTY) Read(b []byte) (int, error) {
	if p.chunk == 0 {
		<-p.start // WS 客户端就位前不产出：scrollback 重放恒空，帧计数纯净
	}
	if p.chunk == 2 {
		time.Sleep(fptGap) // 确定性跨窗口间隙：把 burst 切成两个独立合帧窗口
	}
	if p.chunk >= fptChunks {
		<-p.closed
		return 0, io.EOF
	}
	idx := p.chunk
	p.chunk++
	n := fptChunkSize
	if n > len(b) {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		b[i] = byte('A' + idx)
	}
	return n, nil
}
func (p *framedPTY) Write(b []byte) (int, error) {
	select {
	case <-p.written:
	default:
		close(p.written)
	}
	return len(b), nil
}
func (p *framedPTY) Resize(uint16, uint16) error { return nil }
func (p *framedPTY) Close() error {
	select {
	case <-p.closed:
	default:
		close(p.closed)
	}
	return nil
}
func (p *framedPTY) SetReadDeadline(time.Time) error { return nil }

// startModule 测试装配（与 TestRemoteTerminalWSClientGone 同款：模块 Init/Stop
// 即装配/卸载），返回 Manager 供建会话/拨号
func startModule(t *testing.T, d remoteterminal.Dialer) *remoteterminal.Manager {
	t.Helper()
	m := remoteterminal.NewManagerWithGC(d, 5, time.Minute)
	mod := remoteterminal.NewModuleWithManager(m)
	if err := mod.Init(t.Context(), nil); err != nil {
		t.Fatalf("init remoteterminal module: %v", err)
	}
	t.Cleanup(func() { _ = mod.Stop(t.Context(), nil) })
	return m
}

// dialRemoteWS 建会话 + 真实握手，返回客户端连接（read deadline 兜底防挂死）
func dialRemoteWS(t *testing.T, m *remoteterminal.Manager) *websocket.Conn {
	t.Helper()
	s, err := m.CreateSession("host-frame", 24, 80, "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/ws/remote-terminal/:id", RemoteTerminalWS)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/remote-terminal/" + s.ID
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	t.Cleanup(func() { _ = ws.Close(); m.KillSession(s.ID) })
	return ws
}

// primeWSReadiness 输入探针：发一条客户端输入并等它被假 PTY 的 Write 消费。
// 服务端 handler 次序（RemoteTerminalWS）= Upgrade → scrollback 回放 →
// OnOutput 注册 → 输入读循环启动——探针被消费即「OnOutput 注册已完成」成立
// （输入读循环严格晚于注册启动），此后 PTY 产出必经实时流路径。
//
// 为什么必须有这一步：「Dial 返回 = 服务端 handler 已就绪」是次序假设——
// Dial 返回只证明 Upgrade 响应已发出，全量套件负载下 handler goroutine 在
// Upgrade 后可被调度延迟数十 ms；此间 close(start) 产出的块会两头落空
// （scrollback 快照已放空、实时流无订阅者），10s 读 deadline 超时——
// Linux 全量跑偶发、单跑恒绿正是该竞态的负载签名
func primeWSReadiness(t *testing.T, ws *websocket.Conn, written <-chan struct{}) {
	t.Helper()
	if err := ws.WriteMessage(websocket.TextMessage, []byte("ready")); err != nil {
		t.Fatalf("readiness probe write: %v", err)
	}
	select {
	case <-written:
	case <-time.After(5 * time.Second):
		t.Fatal("readiness probe not consumed: server input loop not started")
	}
}

// TestRemoteTerminalWSCoalescesBurst 高输出 burst 合帧：20 块即时输出因 50ms
// 跨窗间隙确定性切成两个窗口 → 恰 2 帧（调度劣化兜底 ≤3），字节序完整、
// 总量精确、不乱序不丢块
func TestRemoteTerminalWSCoalescesBurst(t *testing.T) {
	pty := newFramedPTY()
	m := startModule(t, adminDialerFunc(func(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
		return pty, nil
	}))

	ws := dialRemoteWS(t, m)
	primeWSReadiness(t, ws, pty.written) // 服务端已注册输出回调，产出必达实时流
	close(pty.start)                     // 客户端已就位，开始产出

	frames, total := 0, 0
	got := make([]byte, 0, fptChunks*fptChunkSize)
	for total < fptChunks*fptChunkSize {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("read frame #%d (got %d bytes so far): %v", frames+1, total, err)
		}
		frames++
		total += len(msg)
		got = append(got, msg...)
	}
	if frames > 3 {
		t.Fatalf("burst should coalesce to <=3 frames, got %d (20 chunks in)", frames)
	}
	if frames < 2 {
		t.Fatalf("expected 2 frames (deterministic cross-window gap), got %d", frames)
	}
	// 字节完整性 + 顺序：第 i 块 1KB 全为 'A'+i，合帧不得乱序/丢块
	for i := 0; i < fptChunks; i++ {
		want := strings.Repeat(string(rune('A'+i)), fptChunkSize)
		if string(got[i*fptChunkSize:(i+1)*fptChunkSize]) != want {
			t.Fatalf("chunk %d reordered/corrupted: got %q...", i, got[i*fptChunkSize:i*fptChunkSize+8])
		}
	}
}

// oneShotPTY 测试 PTY：start 关闭后产出单块 512B 'z'（交互回显形态），随后
// 静默直到 Close。produced 仅 readLoop 单 goroutine 触碰，无需加锁；Write
// 仅被 WS 输入读循环单 goroutine 调用，written 关闭无并发双关面
type oneShotPTY struct {
	produced bool
	start    chan struct{}
	closed   chan struct{}
	written  chan struct{}
}

func (p *oneShotPTY) Read(b []byte) (int, error) {
	<-p.start
	if p.produced {
		<-p.closed
		return 0, io.EOF
	}
	p.produced = true
	for i := 0; i < 512 && i < len(b); i++ {
		b[i] = 'z'
	}
	return 512, nil
}
func (p *oneShotPTY) Write(b []byte) (int, error) {
	select {
	case <-p.written:
	default:
		close(p.written)
	}
	return len(b), nil
}
func (p *oneShotPTY) Resize(uint16, uint16) error { return nil }
func (p *oneShotPTY) Close() error {
	select {
	case <-p.closed:
	default:
		close(p.closed)
	}
	return nil
}
func (p *oneShotPTY) SetReadDeadline(time.Time) error { return nil }

// TestRemoteTerminalWSSingleChunkPromptDelivery 孤块（交互回显形态）不因
// 合帧窗口滞留：单块产出后在宽松上界内必达（生产窗口 8ms，人类无感量级；
// 此处只卡 2s 病理上界，精确窗口语义由 shared 包单测把关）
func TestRemoteTerminalWSSingleChunkPromptDelivery(t *testing.T) {
	pty := &oneShotPTY{start: make(chan struct{}), closed: make(chan struct{}), written: make(chan struct{})}
	m := startModule(t, adminDialerFunc(func(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
		return pty, nil
	}))

	ws := dialRemoteWS(t, m)
	primeWSReadiness(t, ws, pty.written) // 服务端已注册输出回调，孤块必经实时流
	begin := time.Now()
	close(pty.start) // PTY 即刻产出孤块
	_, msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read echo frame: %v", err)
	}
	elapsed := time.Since(begin)
	if len(msg) != 512 || msg[0] != 'z' {
		t.Fatalf("echo frame = %d bytes, want 512B of 'z'", len(msg))
	}
	if elapsed > 2*time.Second {
		t.Fatalf("single chunk delivery stalled behind flush window: %v", elapsed)
	}
}
