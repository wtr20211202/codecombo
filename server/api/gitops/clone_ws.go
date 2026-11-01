package gitops

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// CloneProgressWS 处理 /ws/clone/:taskId 连接，推送克隆实时进度。
// 连接建立后：
//  1. Subscribe 原子补发已缓冲的进度行（客户端重连场景）
//  2. 实时转发订阅 channel 的进度行（多客户端广播，互不竞争消费）
//  3. 任务结束时推送 done 消息（含 status 和 result）
func CloneProgressWS(c *gin.Context) {
	taskID := c.Param("taskId")
	task, ok := git.DefaultTaskManager.Get(taskID)
	if !ok {
		shared.Error(c, http.StatusNotFound, "task not found", nil)
		return
	}

	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		slog.Error("clone ws upgrade failed", "err", err)
		return
	}
	// 输入帧上限防线（P-20261003-313）：本通道无读循环（纯写侧转发），上限为
	// 未来可能新增的读路径预置兜底
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化：ping 心跳与进度转发并发写裸 conn 会触发 gorilla panic
	conn := wssafe.New(rawConn)
	defer conn.Close()

	// keepalive + 读写 deadline：半开连接（NAT 掉线/对端断电）不再永久泄漏 handler
	defer conn.StartPing()()
	const readDeadline = 60 * time.Second
	_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	// 注册 lock closer：token 撤销时主动断开本连接
	lockToken := middleware.ExtractLockToken(c.Request)
	closerID := store.Get().Lock.RegisterWSConn(lockToken, func() { rawConn.Close() })
	defer store.Get().Lock.UnregisterWSConn(lockToken, closerID)

	// Subscribe 已原子补发历史进度行；channel 关闭即任务结束
	ch, unsub := task.Subscribe()
	defer unsub()

	for {
		line, ok := <-ch
		if !ok {
			// channel 关闭表示任务结束（markFinished 先置状态后关闭，
			// 此处必能读到最终状态）
			status, result := task.SnapshotStatus()
			writeCloneDone(conn, string(status), result)
			return
		}
		if writeErr := writeCloneProgress(conn, line); writeErr != nil {
			return
		}
	}
}

// writeCloneProgress 推送一行进度
func writeCloneProgress(conn *wssafe.Conn, line string) error {
	data, _ := json.Marshal(map[string]string{"type": "progress", "line": line})
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, data)
}

// writeCloneDone 推送任务结束消息
func writeCloneDone(conn *wssafe.Conn, status string, result *git.CloneResult) {
	msg := map[string]any{"type": "done", "status": status}
	if result != nil {
		msg["result"] = result
	}
	data, _ := json.Marshal(msg)
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, data)
}
