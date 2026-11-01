package terminal

// 运行中会话的指令队列（P-20261003-248）：agent 运行中想到的新指令先排队
//（会话行「排队指令」入口，单会话 ≤5 条），完成回执（task.progress done/failed，
// 复用 P-15 完成链的 opschannel 广播流）命中后依次写队首进 PTY（发送后弹出），
// 下一条等自己的回执——连续指令流不打断、不抢跑。
//
// 触发引擎复用 agentcron 完成回执监听同一数据面（launch.go addWatch/pollWatches
// 消费的 AgentTask 落库流），但走事件直驱（opschannel 观察者）而非分钟巡检：
// 排队发送要跟手，分钟级延迟不合用。回执链依赖智能体主动上报 task.progress
//（SC skill）；从未上报过的会话无从判定 busy，降级为「手动发送」注记（UI 提示 +
// 逐条立即发送按钮），服务端只存不发。
//
// 依次语义：每会话至多一条在途（inFlight，内存态）——队首写入后标记，其终态
// 回执到达才放行下一条。done/failed 都推进队列（与依赖链 always 档同语义：
// 「完成即触发」，失败轮次的后续指令交由智能体自纠/用户处置）。inFlight 不设
// 超时：智能体对某条指令不上报终态时队列停摆，逐条手动发送是兜底出口（同
// P-140 长会话提醒不依赖上报的分工——那是知情面，这是驱动面）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/mask"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// queueBusyState 会话 busy 判定结论（任务书拆解第 4 步）：由该会话最近一次
// task.progress 上报推导——
//   - running：上报运行中 → 排队等回执
//   - idle：上报过且非运行中（done/failed/未知态）→ 排队即发送（会话空闲）
//   - ""（缺失）：从未上报（纯 shell / 无 SC skill 运行时）→ 降级手动发送注记
type queueBusyState string

const (
	queueBusyRunning queueBusyState = "running"
	queueBusyIdle    queueBusyState = "idle"
	queueBusyMissing queueBusyState = ""
)

// QueueEntry 会话队列的 API 视图（GET 批量 / POST / PUT 响应共用）
type QueueEntry struct {
	SessionID string                  `json:"sessionId"`
	Items     []store.AgentQueuedItem `json:"items"`
	// Busy 当前会话是否上报运行中（回执驱动 UI 运行点/文案）
	Busy bool `json:"busy"`
	// AutoSend 完成回执是否可自动发送（false = 会话无 task.progress 数据，
	// 降级手动发送——前端据此渲染注记与手动按钮）
	AutoSend bool `json:"autoSend"`
}

// QueuesSnapshot GET /api/terminals/queues 响应（仅存有排队指令的在册会话）
type QueuesSnapshot struct {
	Queues []QueueEntry `json:"queues"`
}

// queueEngine 排队指令触发引擎：回执观察者 + 入队即时发送判定 + 在途标记。
// 状态量级 = 有队列的会话数（用户手工排队，个位数），全部 O(1)/O(队列数)
type queueEngine struct {
	mu       sync.Mutex
	inFlight map[string]bool // 会话 id → 队首已写入待其终态回执
	// sendMu 发送串行闸：sendHead 的「读队首→写 PTY→弹出」三段必须原子——
	// 回执观察者是每事件一 goroutine，同一会话两条回执近距到达时并发发送
	// 会双双读到同一队首（重复发送）+ 弹出错位；跨会话共享一把无妨（PTY 写
	// 本就该顺序化，「依次」语义的引擎级保证）
	sendMu sync.Mutex
	// writeFn 会话输入写入口（生产绑定 writeSessionInput，单测换桩）
	writeFn func(sessionID, text string) error
}

// defaultQueueEngine 包级装配：handler 与回执观察者经此取引擎（模块 Init
// 装配、Stop 摘除，与 agentcron 的 defaultRunner 同惯例——组合根单实例语义，
// 未装配时 handler 降级纯存取不触发发送）
var defaultQueueEngine *queueEngine

func setDefaultQueueEngine(e *queueEngine) { defaultQueueEngine = e }

func newQueueEngine() *queueEngine {
	return &queueEngine{inFlight: map[string]bool{}, writeFn: writeSessionInput}
}

// writeSessionInput 队首指令写入会话 PTY：尾部 \r = PTY Enter（与 agent
// launch 注入 / 广播输入同一惯例——不补换行则停留在输入行不执行）。
// 换行已在入库时折叠为空格（sanitizeInstruction），这里拼单行
func writeSessionInput(sessionID, text string) error {
	sess := terminal.DefaultManager.GetSession(sessionID)
	if sess == nil {
		return fmt.Errorf("session %s not found", sessionID)
	}
	return sess.WriteInput([]byte(text + "\r"))
}

