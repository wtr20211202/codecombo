package terminal

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/terminal"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// replayWSPair 起一个只做 WS 升级的 httptest 服务，返回服务端 wssafe.Conn 与
// 已拨号的客户端连接——sendScrollbackReplay 的帧形态/续期/断开退出测试基建。
// 升级 handler 发出连接后即返回（不 defer close，连接由测试清理函数收尾）
func replayWSPair(t *testing.T) (*wssafe.Conn, *websocket.Conn) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	upgraded := make(chan *websocket.Conn, 1)
	r := gin.New()
	r.GET("/ws/replay-test", func(c *gin.Context) {
		conn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
		if err != nil {
			return
		}
		upgraded <- conn
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/replay-test"
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })

	select {
	case serverConn := <-upgraded:
		return wssafe.New(serverConn), client
	case <-time.After(2 * time.Second):
		t.Fatal("ws upgrade timeout")
	}
	return nil, nil
}

// readAllFrames 逐帧读到 wantBytes 字节或 deadline，返回帧载荷拼接与帧计数
func readAllFrames(t *testing.T, client *websocket.Conn, wantBytes int) ([]byte, int) {
	t.Helper()
	var got []byte
	frames := 0
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	for len(got) < wantBytes {
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("第 %d 帧读取失败（已收 %d/%d 字节）: %v", frames, len(got), wantBytes, err)
		}
		got = append(got, msg...)
		frames++
	}
	return got, frames
}

// TestReplaySmallSingleFrame ≤256KB 的重放保持单帧（原实现帧形态，逐字节一致）
func TestReplaySmallSingleFrame(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), 100<<10) // 100KB < 256KB 分界
	serverConn, client := replayWSPair(t)

	errCh := make(chan error, 1)
	go func() { errCh <- sendScrollbackReplay(serverConn, payload, nil) }()

	got, frames := readAllFrames(t, client, len(payload))
	if frames != 1 {
		t.Fatalf("小负载应单帧送达，实际 %d 帧", frames)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("单帧载荷不一致: got %d 字节 want %d", len(got), len(payload))
	}
	// 单帧之后不应再有数据帧（哨兵由 handler 在 helper 之后发送，不属本函数）
	_ = client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err := client.ReadMessage(); err == nil {
		t.Fatal("单帧路径不应有额外帧")
	}
	if err := <-errCh; err != nil {
		t.Fatalf("sendScrollbackReplay: %v", err)
	}
}

