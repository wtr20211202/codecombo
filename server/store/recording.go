package store

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

// Recording 审批窗口过程实况录制元数据（P-20261001-15，车道 1 索引）：
// ops-confirm 产生到裁决后短窗口对终端会话开启 PTY tap，屏幕字节流（asciinema
// v2 cast，已模式遮蔽）按车道 2 落 artifacts/recordings/<id>.cast；本结构是
// 可查询的元数据索引（审批标记/起止/大小），生命周期独立于会话——走保留策略
// 长保留档（录制管理器每日 ticker 清理），不挂靠会话或审批记录的清理。
type Recording struct {
	ID          string     `json:"id"` // sc_rec_ + uuid（同时是 cast 文件名主干）
	SessionID   string     `json:"sessionId,omitempty"`
	ApprovalIDs []string   `json:"approvalIds"`     // 审批标记：窗口内全部 pending 审批（起止联动的锚点）
	Agent       string     `json:"agent,omitempty"` // 发起方智能体类型（首个审批反查值；空=未知）
	Op          string     `json:"op,omitempty"`    // 操作摘要（首个审批）
	Target      string     `json:"target,omitempty"`
	Status      string     `json:"status"` // recording | completed
	StartedAt   time.Time  `json:"startedAt"`
	StoppedAt   *time.Time `json:"stoppedAt,omitempty"`
	SizeBytes   int64      `json:"sizeBytes"` // cast 文件字节数（每次写盘后更新）
}

const (
	RecordingStatusRecording = "recording"
	RecordingStatusCompleted = "completed"
)

// RecordingStore 录制元数据索引（车道 1；cast 文件本体在 artifacts 车道 2）
type RecordingStore interface {
	Save(r Recording) error
	Get(id string) (*Recording, error)
	// List 全量索引，StartedAt 倒序（最新在前）
	List() ([]Recording, error)
	Delete(id string) error
	// CleanupBefore 删除 StartedAt 早于 before 的元数据（cast 文件由调用方
	// 依返回结果删除），返回被删元数据的 ID 列表。
	// append 型 kind 必须带保留策略（持久化纪律）
	CleanupBefore(before time.Time) ([]string, error)
}

type recordingRepo struct {
	doc DocumentStore
}

func newRecordingRepo(doc DocumentStore) *recordingRepo {
	return &recordingRepo{doc: doc}
}

const recordingKind = "recording"

func (r *recordingRepo) Save(rec Recording) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return r.doc.Upsert(recordingKind, rec.ID, b)
}

func (r *recordingRepo) Get(id string) (*Recording, error) {
	b, err := r.doc.Get(recordingKind, id)
	if err != nil {
		return nil, err
	}
	var rec Recording
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (r *recordingRepo) List() ([]Recording, error) {
	keys, _, err := r.doc.List(recordingKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]Recording, 0, len(keys))
	for _, k := range keys {
		if rec, err := r.Get(k); err == nil {
			out = append(out, *rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out, nil
}

func (r *recordingRepo) Delete(id string) error {
	return r.doc.Delete(recordingKind, id)
}

// CleanupBefore 实现 RecordingStore.CleanupBefore
func (r *recordingRepo) CleanupBefore(before time.Time) ([]string, error) {
	keys, _, err := r.doc.List(recordingKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	var removed []string
	for _, k := range keys {
		b, err := r.doc.Get(recordingKind, k)
		if err != nil {
			continue
		}
		var rec Recording
		if json.Unmarshal(b, &rec) != nil || !rec.StartedAt.Before(before) {
			continue
		}
		if err := r.doc.Delete(recordingKind, k); err == nil {
			removed = append(removed, k)
		}
	}
	return removed, nil
}

// NewRecordingID 录制 ID（服务端生成；同时是 cast 文件名主干）
func NewRecordingID() string {
	return "sc_rec_" + uuid.NewString()
}