// busyStateFor 会话 busy 判定（拆解第 4 步）：AgentTask 落库流（最新在前）
// 中找该会话最近一条 task.progress——running 态即 busy；终态/未知态即空闲；
// 无任何上报即缺失。归属匹配与 agentcron.findFinalStatus 同一规则
// （SessionID 形如 "terminalId" 或 "terminalId claudeSessionId"）。
// 扫描窗口 200 条（与 findFinalStatus 同量级）——回执是低频事件，单会话的
// 最近上报几乎必在窗口内；窗口外视为缺失，降级手动发送（安全侧）
func busyStateFor(sessionID string) queueBusyState {
	tasks, err := store.Get().AgentTask.List(200, "")
	if err != nil {
		return queueBusyMissing
	}
	for _, t := range tasks {
		if t.Type != "task.progress" {
			continue
		}
		if t.SessionID != sessionID && !strings.HasPrefix(t.SessionID, sessionID+" ") {
			continue
		}
		if t.Status == "running" {
			return queueBusyRunning
		}
		return queueBusyIdle
	}
	return queueBusyMissing
}

// enqueuePlan 入队处置判定（纯函数，回执触发单测锚点）：
//   - running：排队等回执（指令队列的本命场景——不打断运行中智能体）
//   - idle：入队即发送队首（会话空闲，等回执永不来）
//   - missing：只存不发（busy 无从判定，降级手动发送注记）
func enqueuePlan(busy queueBusyState) string {
	switch busy {
	case queueBusyRunning:
		return "wait"
	case queueBusyIdle:
		return "send"
	default:
		return "manual"
	}
}

// Enqueue 排队入尾并按 busy 判定处置：命中 send 即写队首进 PTY（发送后弹出）。
// 返回处置后的队列视图与是否已即时发送
func (e *queueEngine) Enqueue(sessionID, text string) (QueueEntry, bool, error) {
	busy := busyStateFor(sessionID)
	if _, err := store.Get().AgentQueue.Append(sessionID, text); err != nil {
		return QueueEntry{}, false, err
	}
	sent := false
	if enqueuePlan(busy) == "send" {
		sent = e.sendHead(sessionID, "idle-enqueue")
	}
	entry, _ := buildQueueEntry(sessionID)
	return entry, sent, nil
}

// OnReceipt 完成回执命中（拆解第 2 步）：清在途标记 → 本回执之后无更新的
// running 上报（新任务已起跑则继续等）→ 发送下一队首。done/failed 都推进。
// at 为回执事件时刻——不重读「最近一条上报」判 busy：观察者注册序在本包先于
// ai 模块落库观察者（模块 Init 序），回执可能尚未落库，读最新态会非确定性
// 误判 running；改判「本回执之后是否有 running」与落库时序无关。
// 经 opschannel 观察者异步调用（WriteInput 可能因 PTY 反压阻塞，不得拖住
// 智能体的上报请求路径）
func (e *queueEngine) OnReceipt(sessionID string, at time.Time) {
	e.mu.Lock()
	e.inFlight[sessionID] = false // 在途与否不改变推进条件——回执即「上一条已完」的事实源
	e.mu.Unlock()

	if hasRunningSince(sessionID, at) {
		return // 回执之后紧跟新 running 上报：新任务已起跑，队列继续等
	}
	e.sendHead(sessionID, "receipt")
}

// hasRunningSince 会话自 since 时刻起（含）是否有 running 上报（新任务起跑
// 判定）：AgentTask 落库流最新在前，找到本会话首条 task.progress 时——
// At ≥ since 且 running → 新任务在跑；更老的事件说明本回执之后无新 running。
// 本回执自身（done/failed）不计（非 running 态）
func hasRunningSince(sessionID string, since time.Time) bool {
	tasks, err := store.Get().AgentTask.List(200, "")
	if err != nil {
		return false
	}
	for _, t := range tasks {
		if t.Type != "task.progress" {
			continue
		}
		if t.SessionID != sessionID && !strings.HasPrefix(t.SessionID, sessionID+" ") {
			continue
		}
		return !t.At.Before(since) && t.Status == "running"
	}
	return false
}

