package store

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// AgentAsk 智能体结构化提问（P-20261001-27）：
// 环境内 Agent 长任务中需要用户输入（方案选择/缺环境变量值等）时，经
// POST /api/ops-ask 提问，前端全局提问卡片即时呈现；用户作答后 Agent 轮询
// GET /api/ops-ask/:id 取答案继续任务。与审批卡（AgentApproval）共同构成
// agent↔用户 双向通道：审批解决「可/否」二元裁决，提问补全自由文本/选项。
//
// 敏感面约定：答案走明文存储（与审批 detail 同级敏感面）——全部记录以
// AskTTL 为硬上限，过期由惰性状态翻转 + 周期清理双路径删除，不长期留痕。
type AgentAsk struct {
	ID         string     `json:"id"` // sc_aq_ + uuid
	TerminalID string     `json:"terminalId,omitempty"`
	Agent      string     `json:"agent,omitempty"` // 发起方智能体类型（claude/codex/dsh/shell，会话运行时反查；空=未知）
	Question   string     `json:"question"`
	Options    []string   `json:"options,omitempty"` // 可选项（非空时前端以按钮作答，答案取选项原文）
	Status     string     `json:"status"`            // pending | answered | expired
	Answer     string     `json:"answer,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	AnsweredAt *time.Time `json:"answeredAt,omitempty"`
	ExpiresAt  time.Time  `json:"expiresAt"` // pending 到点即视为过期（handler 惰性翻转；前端按此倒计时自清）
}

const (
	AskPending  = "pending"
	AskAnswered = "answered"
	AskExpired  = "expired"
)

// AskTTL 未答问题的存活窗口：创建起算，到点未答即过期。
// 兼任全部记录（含已答答案明文）的保留上限——过期即删，不长期留痕
const AskTTL = 30 * time.Minute

type AgentAskStore interface {
	Save(a AgentAsk) error
	Get(id string) (*AgentAsk, error)
	List() ([]AgentAsk, error)
	// CleanupBefore 删除 CreatedAt 早于 before 的全部提问记录（pending/answered
	// 一视同仁——答案明文与问题同窗口期，过窗即删）。append 型 kind 必须带保留
	// 策略（持久化纪律）
	CleanupBefore(before time.Time) (int, error)
}

type agentAskRepo struct {
	doc DocumentStore
}

func newAgentAskRepo(doc DocumentStore) *agentAskRepo {
	return &agentAskRepo{doc: doc}
}

const agentAskKind = "agentask"

func (r *agentAskRepo) Save(a AgentAsk) error {
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentAskKind, a.ID, b)
}

func (r *agentAskRepo) Get(id string) (*AgentAsk, error) {
	b, err := r.doc.Get(agentAskKind, id)
	if err != nil {
		return nil, err
	}
	var a AgentAsk
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *agentAskRepo) List() ([]AgentAsk, error) {
	keys, _, err := r.doc.List(agentAskKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentAsk, 0, len(keys))
	for _, k := range keys {
		if a, err := r.Get(k); err == nil {
			out = append(out, *a)
		}
	}
	return out, nil
}

// CleanupBefore 实现 AgentAskStore.CleanupBefore
func (r *agentAskRepo) CleanupBefore(before time.Time) (int, error) {
	keys, _, err := r.doc.List(agentAskKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		b, err := r.doc.Get(agentAskKind, k)
		if err != nil {
			continue
		}
		var a AgentAsk
		if json.Unmarshal(b, &a) != nil || a.CreatedAt.After(before) {
			continue
		}
		if err := r.doc.Delete(agentAskKind, k); err == nil {
			removed++
		}
	}
	return removed, nil
}

// NewAgentAskID 提问 ID（服务端生成，客户端不可指定）
func NewAgentAskID() string {
	return "sc_aq_" + uuid.NewString()
}
