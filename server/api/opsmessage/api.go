package opsmessage

// 会话间定向消息 HTTP 面（P-20261004-68）。路由（router.go 注册，组中间件
// LockMiddleware + TokenAuthMiddleware + AgentGuard 同 ops-notify 鉴权面——
// agent 令牌可调，非高危不进 AgentGuard）：
//
//	POST /api/ops-message  投递定向消息 {to: 目标会话 ID, body ≤2KB}
//	                       （发送方 = X-Session-ID 头，CC_TERMINAL_ID 同一命名空间）
//	GET  /api/ops-message  本会话收件箱（X-Session-ID 头定位；拉取即读 drain 语义）
//
// 事件：投递成功广播 terminal.message（载荷 from/to/摘要，不含全文），目标会话
// 的 tab 未读徽标 + 通知中心弱条目由此驱动；收件箱被拉取后广播
// terminal.message.read，前端徽标随之清除。与项目笔记分工：定向瞬态用消息、
// 共享持久用笔记（见手册 agent-message 节）。

import (
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/metrics"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

const (
	// bodyMax 正文 UTF-8 字节上限（提案口径 ≤2KB；ops-ask question 同量级）
	bodyMax = 2048
	// sessionIDMax 会话 ID 长度上限（agent-<unixnano> / tmux 名形态，设上界
	// 防畸形长串；agentchain sourceIDMax 同值）
	sessionIDMax = 128
	// summaryMax 广播摘要长度上限（rune）：载荷只带首行速览供监听方快速分诊，
	// 全文走 GET 收件箱面
	summaryMax = 80
)

// opsMessageRateLimit / opsMessageWindow 投递频率限制：复用 ops-notify 的
// 会话维度限流惯例（60 条/分钟，middleware.RateLimiter 同源）——消息风暴
// （agent 侧 bug 死循环投递）只烧发送方自己的预算。超限静默丢弃 + 200 同响应
// （错误响应会诱发重试放大风暴）+ system:rate-limited 回告，与 ops-notify
// 同一纪律
const (
	opsMessageRateLimit = 60
	opsMessageWindow    = time.Minute
)

var opsMessageLimiter = middleware.NewRateLimiter(opsMessageRateLimit, opsMessageWindow)

// opsMessageFeedbackGate 回告节流闸门：每维度每窗口仅放行 1 条超限回告事件，
// 防回告自身变成新的广播源（ops-notify opsNotifyFeedbackGate 同款）
var opsMessageFeedbackGate = middleware.NewRateLimiter(1, opsMessageWindow)

// sessionAlive 目标会话在册判定（生产绑定 terminal.DefaultManager.GetSession
// != nil——tmux/native 双后端同语义；变量化供单测换桩，agentchain defaultAliveFn
// 同款形态）
var sessionAlive = func(sessionID string) bool {
	return terminal.DefaultManager.GetSession(sessionID) != nil
}

// SendMessage POST /api/ops-message
// body: { to: 目标会话 ID（CC_TERMINAL_ID 同一命名空间）, body: 消息正文 ≤2KB }
// 发送方取 X-Session-ID 头（手册约定 agent 全量携带，CC_TERMINAL_ID 注入值的
// 同款；ops-notify 限流维度同源）——定向消息必须有发送方地址，接收方才知道
// 找谁核对；缺头 400 明确退回而非猜测归属。
func SendMessage(c *gin.Context) {
	var req struct {
		To   string `json:"to" binding:"required"`
		Body string `json:"body" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeOpsMessagePayloadInvalid, "ops message failed", err)
		return
	}
	from := strings.TrimSpace(c.GetHeader("X-Session-ID"))
	if from == "" || len(from) > sessionIDMax {
		shared.ErrorWithCode(c, shared.CodeOpsMessagePayloadInvalid,
			"X-Session-ID header is required (sender session id, max 128 chars)", nil)
		return
	}
	to := strings.TrimSpace(req.To)
	if to == "" || len(to) > sessionIDMax {
		shared.ErrorWithCode(c, shared.CodeOpsMessagePayloadInvalid,
			"to is required (target session id, max 128 chars)", nil)
		return
	}
	body := strings.TrimSpace(req.Body)
	if !utf8.ValidString(body) || body == "" || len(body) > bodyMax {
		shared.ErrorWithCode(c, shared.CodeOpsMessagePayloadInvalid,
			"body is required (1-2048 bytes)", nil)
		return
	}
	// 目标会话在册校验：指向不存在会话的消息是打错地址（会话 ID 随手抄错/
	// 目标已关闭），404 明确退回优于静默落一条永无人读的死信
	if !sessionAlive(to) {
		shared.ErrorWithCode(c, shared.CodeOpsMessageTargetNotFound, "target session not found", nil)
		return
	}
	// 频率限制在载荷校验与目标校验之后：400/404 的坏请求不占用投递预算
	if count := opsMessageLimiter.Hit("sid:" + from); count > opsMessageRateLimit {
		metrics.IncCounter("sc_ops_message_limited_total")
		if opsMessageFeedbackGate.Hit("sid:"+from) == 1 {
			notifyMessageLimited(from, count)
		}
		c.JSON(http.StatusOK, gin.H{"message": "message delivered"})
		return
	}

	now := time.Now()
	in, err := store.Get().Inbox.Append(to, from, body, now)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops message failed", err)
		return
	}
	auditMessageSend(c, from, to, len(body))
	notifyMessageArrived(from, to)
	// terminal.message 直通分发型广播：摘要进载荷（首行速览），全文只在
	// 收件箱 GET 面——监听方（agent 脚本/自动化）据此决定是否拉取
	opschannel.BroadcastEvent(opschannel.EventTerminalMessage, map[string]any{
		"from":    from,
		"to":      to,
		"summary": MessageSummary(body),
		"at":      now.UnixMilli(),
	})
	c.JSON(http.StatusOK, gin.H{
		"message": "message delivered",
		"data":    gin.H{"to": to, "pending": len(in.Messages)},
	})
}

// GetInbox GET /api/ops-message —— 本会话收件箱（拉取即读）。
// 每次调用返回自上次拉取以来的全部新留言（投递序）并就地标记已读：再次拉取
// 返回空，agent 无需自记游标。拉取到留言时广播 terminal.message.read，
// 前端未读徽标随之清除（「读取后徽标消」的唯一感知通道——GET 是 agent 侧
// 动作，前端自己不轮询收件箱，避免与 agent 的拉取互抢）。
func GetInbox(c *gin.Context) {
	sessionID := strings.TrimSpace(c.GetHeader("X-Session-ID"))
	if sessionID == "" || len(sessionID) > sessionIDMax {
		shared.ErrorWithCode(c, shared.CodeOpsMessagePayloadInvalid,
			"X-Session-ID header is required (own session id, max 128 chars)", nil)
		return
	}
	messages, err := store.Get().Inbox.Take(sessionID, time.Now())
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops message failed", err)
		return
	}
	if len(messages) > 0 {
		opschannel.BroadcastEvent(opschannel.EventTerminalMessageRead, map[string]any{
			"sessionId": sessionID,
			"count":     len(messages),
		})
	}
	if messages == nil {
		messages = make([]store.InboxMessage, 0)
	}
	c.JSON(http.StatusOK, gin.H{"data": messages})
}

// MessageSummary 广播摘要：首行 + rune 截断（摘要只供速览分诊，全文走
// 收件箱面；按 rune 切防腰斩代理对）。包级导出供单测锁定形态
func MessageSummary(body string) string {
	firstLine := body
	if i := strings.IndexAny(body, "\r\n"); i >= 0 {
		firstLine = body[:i]
	}
	runes := []rune(firstLine)
	if len(runes) > summaryMax {
		return string(runes[:summaryMax]) + "…"
	}
	return firstLine
}

// ── 通知与审计（仅元数据；正文不上任何旁路面——收件箱 GET 是唯一全文出口）──

// notifyMessageArrived 通知中心弱条目：「会话 A → 会话 B 留言」，点击直达
// 目标会话（P-31 terminal action 惯例）。正文不入通知（持久层，敏感面从紧），
// 内容经目标会话内的 agent 消费，人看「谁给谁留言了」即可
func notifyMessageArrived(from, to string) {
	fromName, toName := sessionName(from), sessionName(to)
	store.Get().Notification.Add(notification.Notification{
		Type:     "info",
		Category: notification.CategoryTask,
		TitleKey: "opsmessage.notify.title",
		BodyKey:  "opsmessage.notify.body",
		Title:    "会话留言",
		Body:     fmt.Sprintf("%s → %s", fromName, toName),
		MsgParams: map[string]any{
			"from": fromName,
			"to":   toName,
		},
		Action:        "terminal",
		ActionPayload: to,
	})
}

// auditMessageSend 投递审计：from/to/字节数元数据（正文与摘要绝不入账——
// 消息与 ask/notify 同级敏感面）。携 gin context 走 AuditAppend 中央口，
// rid 随请求注入（P-20261006-53）
func auditMessageSend(c *gin.Context, from, to string, bodyLen int) {
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditOpsMessageSend,
		Result: store.AuditResultSuccess,
		Detail: fmt.Sprintf("from=%s to=%s bytes=%d", from, to, bodyLen),
	})
}

// system:rate-limited 回告载荷已收编为 opschannel.RateLimitedNotice（唯一事实
// 源，ops-notify/搜索限流同源），此处直接引用

// notifyMessageLimited 投递限流回告（经 opsMessageFeedbackGate 节流后调用）：
// 告知触限方限流参数与当前窗口已丢弃条数，守规矩的 agent 感知自纠
// （ops-notify 同纪律——超限仍 200 同响应，不诱发重试风暴）
func notifyMessageLimited(from string, count int) {
	opschannel.BroadcastEvent(opschannel.EventRateLimited, opschannel.RateLimitedNotice{
		Dimension: "session",
		Key:       from,
		Dropped:   count - opsMessageRateLimit,
		Limit:     opsMessageRateLimit,
		WindowSec: int(opsMessageWindow / time.Second),
	})
}

// sessionName 会话显示名（元数据缺失降级会话 ID——通知文案不谎称；
// agentchain sourceSessionName 同款）
func sessionName(sessionID string) string {
	if meta, err := store.Get().AgentSession.Get(sessionID); err == nil && meta != nil && meta.Name != "" {
		return meta.Name
	}
	return sessionID
}
