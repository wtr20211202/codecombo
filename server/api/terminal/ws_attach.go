package terminal

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/terminal"
	"codecombo/server/wssafe"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// 终端 WS attach 与 scrollback 重放（P-20261007-22 纯搬运自 terminal.go，
// 零逻辑改动）：HandleTerminalWS 的升级/断档 G 帧/重放/R 哨兵/输出泵全链，
// 分帧重放（P-20261007-3）原语 sendScrollbackReplay 与 REST 查询面
// GetTerminalScrollback 同文件就近

// 重放分帧参数（P-20261007-3）：≤256KB 保持单帧（绝大多数会话，帧形态与
// 原实现完全一致）；超过则按 128KB 分帧流式发送。动机：scrollback 可配
// 20 万行≈16MB，5Mbps 弱网传 25s，单帧 5s deadline 必超时 → 断开 → 重连
// → 再全量 → 恶性循环，大缓冲弱网重连结构性必败；分帧后每块独立续期
// deadline，弱网只是慢、不再断。块边界任意切字节流安全（PTY 流式输出
// 从来任意分帧，xterm 跨帧流式解析既定行为）
const (
	replaySingleFrameMax = 256 << 10 // 256KB：单帧/分帧分界
	replayChunkBytes     = 128 << 10 // 128KB：分帧块大小（5Mbps 下约 0.2s/块）
)

// replayChunkDeadline 单块写 deadline。每块发送前续期：单块 128KB 远快于
// 5s 即便弱网，总量再大也不会累积超时（原实现是整份重放共用一个 5s）。
// var 仅为测试可注入短 deadline 钉住「块级续期」语义（TestReplayDeadlineRenewalPipe）
var replayChunkDeadline = 5 * time.Second

// 服务端只读闸 WS 拒绝帧（P-20261008-17）：终端 WS 的 PTY 输出恒为
// BinaryMessage，TextMessage 整类保留给服务端控制帧（JSON）——本帧是第一形态
// {type:"input_rejected", code:"readonly_external"}。code 是对 agent 的稳定
// 错误码契约（前端 useTerminalSession 同名常量对账，e2e 断言钉死），不在
// errmarkers 注册表登记：该表的守卫链（KNOWN_ERROR_I18N 正则对账）只覆盖
// HTTP 错误响应体，WS 帧不经那条管线，登记反而要求一条永不命中的 HTTP 映射。
// 连接不关：输出流与解锁后的写入都要继续走同一条连接
const wsInputRejectFrame = `{"type":"input_rejected","code":"readonly_external"}`

// wsRejectCoalesceMs 拒绝帧防抖窗口：同连接 1s 一帧（agent 灌输入时拒绝帧与
// 输入 1:1 无放大，但前端 toast 不必逐键刷）
const wsRejectCoalesceMs = int64(1000)

// replaySource 重放数据源最小面：next 拷贝下一段到 p，耗尽返回 io.EOF。
// 两个实现：snapshotSource（tmux capture-pane 整体快照，已是独立 []byte）与
// *terminal.ScrollbackReader（native 环形缓冲分段读取，方法签名天然吻合）
type replaySource interface {
	Next(p []byte) (int, error)
}

// snapshotSource 整体快照适配
type snapshotSource struct{ data []byte }

func (s *snapshotSource) Next(p []byte) (int, error) {
	if len(s.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, s.data)
	s.data = s.data[n:]
	return n, nil
}

