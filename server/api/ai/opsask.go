package ai

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 智能体结构化提问（P-20261001-27） ==============
// Agent 长任务中需要用户输入（方案选择/缺环境变量值等）时经本组端点追问：
//   1. POST /api/ops-ask             —— Agent 发起（问题 + 可选 options +
//      归属 terminalId，广播 input.request，前端全局提问卡片即时呈现）
//   2. POST /api/ops-ask/:id/answer  —— 用户作答（自由文本或选项原文）
//   3. GET  /api/ops-ask/:id         —— Agent 轮询取答案（pending/answered/
//      expired；未答问题到 AskTTL 自动过期）
// 与 ops-confirm（可/否二元裁决）共同构成 agent↔用户 双向通道。
// 约定：不引入 [[ASK_DONE]] 类回复标记——轮询语义已足够（见能力手册）。

// askLimits 字段长度约束（问题/答案走明文存储，约束即敏感面上限）。
// askBodyMaxBytes 请求体总限与 ops-notify 尺寸墙同款（P-20261004-130）：
// 字段上限（question 2048 / answer 4096）之下 64KB 充裕，封顶只为把畸形
// 巨型请求体挡在解析期（与广播面 input.request 的 marshal 放大同防）
const (
	askQuestionMaxLen = 2048
	askAnswerMaxLen   = 4096
	askTerminalMaxLen = 128
	askOptionMaxLen   = 256
	askOptionsMax     = 10
	askBodyMaxBytes   = 64 * 1024
)

// CreateAgentAsk Agent 发起提问
func CreateAgentAsk(c *gin.Context) {
	shared.LimitBody(c, askBodyMaxBytes)
	var req struct {
		TerminalID string   `json:"terminalId"`
		Question   string   `json:"question" binding:"required"`
		Options    []string `json:"options"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "ops ask request too large",
				fmt.Errorf("request body exceeds %d bytes", askBodyMaxBytes))
			return
		}
		shared.Error(c, http.StatusBadRequest, "ops ask failed", err)
		return
	}
	req.Question = strings.TrimSpace(req.Question)
	if req.Question == "" || len(req.Question) > askQuestionMaxLen {
		shared.Error(c, http.StatusBadRequest, "invalid question (1-2048 chars)", nil)
		return
	}
	terminalID := strings.TrimSpace(req.TerminalID)
	if len(terminalID) > askTerminalMaxLen {
		shared.Error(c, http.StatusBadRequest, "field too long", nil)
		return
	}
	options := make([]string, 0, len(req.Options))
	for _, o := range req.Options {
		o = strings.TrimSpace(o)
		if o == "" || len(o) > askOptionMaxLen {
			shared.Error(c, http.StatusBadRequest, "invalid option (1-256 chars)", nil)
			return
		}
		options = append(options, o)
	}
	if len(options) > askOptionsMax {
		shared.Error(c, http.StatusBadRequest, "too many options (max 10)", nil)
		return
	}
	now := time.Now()
	ask := store.AgentAsk{
		ID:         store.NewAgentAskID(),
		TerminalID: terminalID,
		Agent:      store.RuntimeForSession(terminalID),
		Question:   req.Question,
		Options:    options,
		Status:     store.AskPending,
		CreatedAt:  now,
		ExpiresAt:  now.Add(store.AskTTL),
	}
	if err := store.Get().AgentAsk.Save(ask); err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops ask failed", err)
		return
	}
	opschannel.BroadcastEvent(opschannel.EventInputRequest, ask)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": ask.ID, "status": ask.Status, "expiresAt": ask.ExpiresAt}})
}

// GetAgentAsk Agent 轮询提问状态/答案。
// 超时语义：pending 且已过 ExpiresAt → 惰性翻转为 expired 落库并返回
// （agent 据此停止轮询走降级路径；不依赖清理器兜底的间隔粒度）
func GetAgentAsk(c *gin.Context) {
	ask, err := store.Get().AgentAsk.Get(c.Param("id"))
	if err != nil || ask == nil {
		shared.Error(c, http.StatusNotFound, "ops ask not found", err)
		return
	}
	if ask.Status == store.AskPending && time.Now().After(ask.ExpiresAt) {
		ask.Status = store.AskExpired
		if err := store.Get().AgentAsk.Save(*ask); err != nil {
			shared.Error(c, http.StatusInternalServerError, "ops ask failed", err)
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": ask})
}

// AnswerAgentAsk 用户作答（前端提问卡片「提交」/选项按钮）。
// 幂等约束：仅 pending 可答——已答/已过期的记录 409（答案以先到者为准）
func AnswerAgentAsk(c *gin.Context) {
	shared.LimitBody(c, askBodyMaxBytes)
	var req struct {
		Answer string `json:"answer" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "ops ask answer too large",
				fmt.Errorf("request body exceeds %d bytes", askBodyMaxBytes))
			return
		}
		shared.Error(c, http.StatusBadRequest, "ops ask answer failed", err)
		return
	}
	answer := strings.TrimSpace(req.Answer)
	if answer == "" || len(answer) > askAnswerMaxLen {
		shared.Error(c, http.StatusBadRequest, "invalid answer (1-4096 chars)", nil)
		return
	}
	id := c.Param("id")
	ask, err := store.Get().AgentAsk.Get(id)
	if err != nil || ask == nil {
		shared.Error(c, http.StatusNotFound, "ops ask not found", err)
		return
	}
	if ask.Status != store.AskPending {
		shared.Error(c, http.StatusConflict, "already resolved: "+ask.Status, nil)
		return
	}
	if time.Now().After(ask.ExpiresAt) {
		// 到点瞬间作答：按过期处理（与轮询侧同一判定），状态落库保持一致
		ask.Status = store.AskExpired
		if err := store.Get().AgentAsk.Save(*ask); err != nil {
			shared.Error(c, http.StatusInternalServerError, "ops ask answer failed", err)
			return
		}
		shared.Error(c, http.StatusConflict, "already resolved: "+ask.Status, nil)
		return
	}
	ask.Status = store.AskAnswered
	ask.Answer = answer
	now := time.Now()
	ask.AnsweredAt = &now
	if err := store.Get().AgentAsk.Save(*ask); err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops ask answer failed", err)
		return
	}
	// 广播回流（多标签页一致清账，同 approval.resolved 语义）
	opschannel.BroadcastEvent(opschannel.EventInputResolved, gin.H{
		"id": ask.ID, "status": ask.Status, "terminalId": ask.TerminalID,
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": ask.ID, "status": ask.Status}})
}

// ListAgentAsks 提问列表（值班大屏冷启动补账/诊断用；只回窗口期内的记录）。
// 顺路惰性翻转已过期的 pending，保证补账状态与轮询侧一致
func ListAgentAsks(c *gin.Context) {
	list, err := store.Get().AgentAsk.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops ask list failed", err)
		return
	}
	now := time.Now()
	out := make([]store.AgentAsk, 0, len(list))
	for i := range list {
		if list[i].Status == store.AskPending && now.After(list[i].ExpiresAt) {
			list[i].Status = store.AskExpired
			if err := store.Get().AgentAsk.Save(list[i]); err != nil {
				shared.Error(c, http.StatusInternalServerError, "ops ask list failed", err)
				return
			}
		}
		out = append(out, list[i])
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}
