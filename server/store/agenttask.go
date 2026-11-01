package store

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

// AgentTask 智能体任务事件流（B6 落库）：task.progress / approval.* 事件
// 的持久化副本——控制面需要「最近跑过什么任务、状态如何」的历史视图，
// 而非只依赖前端内存态。保留 7 天（每日清理）。
type AgentTask struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId,omitempty"` // CC_TERMINAL_ID 归属锚点
	Type      string    `json:"type"`                // task.progress / approval.pending / approval.resolved
	Task      string    `json:"task,omitempty"`
	Status    string    `json:"status,omitempty"`
	Step      string    `json:"step,omitempty"`
	At        time.Time `json:"at"`
}

type AgentTaskStore interface {
	Append(t AgentTask) error
	List(limit int, sessionID string) ([]AgentTask, error)
	CleanupBefore(before time.Time) (int, error)
}

type agentTaskRepo struct {
	doc DocumentStore
}

func newAgentTaskRepo(doc DocumentStore) *agentTaskRepo {
	return &agentTaskRepo{doc: doc}
}

const agentTaskKind = "agenttask"

func (r *agentTaskRepo) Append(t AgentTask) error {
	if t.ID == "" {
		t.ID = "sc_task_" + uuid.NewString()
	}
	if t.At.IsZero() {
		t.At = time.Now()
	}
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return r.doc.Create(agentTaskKind, t.ID, b)
}

func (r *agentTaskRepo) List(limit int, sessionID string) ([]AgentTask, error) {
	keys, _, err := r.doc.List(agentTaskKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentTask, 0, len(keys))
	for _, k := range keys {
		b, err := r.doc.Get(agentTaskKind, k)
		if err != nil {
			continue
		}
		var t AgentTask
		if err := json.Unmarshal(b, &t); err != nil {
			continue
		}
		if sessionID != "" && t.SessionID != sessionID {
			continue
		}
		out = append(out, t)
	}
	// 最新在前（At 相同按 ID 字典序保证稳定排序）
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// CleanupBefore 删除时间点之前的记录（保留窗口外的历史），返回删除数
func (r *agentTaskRepo) CleanupBefore(before time.Time) (int, error) {
	keys, _, err := r.doc.List(agentTaskKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		b, err := r.doc.Get(agentTaskKind, k)
		if err != nil {
			continue
		}
		var t AgentTask
		if err := json.Unmarshal(b, &t); err != nil || t.At.Before(before) {
			if err := r.doc.Delete(agentTaskKind, k); err == nil {
				removed++
			}
		}
	}
	return removed, nil
}
