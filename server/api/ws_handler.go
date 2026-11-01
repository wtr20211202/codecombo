package api

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/model"
	"codecombo/server/store"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/wssafe"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// WebSocket连接管理
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*wssafe.Conn]bool // projectID -> connections
}

var hub = &Hub{
	clients: make(map[string]map[*wssafe.Conn]bool),
}

// 处理WebSocket连接
func HandleWebSocket(c *gin.Context) {
	projectID := c.Param("id")

	// 回显 Sec-WebSocket-Protocol（前端用 token 作子协议时浏览器需要）
	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		slog.Error("websocket upgrade failed", "err", err)
		return
	}
	// 输入帧上限防线（P-20261003-313）：本通道客户端不发数据帧，上限只作失控客户端兜底
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化（A9）：ping goroutine 与 Broadcast 路径共用本连接
	conn := wssafe.New(rawConn)

	// 注册 lock closer：token 被撤销时主动断开本连接
	// closer 函数内部禁止再调 lockStore 方法（避免锁中锁）
	lockToken := middleware.ExtractLockToken(c.Request)
	closerID := store.Get().Lock.RegisterWSConn(lockToken, func() { rawConn.Close() })
	defer store.Get().Lock.UnregisterWSConn(lockToken, closerID)

	// 读写超时 + pong handler 续期（读侧无并发，直接用原始连接）
	const readDeadline = 60 * time.Second
	_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	// 定期发送 ping（wssafe 内部串行化 + 写超时兜底）
	defer conn.StartPing()()

	hub.mu.Lock()
	if hub.clients[projectID] == nil {
		hub.clients[projectID] = make(map[*wssafe.Conn]bool)
	}
	hub.clients[projectID][conn] = true
	hub.mu.Unlock()

	defer func() {
		hub.mu.Lock()
		delete(hub.clients[projectID], conn)
		if len(hub.clients[projectID]) == 0 {
			delete(hub.clients, projectID)
		}
		hub.mu.Unlock()
		rawConn.Close()
	}()

	// 保持连接，读取客户端消息（心跳等）
	for {
		_, _, err := rawConn.ReadMessage()
		if err != nil {
			shared.WarnIfReadLimitExceeded(err, "projects")
			break
		}
	}
}

// 向指定项目的所有WebSocket客户端广播消息
func Broadcast(projectID string, msg model.WSMessage) {
	hub.mu.RLock()
	clients := hub.clients[projectID]
	// 复制连接列表，避免遍历时并发修改
	snapshot := make([]*wssafe.Conn, 0, len(clients))
	for conn := range clients {
		snapshot = append(snapshot, conn)
	}
	hub.mu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for _, conn := range snapshot {
		// 每次写都显式刷新 write deadline：ping goroutine 设的 deadline 是连接级持久状态，
		// 若不在此刷新，ping 间隔中后半段所有数据写都会因 deadline exceeded 失败导致连接被误关
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		err := conn.WriteMessage(websocket.TextMessage, data)
		if err != nil {
			conn.Conn.Close()
			hub.mu.Lock()
			delete(hub.clients[projectID], conn)
			if len(hub.clients[projectID]) == 0 {
				delete(hub.clients, projectID)
			}
			hub.mu.Unlock()
		}
	}
}
