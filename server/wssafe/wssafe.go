// Package wssafe 提供 gorilla websocket 连接的并发写安全包装。
// 独立成包以避免 api/shared ↔ store ↔ notification 的循环依赖
package wssafe

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// PingInterval WS 心跳间隔。需要小于典型 NAT/防火墙空闲超时（一般 60s）
const PingInterval = 25 * time.Second

// Conn 包装 gorilla websocket.Conn，串行化并发写。
// gorilla 不允许多个 goroutine 同时调用同一连接的写方法（会触发
// "concurrent write to websocket connection" panic 或帧交错）：
// ping/pong 心跳 goroutine 与业务广播路径并发写同一 conn 正是 A9 记录的缺陷。
// 读方向无此约束（单读循环由各 handler 自持），这里只锁写。
type Conn struct {
	mu   sync.Mutex
	Conn *websocket.Conn
}

// New 包装已有连接
func New(c *websocket.Conn) *Conn {
	return &Conn{Conn: c}
}

// WriteMessage 串行化的文本/二进制/Ping 写。
// 约定：调用前必须先 SetWriteDeadline（或接受连接上遗留的 deadline）——
// 无 deadline 的写在对端停滞时可持锁阻塞最长至 TCP 层报错，拖累同连接所有写者
func (w *Conn) WriteMessage(msgType int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Conn.WriteMessage(msgType, data)
}

// SetWriteDeadline 转发写超时设置（deadline 是连接级状态，写锁下串行设置避免竞态）
func (w *Conn) SetWriteDeadline(t time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Conn.SetWriteDeadline(t)
}

// Close 关闭底层连接（与写操作互斥，Close 本身可并发安全调用，
// 加锁只是避免与进行中的写在日志/时序上交错）
func (w *Conn) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Conn.Close()
}

// pingWriteDeadline 单次 Ping 写的超时。deadline 是连接级持久状态：
// 每个 writer 写前自行设置，避免沿用上一次写遗留的过期 deadline
//（空闲连接上尤为关键——业务写可能很久不发生）。
const pingWriteDeadline = 10 * time.Second

// StartPing 启动 WS 心跳 goroutine：周期性发送 Ping 帧。
// 浏览器 WebSocket 协议层自动回 Pong；NAT/防火墙据此保持映射不过期。
// 写超时兜底：客户端停滞（TCP 零窗口）时写最多阻塞 pingWriteDeadline，
// 不会长期占住写锁阻塞业务广播路径。
// 返回停止函数，handler 返回前必须调用以终止 goroutine。
func (w *Conn) StartPing() (stop func()) {
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(PingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				w.mu.Lock()
				_ = w.Conn.SetWriteDeadline(time.Now().Add(pingWriteDeadline))
				_ = w.Conn.WriteMessage(websocket.PingMessage, nil)
				w.mu.Unlock()
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// StartRawKeepAlive 在原始 websocket.Conn 上启动周期 Ping 保活。
// 适用于不经过 wssafe.Conn 包装的 handler（clone/deploy/terminal 等短生命周期连接）
// NAT/防火墙空闲超时会静默丢弃无流量的 TCP 映射，25s 间隔 Ping 可防此问题
func StartRawKeepAlive(conn *websocket.Conn, interval time.Duration) (stop func()) {
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}
