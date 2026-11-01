package notify

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/wssafe"
)

// HandleNotificationWS 全局通知 WebSocket：所有页面订阅，新通知实时推送
// 路由：GET /ws/notifications
func HandleNotificationWS(c *gin.Context) {
	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		return
	}
	// 输入帧上限防线（P-20261003-313）：本通道客户端不发数据帧，上限只作失控客户端兜底
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化（A9）：多条通知并发广播时避免对同一 conn 的并发写
	conn := wssafe.New(rawConn)
	// NAT/防火墙保活：25s 间隔 Ping 防空闲超时
	defer conn.StartPing()()

	// 注册 lock closer：token 撤销时主动断开本连接
	lockToken := middleware.ExtractLockToken(c.Request)
	closerID := store.Get().Lock.RegisterWSConn(lockToken, func() { rawConn.Close() })
	defer store.Get().Lock.UnregisterWSConn(lockToken, closerID)

	hub := notification.GetHub()
	if hub == nil {
		// 通知模块未启动（异常装配态）：拒绝服务而非 panic
		_ = rawConn.Close()
		return
	}
	hub.Register(conn)
	defer hub.Unregister(conn)

	// 推送一条 hello 消息确认连接（便于前端调试）。
	// 写前设 deadline：wssafe 写锁内若无限期阻塞会卡死广播路径
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello"}`))

	// 阻塞读取（客户端不应发送任何消息；收到即视为断开）
	for {
		_, _, err := rawConn.ReadMessage()
		if err != nil {
			shared.WarnIfReadLimitExceeded(err, "notifications")
			return
		}
	}
}
