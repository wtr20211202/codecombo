package store

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

// ApprovalImpact 结构化影响面（P-20261003-319）：agent 发起高危审批时可选附带
// 的裁决速读摘要——高频裁决从读完 detail 散文变扫徽标（审批卡顶部徽标行）。
// 可选字段零破坏：未附带 = 原自由文本形态降级；合法性由 CreateAgentApproval
// 就地校验（枚举+上限，坏载荷稳定码 ops.confirm_impact_invalid），kind 枚举
// 初版窄域可扩（扩枚举同步 api/ai 层 impactKinds 与前端 i18n kind 标签）
type ApprovalImpact struct {
	Kind    string `json:"kind"`    // delete|reset|push-force|remote-exec|deploy|other
	Summary string `json:"summary"` // 一句话影响摘要（徽标行主文案）
	// FilesCount 受影响文件计数（可选；指针承载「显式 0」与「未附带」之分）
	FilesCount *int `json:"filesCount,omitempty"`
	// Commands 将执行的关键命令清单（可选，≤5 条，上限校验在 api/ai 层）
	Commands []string `json:"commands,omitempty"`
}

// AgentApproval 智能体操作审批（B4 约定式审批流）：
// 环境内 Agent 按操作手册约定，执行高危操作前经 POST /api/ops-confirm 请求
// 确认，用户在产出卡片「允许一次 / 拒绝」；Agent 轮询本记录状态决定继续或中止。
// 服务端强制的 guarded 模式（中间件拦截高危端点）复用同一存储与状态机。
type AgentApproval struct {
	ID        string `json:"id"` // sc_ap_ + uuid
	SessionID string `json:"sessionId,omitempty"`
	Agent     string `json:"agent,omitempty"` // 发起方智能体类型（claude/codex/dsh/shell，会话运行时反查；空=未知）
	Op        string `json:"op"`              // 操作摘要（如 reset --hard / delete file）
	Target    string `json:"target"`          // 目标（路径/分支/主机等）
	Detail    string `json:"detail,omitempty"`
	// Impact 结构化影响面（P-20261003-319，可选）：审批卡顶部徽标行数据源；
	// nil = agent 未附带且服务端未自动填充（老卡/降级形态，卡片不渲染徽标行）。
	// guarded 中间件路径的服务端拦截经 middleware.ImpactFiller 按守卫模式
	// 自动填充有可靠数据的操作（P-20261006-35，初批删除项目→级联会话计数；
	// 无数据路由仍 nil 降级）
	Impact     *ApprovalImpact `json:"impact,omitempty"`
	Status     string          `json:"status"`           // pending | allowed | denied
	Reason     string          `json:"reason,omitempty"` // 拒绝理由（P-20261003-21：deny 时用户附言，轮询/广播回传给发起 agent 调整方案；allow 恒空）
	CreatedAt  time.Time       `json:"createdAt"`
	ResolvedAt *time.Time      `json:"resolvedAt,omitempty"`
	// RuleHit 命中的审批规则 opPattern（P-20261003-35 per-op 裁决审计留痕；
	// 空 = 未命中规则，走全局模式默认路径）。规则带路径条件时（P-20261004-67）
	// 追记 " (path: <glob>)" 后缀——审计可辨「命中靠的是哪半个条件」
	RuleHit string `json:"ruleHit,omitempty"`
	// MergedInto 本记录并入的主卡审批 ID（P-20261006-26 合并审批，可选）：
	// 非空 = 本请求是同会话+同 op 主卡挂起队列的一员——不弹独立卡（主卡
	// Merged 清单承载展示），裁决随主卡联动（ResolveApprovalCascade）；轮询
	// 与 X-Approval-ID 一次性消费语义与普通审批完全一致。空 = 独立卡/主卡
	MergedInto string `json:"mergedInto,omitempty"`
	// Merged 主卡挂起队列快照（仅主卡携带，按到达序，P-20261006-26）：卡片
	// 「+N 同型待批」徽标与展开清单的数据源。条目 target 与记录同源脱敏
	// （入队前已过 MaskApprovalText，无第二明文面）
	Merged []ApprovalMergedItem `json:"merged,omitempty"`
}