// sendHead 写队首进会话并弹出（写失败不弹——指令不丢，留手动出口）。
// 命中即通知中心入账 + 审计（自动发输入是重要副作用，回看面必须有据）。
// 返回是否已发送
func (e *queueEngine) sendHead(sessionID, trigger string) bool {
	e.sendMu.Lock()
	defer e.sendMu.Unlock()
	s := store.Get()
	if s == nil {
		// store 已拆除（进程收尾/测试清理竞态）：写入面不可用，当未发送处理
		return false
	}
	q, err := s.AgentQueue.Get(sessionID)
	if err != nil || q == nil || len(q.Items) == 0 {
		return false
	}
	head := q.Items[0]
	if err := e.writeFn(sessionID, head.Text); err != nil {
		slog.Warn("agent queue send failed", "session", sessionID, "err", err)
		return false
	}
	if _, _, err := s.AgentQueue.PopHead(sessionID); err != nil {
		slog.Warn("agent queue pop failed", "session", sessionID, "err", err)
		return true // 已写入但弹出失败：宁重不丢（重复发送劣于静默吞指令）
	}
	e.mu.Lock()
	e.inFlight[sessionID] = true
	e.mu.Unlock()

	remain := len(q.Items) - 1
	s.Notification.Add(notification.Notification{
		Type:          "success",
		Category:      notification.CategoryTask,
		TitleKey:      "notify.queueSent.title",
		BodyKey:       "notify.queueSent.body",
		Title:         "排队指令已发送",
		Body:          summarizeInstruction(head.Text),
		MsgParams:     map[string]any{"text": summarizeInstruction(head.Text)},
		Action:        "terminal",
		ActionPayload: sessionID,
	})
	// 队列已变（P-20261003-248）：弹出发生在广播之前——前端收到即刷新，
	// 天然读到发送后的队列态（与 task.progress 前端刷新赛跑是实测踩过的坑）。
	// 直通型事件，消费方 = OpsChannelBridge → agentQueue store
	// （P-20261006-46 起引用 opschannel 常量：服务端广播点禁裸串，
	// archguard ops-events 对账把裸串当硬失败）
	opschannel.BroadcastEvent(opschannel.EventQueueChanged, gin.H{
		"sessionId": sessionID,
		"remaining": remain,
	})
	// 审计摘要过 mask（指令是自由文本，可能带密钥原文；只留前段可读性）。
	// 队首发送由回执驱动（后台路径无 *gin.Context），走裸 Append 口
	// Rid 留零值——双口口径见 middleware.AuditAppend 注释（P-20261006-53）
	s.Audit.Append(store.AuditEvent{
		Time:   time.Now(),
		Action: store.AuditTerminalQueueSend,
		// 结果走三值契约常量（原 "ok" 不在 success/failure/denied 之列，
		// 前端结果列 t(`audit.result.${r}`) 无键可显——存量 "ok" 事件不受影响，
		// 新事件起对齐；P-20261004-144 收编）
		Result: store.AuditResultSuccess,
		Detail: fmt.Sprintf("session=%s trigger=%s remain=%d text=%s",
			sessionID, trigger, remain, mask.MaskApprovalText(summarizeInstruction(head.Text))),
	})
	return true
}

// summarizeInstruction 通知/审计摘要：首行语义已在入库时保证（控制字符折叠），
// 这里只截长度（rune 计，与 promptSessionName 同款展示位取向）
func summarizeInstruction(text string) string {
	const max = 80
	r := []rune(text)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return text
}

// forget 会话出清（关闭清账路径）：在途标记移除；队列文档由调用方删除
func (e *queueEngine) forget(sessionID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.inFlight, sessionID)
}

// QueueReceiptObserver 完成回执观察者（模块 Init 注册）：只消费带 terminalId
// 的 task.progress 终态上报（done/failed），派发引擎推进队列。观察者是追加式
// 单点（ai 模块落库观察者同流多消费），本观察者自身无状态、异步派发不阻塞
// 广播路径
func QueueReceiptObserver() func(opschannel.Event) {
	return func(ev opschannel.Event) {
		if ev.Type != "task.progress" {
			return
		}
		var p struct {
			Status     string `json:"status"`
			TerminalID string `json:"terminalId"`
		}
		b, err := json.Marshal(ev.Payload)
		if err != nil {
			return
		}
		if err := json.Unmarshal(b, &p); err != nil || p.TerminalID == "" {
			return
		}
		if p.Status != "done" && p.Status != "failed" {
			return
		}
		e := defaultQueueEngine
		if e == nil {
			return
		}
		// 回执时刻：广播 TS（ms）；TS 缺失（历史消费方直调）退当前时刻。
		// 落库 At 与 TS 同刻生成，时序判定以 TS 为准
		at := time.Now()
		if ev.TS > 0 {
			at = time.UnixMilli(ev.TS)
		}
		go e.OnReceipt(p.TerminalID, at)
	}
}