// TestReplayLargeChunkedAndSentinelAfter 大于 256KB 按 128KB 分帧：帧数符合
// 切分预期、每帧 ≤128KB、拼接逐字节一致；R 哨兵在全部块之后（重放/活命令
// 门禁回归——哨兵提前会让前端把重放段当活命令记账）
func TestReplayLargeChunkedAndSentinelAfter(t *testing.T) {
	payload := make([]byte, 600<<10) // 600KB，确定性伪随机内容
	for i := range payload {
		payload[i] = byte(i * 31 % 251)
	}
	serverConn, client := replayWSPair(t)

	errCh := make(chan error, 1)
	go func() { errCh <- sendScrollbackReplay(serverConn, payload, nil) }()

	got, frames := readAllFrames(t, client, len(payload))
	wantFrames := (len(payload) + replayChunkBytes - 1) / replayChunkBytes
	if frames != wantFrames {
		t.Fatalf("600KB 应切 %d 帧，实际 %d 帧", wantFrames, frames)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("分帧拼接与原载荷不一致: got %d 字节", len(got))
	}
	if err := <-errCh; err != nil {
		t.Fatalf("sendScrollbackReplay: %v", err)
	}

	// 模拟 handler 顺序：helper 返回后发 R 哨兵——必须是完整块之后的下一帧
	_ = serverConn.SetWriteDeadline(time.Now().Add(replayChunkDeadline))
	if err := serverConn.WriteMessage(websocket.BinaryMessage, []byte("\x1b]133;R\x07")); err != nil {
		t.Fatalf("写哨兵: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil {
		t.Fatalf("读哨兵: %v", err)
	}
	if string(msg) != "\x1b]133;R\x07" {
		t.Fatalf("哨兵帧内容不符: %q", msg)
	}
}

// TestReplayDeadlineRenewalPipe 块级 deadline 续期（确定性）：net.Pipe 零缓冲——
// 服务端每块 WriteMessage 精确阻塞到客户端读取，每块阻塞 150ms。块级续期
// （250ms/块）下 8 块全部送达；若退化为原实现的「整份重放共用一次 deadline」
// 语义，第 3 块起写时刻已超 250ms 必失败——本测试对两种语义有区分度
func TestReplayDeadlineRenewalPipe(t *testing.T) {
	oldDeadline := replayChunkDeadline
	replayChunkDeadline = 250 * time.Millisecond
	t.Cleanup(func() { replayChunkDeadline = oldDeadline })

	const frames = 8
	payload := make([]byte, frames*replayChunkBytes)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	serverConn, frameReader := replayWSPipe(t)

	errCh := make(chan error, 1)
	go func() { errCh <- sendScrollbackReplay(serverConn, payload, nil) }()

	var got []byte
	for i := 0; i < frames; i++ {
		time.Sleep(150 * time.Millisecond) // 每帧迟 150ms 才读：服务端该块写阻塞 150ms
		msg, err := frameReader.readFrame()
		if err != nil {
			t.Fatalf("慢读端第 %d 帧读取失败: %v", i, err)
		}
		got = append(got, msg...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("慢读端收到的重放不一致: got %d 字节 want %d", len(got), len(payload))
	}
	if err := <-errCh; err != nil {
		t.Fatalf("块级续期下不应有写错误: %v", err)
	}
}

// TestReplayStopsWhenClientGone 客户端读一帧后断开：helper 必须以错误返回
// （写失败即退出），不为死连接灌完 8MB——同时即「大缓冲 8MB」规模冒烟
func TestReplayStopsWhenClientGone(t *testing.T) {
	payload := make([]byte, 8<<20) // 8MB
	for i := range payload {
		payload[i] = byte(i * 7 % 251)
	}
	serverConn, client := replayWSPair(t)

	errCh := make(chan error, 1)
	go func() { errCh <- sendScrollbackReplay(serverConn, payload, nil) }()

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, err := client.ReadMessage(); err != nil {
		t.Fatalf("读首帧: %v", err)
	}
	client.Close() // 粗暴断开（不读剩余 ~7.9MB，内核会以 RST 回敬后续写）

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("对端断开后 helper 应返回错误")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("对端断开后 helper 未退出（为死连接灌剩余块）")
	}
}

// TestReplayFromScrollbackReader native 路径端到端：ScrollbackBuffer 分段读取器
// → 分帧 WS，客户端拼回的字节流与 Snapshot(0) 逐字节一致（读器与快照两实现对账）
func TestReplayFromScrollbackReader(t *testing.T) {
	b := terminal.NewScrollbackWithCapacity(1 << 20) // 1MB 环
	fill := make([]byte, 2<<20)                      // 灌 2MB 触发滚动覆盖，环满
	for i := range fill {
		fill[i] = byte(i * 13 % 249)
	}
	b.Write(fill)

	want := b.Snapshot(0)
	if len(want) <= replaySingleFrameMax {
		t.Fatalf("前置失效：快照 %d 字节应大于单帧分界 %d", len(want), replaySingleFrameMax)
	}
	serverConn, client := replayWSPair(t)

	errCh := make(chan error, 1)
	go func() { errCh <- sendScrollbackReplay(serverConn, nil, b.SnapshotReader(0)) }()

	got, _ := readAllFrames(t, client, len(want))
	if !bytes.Equal(got, want) {
		t.Fatalf("Reader 分帧重放与 Snapshot 不一致: got %d 字节 want %d", len(got), len(want))
	}
	if err := <-errCh; err != nil {
		t.Fatalf("sendScrollbackReplay: %v", err)
	}
}

// TestReplayEmptyNoFrame 空重放（新会话无历史）不写任何帧
func TestReplayEmptyNoFrame(t *testing.T) {
	serverConn, client := replayWSPair(t)
	if err := sendScrollbackReplay(serverConn, nil, nil); err != nil {
		t.Fatalf("空重放: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, _, err := client.ReadMessage(); err == nil {
		t.Fatal("空重放不应产生任何帧")
	} else if !isTimeoutErr(err) {
		t.Fatalf("期望读超时，得到 %v", err)
	}
}

func isTimeoutErr(err error) bool {
	var ne net.Error
	if errors.As(err, &ne) {
		return ne.Timeout()
	}
	return errors.Is(err, os.ErrDeadlineExceeded)
}

// ============== net.Pipe 确定性测试基建 ==============
// net.Pipe 零缓冲：服务端每块 WriteMessage 精确阻塞到客户端逐字节读走——
// deadline 续期语义可被确定性钉住（TCP 回环有内核缓冲，写多在客户端未读时
// 就已完成，无法区分「每块续期」与「整份共用一次」两种语义）。

// replayHijackWriter 让 gorilla Upgrader 在 net.Pipe 一端完成升级的最小
// http.ResponseWriter（Hijack 返回管道端 + 空请求缓冲）
type replayHijackWriter struct {
	conn   net.Conn
	header http.Header
}

func (w *replayHijackWriter) Header() http.Header         { return w.header }
func (w *replayHijackWriter) Write(p []byte) (int, error) { return w.conn.Write(p) }
func (w *replayHijackWriter) WriteHeader(int)             {}
func (w *replayHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(bufio.NewReader(bytes.NewReader(nil)), bufio.NewWriter(w.conn)), nil
}

// rawFrameReader 服务端→客户端方向的裸 WS 帧读取器（服务端帧不掩码、
// fake 握手未协商 permessage-deflate，帧格式固定：2 字节头 + 变长载荷）
type rawFrameReader struct {
	br       *bufio.Reader
	deadline net.Conn // 底层管道端，readFrame 前借此设读 deadline 防挂死
}

// skipHandshake 跳过 101 响应头（空行 "\r\n" 即头部终结）
func (r *rawFrameReader) skipHandshake() error {
	for i := 0; ; i++ {
		part, err := r.br.ReadBytes('\n')
		if err != nil {
			return err
		}
		if string(part) == "\r\n" {
			return nil
		}
		if i > 64 {
			return errors.New("handshake response too long")
		}
	}
}

// readFrame 读一个完整 WS 帧，返回载荷。每次读取前重设 5s 读 deadline——
// 服务端停止写（如旧语义 deadline 失败退出）时保证读端可超时退出不挂死
func (r *rawFrameReader) readFrame() ([]byte, error) {
	if r.deadline != nil {
		_ = r.deadline.SetReadDeadline(time.Now().Add(5 * time.Second))
	}
	h := make([]byte, 2)
	if _, err := io.ReadFull(r.br, h); err != nil {
		return nil, err
	}
	ln := int64(h[1] & 0x7f)
	switch ln {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(r.br, ext); err != nil {
			return nil, err
		}
		ln = int64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(r.br, ext); err != nil {
			return nil, err
		}
		ln = int64(binary.BigEndian.Uint64(ext))
	}
	if h[1]&0x80 != 0 {
		return nil, errors.New("unexpected masked server frame")
	}
	payload := make([]byte, ln)
	if _, err := io.ReadFull(r.br, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// replayWSPipe 在 net.Pipe 两端建立 WS：服务端经 gorilla Upgrader 升级得到
// wssafe.Conn，客户端为裸帧读取器（先读完 101 响应头）
func replayWSPipe(t *testing.T) (*wssafe.Conn, *rawFrameReader) {
	t.Helper()
	clientEnd, serverEnd := net.Pipe()
	t.Cleanup(func() { clientEnd.Close(); serverEnd.Close() })

	req := httptest.NewRequest(http.MethodGet, "/ws/replay-test", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==") // RFC 6455 示例 nonce
	req.Header.Set("Sec-WebSocket-Version", "13")
	// 故意不带 Origin（SameOrigin 对空 Origin 放行）与 Sec-WebSocket-Extensions
	// （不协商压缩，帧保持裸格式可裸读）

	upgraded := make(chan *websocket.Conn, 1)
	go func() {
		conn, err := shared.WSUpgrader.Upgrade(&replayHijackWriter{conn: serverEnd, header: http.Header{}}, req, nil)
		if err != nil {
			t.Errorf("pipe upgrade: %v", err)
			return
		}
		upgraded <- conn
	}()

	reader := &rawFrameReader{br: bufio.NewReader(clientEnd), deadline: clientEnd}
	_ = clientEnd.SetReadDeadline(time.Now().Add(2 * time.Second)) // 握手读取防挂死
	if err := reader.skipHandshake(); err != nil {
		t.Fatalf("skip handshake: %v", err)
	}
	select {
	case serverConn := <-upgraded:
		return wssafe.New(serverConn), reader
	case <-time.After(2 * time.Second):
		t.Fatal("pipe upgrade timeout")
	}
	return nil, nil
}