// ApprovalMergedItem 合并审批挂起条目快照（主卡 Merged 清单元素，P-20261006-26）：
// 展开清单逐条可见的「细控」最小集。Op 与主卡相同（同 op 是聚合前提）不重复携带
type ApprovalMergedItem struct {
	ID        string    `json:"id"` // 挂起请求自己的审批 ID（= 其 428 返回的 approvalId）
	Target    string    `json:"target,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

const (
	ApprovalPending = "pending"
	ApprovalAllowed = "allowed"
	ApprovalDenied  = "denied"
)

type AgentApprovalStore interface {
	Save(a AgentApproval) error
	Get(id string) (*AgentApproval, error)
	// List 审批列表快照（最新在前）：status 非空按状态过滤（空串=全量，
	// 兼容既有全量消费方），limit>0 截断为最新 N 条。历史查看场景传 limit
	// 收敛 payload（P-20261003-254）；seed 场景传 ApprovalPending 不传 limit
	// = pending 全量（裁决队列量级恒小，不随清理窗口内历史增长）。
	// 注意：合并审批挂起条目（MergedInto 非空）在本层不过滤——超时清扫
	// （api/ai sweepExpiredApprovals）要能看到它们做超时自决兜底；卡片展示
	// 面的过滤在 API 层（ListAgentApprovals，主卡 Merged 清单承载展示）
	List(status string, limit int) ([]AgentApproval, error)
	Delete(id string) error
	// AttachMergedApproval 合并审批入队（P-20261006-26）：entry 的同会话+同 op
	// 短窗口（window）内存在 pending 主卡（MergedInto 为空且队列未满 maxQueued）
	// 时，落库 entry（MergedInto 钉到主卡）并把条目快照追加进主卡 Merged 清单，
	// 返回更新后的主卡（调用方负责重播卡片更新）；无主卡返回 (nil, nil)，调用
	// 方回落独立建卡。窗口与上限由调用方传入（策略参数归中间件面）
	AttachMergedApproval(entry AgentApproval, window time.Duration, maxQueued int, now time.Time) (*AgentApproval, error)
	// ResolveApprovalCascade 主卡裁决联动（P-20261006-26）：主卡终态落库与
	// 挂起队列翻转在同一临界区——allow 放行全部挂起条目（ResolvedAt=now，各自
	// 一次性消费重试窗口独立起算）、deny 全拒（同型信任一致，reason 随行）。
	// 主卡已非 pending 返回 ErrApprovalResolved（调用方按幂等 409 处理）。
	// 返回联动翻转的条目数。挂起条目不广播 resolved（从未弹卡，无账可清；
	// agent 轮询自有 approvalId 即见终态）
	ResolveApprovalCascade(main AgentApproval, reason string, now time.Time) (int, error)
	// CleanupBefore 删除 CreatedAt 早于 before 的审批记录（含 stale pending
	// ——发起方智能体会话早已结束，永不会被消费），返回删除数。
	// append 型 kind 必须带保留策略（持久化纪律）
	CleanupBefore(before time.Time) (int, error)
}

type agentApprovalRepo struct {
	doc DocumentStore
}

func newAgentApprovalRepo(doc DocumentStore) *agentApprovalRepo {
	return &agentApprovalRepo{doc: doc}
}

const agentApprovalKind = "agentapproval"

func (r *agentApprovalRepo) Save(a AgentApproval) error {
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentApprovalKind, a.ID, b)
}

func (r *agentApprovalRepo) Get(id string) (*AgentApproval, error) {
	b, err := r.doc.Get(agentApprovalKind, id)
	if err != nil {
		return nil, err
	}
	var a AgentApproval
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func (r *agentApprovalRepo) List(status string, limit int) ([]AgentApproval, error) {
	keys, _, err := r.doc.List(agentApprovalKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentApproval, 0, len(keys))
	for _, k := range keys {
		if a, err := r.Get(k); err == nil {
			if status != "" && a.Status != status {
				continue
			}
			out = append(out, *a)
		}
	}
	// 最新在前（CreatedAt 相同按 ID 字典序稳定排序，同 AgentTask.List 口径）：
	// doc.List 默认 key 字典序≈随机序，limit 的「最新 N 条」语义依赖确定性排序
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (r *agentApprovalRepo) Delete(id string) error {
	return r.doc.Delete(agentApprovalKind, id)
}

// CleanupBefore 实现 AgentApprovalStore.CleanupBefore
func (r *agentApprovalRepo) CleanupBefore(before time.Time) (int, error) {
	keys, _, err := r.doc.List(agentApprovalKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		b, err := r.doc.Get(agentApprovalKind, k)
		if err != nil {
			continue
		}
		var a AgentApproval
		if json.Unmarshal(b, &a) != nil || a.CreatedAt.After(before) {
			continue
		}
		if err := r.doc.Delete(agentApprovalKind, k); err == nil {
			removed++
		}
	}
	return removed, nil
}

// NewAgentApprovalID 审批 ID（服务端生成，客户端不可指定）
func NewAgentApprovalID() string {
	return "sc_ap_" + uuid.NewString()
}