// sendScrollbackReplay 把重放载荷写往 WS 连接：≤256KB 读齐后单帧一次写出
// （与原实现帧形态一致）；更大则按 128KB 分帧循环，每块发送前 SetWriteDeadline
// 续期。任一块写失败（对端断开/停滞超时）立即返回错误终止重放——不为已死
// 连接继续灌剩余块；原生块级 deadline 下对端停滞最多拖 5s 即失败退出
func sendScrollbackReplay(conn *wssafe.Conn, oneShot []byte, reader *terminal.ScrollbackReader) error {
	var src replaySource
	size := 0
	if reader != nil {
		src, size = reader, reader.Len()
	} else {
		src, size = &snapshotSource{oneShot}, len(oneShot)
	}
	if size == 0 {
		return nil
	}

	if size <= replaySingleFrameMax {
		// 单帧：读齐后一次写出。reader 路径实际可读可能略小于 Len（窗口前缀
		// 被并发写入覆盖，Next 提前 EOF）——按实读量写出
		buf := make([]byte, size)
		filled := 0
		for filled < size {
			n, err := src.Next(buf[filled:])
			filled += n
			if err != nil {
				break
			}
		}
		_ = conn.SetWriteDeadline(time.Now().Add(replayChunkDeadline))
		return conn.WriteMessage(websocket.BinaryMessage, buf[:filled])
	}

	// 分帧流式：128KB 一块，块级 deadline 续期；写失败即退出（连接已断/
	// 停滞，优先止损）
	started := time.Now()
	chunk := make([]byte, replayChunkBytes)
	frames, total := 0, 0
	for {
		n, err := src.Next(chunk)
		if n > 0 {
			_ = conn.SetWriteDeadline(time.Now().Add(replayChunkDeadline))
			if werr := conn.WriteMessage(websocket.BinaryMessage, chunk[:n]); werr != nil {
				return werr
			}
			frames++
			total += n
		}
		if err != nil {
			break // io.EOF 正常耗尽；其他读错误同样终止（数据源异常不再续块）
		}
	}
	// 观测日志：仅分帧路径记录（单帧是常态不值得一条日志/会话）——
	// 线上排查「重连慢」时以此定位大缓冲会话
	slog.Info("terminal: scrollback replay streamed in frames",
		"bytes", total, "frames", frames, "elapsed", time.Since(started).Round(time.Millisecond))
	return nil
}

