package deploy

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/deploy"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// DeployProgressWS 处理 /ws/deploy/:taskId 连接，推送部署实时进度
// 1. Subscribe 时已自动回放最近 200 条历史
// 2. 实时推送 log / publicKey / progress
// 3. 任务结束时（收到 done 日志或 channel 关闭）发 done 后关闭
func DeployProgressWS(c *gin.Context) {
	taskID := c.Param("taskId")
	mgr := deploy.DefaultManager()
	if mgr == nil {
		shared.Error(c, http.StatusServiceUnavailable, "deploy manager not initialized", nil)
		return
	}

	// 任务不存在（既不在内存也不在持久化）
	if !mgr.IsRunning(taskID) {
		if _, err := store.Get().DeployTask.Get(taskID); err != nil {
			shared.Error(c, http.StatusNotFound, "task not found", nil)
			return
		}
	}

	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		slog.Error("deploy ws upgrade failed", "err", err)
		return
	}
	// 输入帧上限防线（P-20261003-313）：合法输入仅 "cancel" 文本，上限只作失控客户端兜底
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

	// 注册 lock closer
	lockToken := middleware.ExtractLockToken(c.Request)
	closerID := store.Get().Lock.RegisterWSConn(lockToken, func() { rawConn.Close() })
	defer store.Get().Lock.UnregisterWSConn(lockToken, closerID)

	// 客户端→服务端：监听 cancel 文本
	go func() {
		for {
			_, msg, err := rawConn.ReadMessage()
			if err != nil {
				shared.WarnIfReadLimitExceeded(err, "deploy")
				return
			}
			if string(msg) == "cancel" {
				mgr.Cancel(taskID)
			}
		}
	}()

	ch, unsub := mgr.Subscribe(taskID)
	defer unsub()

	// done 帧只发一次：done 日志条目与 channel 关闭补发可能双触发
	doneSent := false
	sendDoneOnce := func(status, errMsg string) {
		if !doneSent {
			doneSent = true
			writeDeployDone(conn, status, errMsg)
		}
	}

	for entry := range ch {
		if err := writeDeployLog(conn, entry); err != nil {
			return
		}
		// done 日志表示任务结束
		if entry.Step == "done" {
			if t, terr := store.Get().DeployTask.Get(taskID); terr == nil && t != nil {
				sendDoneOnce(t.Status, t.Error)
			} else {
				sendDoneOnce("completed", "")
			}
			return
		}
	}

	// channel 关闭但未收到 done：补发一个 done
	task, _ := store.Get().DeployTask.Get(taskID)
	if task != nil {
		sendDoneOnce(task.Status, task.Error)
	}
}

// writeDeployLog 推送一条 log 进度
func writeDeployLog(conn *wssafe.Conn, entry deploy.LogEntry) error {
	data := map[string]any{
		"time":     entry.Time,
		"deployer": entry.Deployer,
		"step":     entry.Step,
		"level":    entry.Level,
		"message":  entry.Message,
	}
	// messageKey/messageParams 是可选字段：有才下发，避免前端误判
	if entry.MessageKey != "" {
		data["messageKey"] = entry.MessageKey
	}
	if len(entry.MessageParams) > 0 {
		data["messageParams"] = entry.MessageParams
	}
	payload, _ := json.Marshal(map[string]any{
		"type": "log",
		"data": data,
	})
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, payload)
}

// writeDeployDone 推送任务结束消息
func writeDeployDone(conn *wssafe.Conn, status, errMsg string) {
	data, _ := json.Marshal(map[string]any{
		"type": "done",
		"data": map[string]any{
			"status": status,
			"error":  errMsg,
		},
	})
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, data)
}
