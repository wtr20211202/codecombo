package store

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

// ErrAgentChainNotFound 会话接续链不存在
var ErrAgentChainNotFound = errors.New("agent chain not found")

// AgentChain 会话接续链（P-20261004-38）：「会话 A 完成后自动把接力棒交给会话 B」
// 的事件触发定义——多 agent 串行接力的地基件（并行竞写=compareexp、定时轮跑=
// agentcron，事件驱动的串行链由此补齐）。
//
// 触发面：链源会话（SourceTerminalID）经完成链上报 task.progress 终态时，
// server/api/agentchain 观察者按 onFailure 档位判定并经 LaunchAgentSession
// 拉起下一棒（prompt 模板占位符 {prevTask}/{prevStatus}/{prevStep} 注入上一棒
// 上下文三元组）。防环与节制（深度上限/冷却/源会话存活校验）在触发引擎，
// 本结构只存定义与运行期事实。
//
// 车道 1（可查询实体）：一链一文档，kind=agentchain，键 = 链 ID；用户手工
// 维护的小规模清单，Create 内容量裁剪（AgentChainKeepMax）兜底防无限堆积。
type AgentChain struct {
	ID string `json:"id"` // chain-<unixnano>，服务端生成
	// SourceTerminalId 触发锚点：链源终端会话 ID（task.progress 载荷
	// terminalId 同一命名空间）。源会话关闭/重启后链自动失效（触发前
	// 存活校验；列表侧置灰可删），重启后同 ID 会话不可复现故无复活语义
	SourceTerminalID string `json:"sourceTerminalId"`
	// PromptTemplate 下一棒任务指令模板（≤500 UTF-8 字节，与 launchArgs
	// 服务端上限同口径）。占位符 {prevTask}/{prevStatus}/{prevStep} 触发时
	// 由服务端替换为上一棒上下文三元组（MVP 结构化三元组，不过度设计）；
	// 未知占位符原样透传（agentcron expandPromptVars 同纪律：模板笔误可见）
	PromptTemplate string `json:"promptTemplate"`
	// Runtime 下一棒运行时（""/"auto" = 按可用性选型；shell/claude/codex/dsh/自定义注册名）
	Runtime string `json:"runtime,omitempty"`
	// Dir 下一棒工作目录（空 = 用户主目录）
	Dir string `json:"dir,omitempty"`
	// OnFailure 失败档位：false（默认）= 仅源会话 done 触发；true = done/failed
	// 都触发（流程必须继续，agentcron 依赖链 always 档同语义）
	OnFailure bool `json:"onFailure,omitempty"`

	CreatedAt time.Time `json:"createdAt"`

	// ── 运行期事实（RecordTrigger 单点写入；CRUD 不得触碰）──
	// LastTriggeredAt 最近一次触发时刻：触发引擎冷却窗口的判定锚点（防
	// task.progress 抖动重入），也是列表侧「上次接续」展示数据
	LastTriggeredAt time.Time `json:"lastTriggeredAt,omitempty"`
	// LastSessionID 最近一次拉起的下一棒会话 ID（通知 Action 直达锚点）
	LastSessionID string `json:"lastSessionId,omitempty"`
	// LastStatus 最近一次触发结果：launched / error:<发起失败摘要>
	LastStatus string `json:"lastStatus,omitempty"`
	// TriggerCount 累计触发次数（链健康度速览；并发触发由引擎互斥保证单调）
	TriggerCount int `json:"triggerCount,omitempty"`
}

// AgentChainStore 会话接续链存储（doc store kind=agentchain，一链一文档）
type AgentChainStore interface {
	// Create 新建（忽略传入 ID/CreatedAt/运行期事实，服务端生成；超出容量上限裁剪最旧）
	Create(input AgentChain) (*AgentChain, error)
	// Get 单条（不存在返回 ErrAgentChainNotFound）
	Get(id string) (*AgentChain, error)
	// List 全量列表（创建时间倒序）
	List() ([]AgentChain, error)
	// Delete 删除（不存在返回 ErrAgentChainNotFound）
	Delete(id string) error
	// RecordTrigger 触发引擎专用：记录触发时刻/下一棒会话/结果并累加计数。
	// 用户 CRUD 路径不走此门（防编辑与触发互相覆盖，AgentCron.RecordRun 同纪律）
	RecordTrigger(id string, at time.Time, sessionID, status string) error
	// CleanupBefore 删除创建时间早于 before 的记录，返回删除数（保留窗口巡检口）
	CleanupBefore(before time.Time) (int, error)
}

const agentChainKind = "agentchain"

// AgentChainKeepMax 链定义容量上限（裁剪最旧）：链是用户手工维护的低频配置，
// 上限兜底防脚本化 CRUD 无限堆积（compareexp 50 同款保留策略义务）
const AgentChainKeepMax = 50

type agentChainRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newAgentChainRepo(doc DocumentStore) *agentChainRepo {
	return &agentChainRepo{doc: doc}
}

func (r *agentChainRepo) Get(id string) (*AgentChain, error) {
	b, err := r.doc.Get(agentChainKind, id)
	if err != nil {
		return nil, ErrAgentChainNotFound
	}
	var ch AgentChain
	if err := json.Unmarshal(b, &ch); err != nil {
		return nil, err
	}
	return &ch, nil
}

func (r *agentChainRepo) save(ch *AgentChain) error {
	b, err := json.Marshal(ch)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentChainKind, ch.ID, b)
}

func (r *agentChainRepo) Create(input AgentChain) (*AgentChain, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	input.ID = NewAgentChainID(time.Now())
	input.CreatedAt = time.Now()
	input.LastTriggeredAt = time.Time{}
	input.LastSessionID = ""
	input.LastStatus = ""
	input.TriggerCount = 0
	if err := r.save(&input); err != nil {
		return nil, err
	}
	r.pruneLocked()
	return &input, nil
}

func (r *agentChainRepo) List() ([]AgentChain, error) {
	keys, _, err := r.doc.List(agentChainKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentChain, 0, len(keys))
	for _, k := range keys {
		if ch, err := r.Get(k); err == nil {
			out = append(out, *ch)
		}
	}
	// 创建时间倒序（同时刻按 ID 字典序保证稳定排序）
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

func (r *agentChainRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(agentChainKind, id); err != nil {
		return ErrAgentChainNotFound
	}
	return nil
}

func (r *agentChainRepo) RecordTrigger(id string, at time.Time, sessionID, status string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, err := r.Get(id)
	if err != nil {
		return err
	}
	ch.LastTriggeredAt = at
	ch.LastSessionID = sessionID
	ch.LastStatus = status
	ch.TriggerCount++
	return r.save(ch)
}

func (r *agentChainRepo) CleanupBefore(before time.Time) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(agentChainKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		ch, err := r.Get(k)
		if err != nil || ch.CreatedAt.Before(before) {
			if r.doc.Delete(agentChainKind, k) == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// pruneLocked 容量裁剪（锁内调用）：超出 AgentChainKeepMax 删最旧。
// List 已按创建时间倒序，尾部即最旧
func (r *agentChainRepo) pruneLocked() {
	chains, err := r.List()
	if err != nil {
		return
	}
	for i := AgentChainKeepMax; i < len(chains); i++ {
		_ = r.doc.Delete(agentChainKind, chains[i].ID)
	}
}

// NewAgentChainID 链 ID 生成（chain-<unixnano>，cmp-/agent- 同款形态；拆出
// 便于测试固定时刻）
func NewAgentChainID(now time.Time) string {
	return "chain-" + strconv.FormatInt(now.UnixNano(), 10)
}