// HandleTerminalWS 终端 WebSocket 连接
func HandleTerminalWS(c *gin.Context) {
	id := c.Param("id")
	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}

	// 交互客户端附着登记（P-20261003-192）：空闲超时分离以「无人附着」为
	// 判据之一，在用会话绝不动。升级失败也走 defer 摘除，计数自平衡
	session.AttachClient()
	defer session.DetachClient()

	// 确保底层会话已 attach（tmux 模式下可能需要 Reattach）
	// 在 WS 升级前调用，便于直接返回 HTTP 错误
	if err := session.EnsureAttached(); err != nil {
		shared.Error(c, http.StatusServiceUnavailable, "session attach failed: "+err.Error(), nil)
		return
	}

	rawConn, err := shared.WSUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		return
	}
	// 输入帧上限防线（P-20261003-313）：超限帧对端收到 1009，读侧得 ErrReadLimit
	rawConn.SetReadLimit(shared.WSReadLimitInput)
	// 并发写串行化（A9 同款修复）：ping 心跳与 PTY 输出转发是两个 goroutine，
	// 直接写裸 conn 会触发 gorilla "concurrent write" panic——
	// 且 panic 发生在 ping goroutine，gin Recovery 捕获不到，会崩溃整个进程
	conn := wssafe.New(rawConn)
	defer conn.Close()

	// 终端 WS 故意不注册 lock closer：锁定/解锁仅是 UI 状态，
	// 后台 shell 继续输出，避免长任务（编译/构建）因 UI 锁定而被打断。
	// 安全侧靠 HTTP LockMiddleware 保证：锁定时新 API 请求仍被 423 拒绝。
	// 其他 WS（projects/notifications/clone）仍走 RegisterWSConn 维持原行为。

	// 读写超时 + pong handler 续期
	const readDeadline = 60 * time.Second
	_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	// 定期发送 ping（wssafe 内部串行化 + 写超时兜底）
	defer conn.StartPing()()

	// 断档元信息（P-20261005-233）：重放字节之前先发 G 帧（OSC 133;G，服务端
	// 注入非 shell 产出）——现存缓冲最早行时间 + 服务端当前时刻（后者供前端
	// 校准两端时钟差，跨机部署的时钟偏差会把「无淘汰」误判成缺口）。前端与
	// 「断开前最后收到的输出时刻」比对，判得淘汰缺口即在重放内容之前插入标记
	// 行（缺口处=重放起点，故必须在重放字节之前）。tmux 后端 capture-pane 无
	// 逐行时间语义不发（前端无比对依据即零标记=完整性未知诚实呈现）
	if !session.IsPersistent() {
		if earliest, ok := session.EarliestAvailableAt(); ok {
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			gapFrame := fmt.Sprintf("\x1b]133;G;%d;%d\x07", earliest.UnixMilli(), time.Now().UnixMilli())
			if err := conn.WriteMessage(websocket.BinaryMessage, []byte(gapFrame)); err != nil {
				return
			}
		}
	}

	// 重放 scrollback 历史：
	// tmux（持久化）→ 只取可视区上方历史行，当前可视屏随后由 refresh-client
	//   以完整终端状态重绘——若把 capture-pane 的线性转储当可视屏写入全新 xterm，
	//   tmux attach 客户端后续的增量更新（相对光标定位）会全部错位，显示「全乱」
	// native → 完整字节环形缓冲（无重绘能力，语义与历史行为一致），
	//   经 ScrollbackReader 分段读取避免 ring→flat 整体复制（P-20261007-3）
	// maxLines=0 返回全部，由前端 xterm.scrollback 接管显示截断
	// 载荷 ≤256KB 单帧、更大分帧流式（见 sendScrollbackReplay）——R 哨兵
	// 仍在全部块之后发送，重放/活命令门禁不变
	var replay []byte
	var replayReader *terminal.ScrollbackReader
	if session.IsPersistent() {
		replay, _ = session.CaptureHistory(0)
	} else {
		replayReader = session.SnapshotReader(0)
	}
	if err := sendScrollbackReplay(conn, replay, replayReader); err != nil {
		return
	}

	// 重放边界哨兵（OSC 133;R）：附着/重连的缓冲重放到此为止，其后的 133;D 才是
	// 「活」命令结束。重放的 D 含上一条命令的完整记账信息（命令文本/退出码/时长），
	// 前端若不区分，每次 pane 重挂载/重连都会把历史重复上报（实测同一命令被记 5 条）。
	// 无重放（新会话）也发：前端以「见到 R」为历史上报门禁的开启条件。
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b]133;R\x07")); err != nil {
		return
	}

	// 注册输出回调（OnOutput 返回 unregister，WS 断开时必须调用以避免回调泄漏）
	// 同步阻塞写入 channel：WS 慢时 handler 阻塞 → readLoop 阻塞 → PTY 缓冲区满
	// → shell stdout 自然反压，避免大流量下丢字节导致 xterm 显示错乱
	outputChan := make(chan []byte, 256)
	// streamDone：主循环退出即 close，解除 handler 的反背压等待——
	// WS hijack 后 request ctx 在客户端断开时不再触发 Done，若仅靠 ctx 兜底，
	// 客户端断开且 outputChan 满时 handler 会永久阻塞 → readLoop 卡死 → 泄漏
	// （与 /ws/remote-terminal 的 778061b 修复同构）
	streamDone := make(chan struct{})
	defer close(streamDone)
	handler := func(data []byte) {
		select {
		case outputChan <- data:
		case <-streamDone:
			// 主循环已退出：丢弃本块数据立即返回，让 readLoop 恢复
		}
	}
	unregister := session.OnOutput(handler)
	defer unregister()

	// 输出回调已注册，强制 tmux 重绘当前可视屏（完整状态：内容+光标+备屏），
	// 把 attach 客户端的精确终端状态同步给重连后的全新 xterm。
	// 必须在 OnOutput 之后调用：重绘序列经 readLoop → 回调 → WS 到达前端
	session.RedrawClient()

	// 读取 WebSocket 输入 -> PTY
	// clientGone：读 goroutine 退出（客户端断开/读错）即 close，唤醒主循环 return——
	// hijack 后 ctx 永不触发 Done，远端无输出时主循环若仅靠 outputChan 驱动会永久阻塞
	// （与 /ws/remote-terminal 的 97e4511 修复同构）
	clientGone := make(chan struct{})
	go func() {
		defer close(clientGone)
		// 服务端只读闸拒绝帧防抖：同连接 1s 窗口内只回一帧（agent 令牌向锁定
		// 会话灌输入时拒绝帧与输入 1:1 无放大，但人盯着的前端 toast 不必逐键刷）
		lastRejectAt := int64(0)
		for {
			_, msg, err := rawConn.ReadMessage()
			if err != nil {
				shared.WarnIfReadLimitExceeded(err, "terminal")
				return
			}
			// 服务端只读闸（P-20261008-17）：接管会话默认只读的前端锁服务端镜像。
			// 双条件按提案语义保持（external 且闸开）——标记只会在接管会话上置位，
			// origin 复核是纵深防御。拒绝不发关闭（连接保留：输出流/后续解锁都
			// 不断），回一帧 TextMessage 稳定标记帧供 agent 可编程感知；广播写/
			// 排队指令/运行书等批量运维面不经此循环（各端点自带 AgentGuard 审批，
			// P-189 批注③分层），不受本闸。
			// 直通输入持权闸（P-20261024-1）：访客持权期间 owner 侧输入一律
			// 拒（单持有者语义的强制面——与 external 条件正交叠加，会话形态
			// 不限：agent 会话被授予直通时 owner 键盘让位），收回/超时即解除
			if (session.Origin == terminal.OriginExternal && session.ServerReadOnly()) || session.DirectInputHeld() {
				if now := time.Now().UnixMilli(); now-lastRejectAt >= wsRejectCoalesceMs {
					lastRejectAt = now
					_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
					_ = conn.WriteMessage(websocket.TextMessage, []byte(wsInputRejectFrame))
				}
				continue
			}
			if err := session.WriteInput(msg); err != nil {
				return
			}
		}
	}()

	// PTY 输出 -> WebSocket
	// 合帧（P-20261004-26）：首块到达开 8ms flush 窗口（+128KB 字节上限双门限），
	// 窗口内排空 outputChan 拼成单帧一次写出——高输出场景逐块成帧每秒数千帧的
	// 系统调用/deadline 刷新/对端唤醒开销收敛 90%+；反压语义不变（chan 满 →
	// handler 阻塞 → readLoop 阻塞 → PTY 内核缓冲），合帧只是加快排空
	agg := shared.NewWSOutputAggregator()
	for {
		select {
		case data := <-outputChan:
			frame, ok := agg.Collect(data, outputChan, clientGone)
			if !ok {
				// 窗口期内客户端断开：与 clientGone 分支同语义退出
				return
			}
			// 每次写都显式刷新 write deadline：deadline 是连接级持久状态，
			// 若不在此刷新，ping 间隔中后半段所有数据写都会因 deadline exceeded 失败
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
		case <-clientGone:
			// 客户端已断开：退出主循环（defer 释放回调与 streamDone）
			return
		}
	}
}

// GetTerminalScrollback GET /api/terminals/:id/scrollback
// 返回终端 scrollback 历史，供前端「刷新内容」按钮调用
// tmux 后端：capture-pane 输出；native 后端：内部缓存的 PTY 输出
// maxLines=0 表示返回全部缓冲内容，由前端 xterm.scrollback 接管显示截断
// 响应头 X-Earliest-Available-At（P-20261005-233）：现存缓冲最早行时间（unix
// 毫秒）——裸字节响应契约不变、元信息走响应头（旧前端/既有消费方零感知），
// agent 读输出时可编程验完整性（巡检取证据前先验有无缺口）。tmux/空缓冲无
// 此头=完整性未知
func GetTerminalScrollback(c *gin.Context) {
	id := c.Param("id")
	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	if earliest, ok := session.EarliestAvailableAt(); ok {
		c.Header("X-Earliest-Available-At", strconv.FormatInt(earliest.UnixMilli(), 10))
	}
	data, err := session.CaptureScrollback(0)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	c.Data(http.StatusOK, "application/octet-stream", data)
}