// buildQueueEntry 会话队列视图组装（busy 判定附带 autoSend 结论）
func buildQueueEntry(sessionID string) (QueueEntry, error) {
	busy := busyStateFor(sessionID)
	q, err := store.Get().AgentQueue.Get(sessionID)
	if err != nil {
		return QueueEntry{}, err
	}
	items := []store.AgentQueuedItem{}
	if q != nil {
		items = q.Items
	}
	return QueueEntry{
		SessionID: sessionID,
		Items:     items,
		Busy:      busy == queueBusyRunning,
		AutoSend:  busy != queueBusyMissing,
	}, nil
}

// ── HTTP handlers ──

// sessionOrNotFound 队列端点的会话在册校验：会话不存在（已关闭/拼错 id）
// 一律 404——对不存在的东西排队只会在关闭清账时静默蒸发，早失败优于假成功
func sessionOrNotFound(c *gin.Context) (string, bool) {
	id := c.Param("id")
	if terminal.DefaultManager.GetSession(id) == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return "", false
	}
	return id, true
}

// GetTerminalQueues GET /api/terminals/queues（静态段，先于 :id 动态段登记）：
// 全量排队指令批量读（侧栏徽标 + 面板单一取数口，免逐会话 N+1）。只回存有
// 排队指令的在册会话——空队列无 UI 语义，缺席即空
func GetTerminalQueues(c *gin.Context) {
	list, err := store.Get().AgentQueue.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	snap := QueuesSnapshot{Queues: []QueueEntry{}}
	for _, q := range list {
		if len(q.Items) == 0 {
			continue
		}
		if terminal.DefaultManager.GetSession(q.SessionID) == nil {
			continue // 幽灵队列（异常退出未清账）：不呈现，等会话重建同 id 复用
		}
		if entry, err := buildQueueEntry(q.SessionID); err == nil {
			snap.Queues = append(snap.Queues, entry)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": snap})
}

// EnqueueTerminalQueue POST /api/terminals/:id/queue {"text":"..."}：
// 排队入尾 + busy 判定处置（running 等 / idle 即发 / missing 降级只存）。
// 429 上限（≤5）、400 空或超长——稳定标记原文即前端 KNOWN_ERROR_I18N 契约
func EnqueueTerminalQueue(c *gin.Context) {
	id, ok := sessionOrNotFound(c)
	if !ok {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	e := defaultQueueEngine
	if e == nil {
		// 引擎未装配（异常态）：退化为纯存储，仍接受排队（不静默拒绝用户输入）
		q, err := store.Get().AgentQueue.Append(id, req.Text)
		if err != nil {
			respondQueueError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": QueueEntry{SessionID: id, Items: q.Items, AutoSend: false}})
		return
	}
	entry, sent, err := e.Enqueue(id, req.Text)
	if err != nil {
		respondQueueError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": entry, "sent": sent})
}

// ReplaceTerminalQueue PUT /api/terminals/:id/queue {"items":["..."]}：
// 整表替换（会话行面板的编辑/删除/重排共用单一写口，纯存储不触发发送——
// 改队列是计划整理，发送只由入队与回执驱动）
func ReplaceTerminalQueue(c *gin.Context) {
	id, ok := sessionOrNotFound(c)
	if !ok {
		return
	}
	var req struct {
		Items []string `json:"items"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	q, err := store.Get().AgentQueue.Replace(id, req.Items)
	if err != nil {
		respondQueueError(c, err)
		return
	}
	items := []store.AgentQueuedItem{}
	if q != nil {
		items = q.Items
	}
	c.JSON(http.StatusOK, gin.H{"data": QueueEntry{SessionID: id, Items: items}})
}

// respondQueueError 排队校验错误映射：满队 409（状态可重试的冲突语义）、
// 非法指令 400；错误原文是稳定标记（store.ErrQueue* 中文段即契约）。
// P-20261005-160 起附结构化 code：agent 自纠=满队等消费/取走队列再入队、
// 非法指令精简后重发；错误原文 publicMsg 保留（前端正则过渡层零破坏）
func respondQueueError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrQueueFull):
		shared.ErrorWithCode(c, shared.CodeTerminalQueueFull, err.Error(), nil)
	case errors.Is(err, store.ErrQueueInvalid):
		shared.ErrorWithCode(c, shared.CodeTerminalQueueInvalid, err.Error(), nil)
	default:
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
	}
}

// deleteSessionQueue 会话关闭清账挂点（CloseTerminal 调用）：队列随会话消亡
// （tmux 恢复重建同 id 会话不受影响——文档按会话 id 键控，不按进程生命周期）
func deleteSessionQueue(id string) {
	if err := store.Get().AgentQueue.Delete(id); err != nil {
		slog.Warn("agent queue cleanup failed", "id", id, "err", err)
	}
	if e := defaultQueueEngine; e != nil {
		e.forget(id)
	}
}
