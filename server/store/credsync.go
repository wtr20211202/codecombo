package store

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// 手动携密同步状态（P-20261024-3）：每「本端×对端实例」记录配对指纹、首次
// 证书短码核对时刻、上次携密同步时刻与方向、传输序号计数。
//
// 职责三件事：
//  1. 首次携密仪式状态——CertVerifiedAt 为零值 = 未核对，携密路径一律拒绝或
//     暂存不落盘（双端确认仪式的服务端硬面）；
//  2. 重放防护——对端每方向单调递增 Seq，收端记录已见最大值，回退即拒；
//  3. 同步中心展示面——「上次携密同步时间」与摘要元数据的数据源。
//
// 车道归属：车道 1 结构化状态，kind "credsync"，一关系一文档（键 = 本端实例
// 注册表的对端条目 ID）。对端删除级联清理（RemoveInstance 链），防陈旧状态
// 让已删对端的旧序号/仪式态被新条目误继承。
type CredSyncState struct {
	Key string `json:"-"`
	// InstanceID 本端实例注册表的对端条目 ID
	InstanceID string `json:"instanceId"`
	// PairFp 配对密钥短指纹（SHA-256 前 8 字节 hex，16 字符；识别用非机密）
	PairFp string `json:"pairFp"`
	// CertVerifiedAt 首次携密前的「证书指纹短码双端核对」完成时刻（零值=未核对）
	CertVerifiedAt time.Time `json:"certVerifiedAt"`
	// LastSyncAt / LastDirection / LastMeta 上次携密同步时刻/方向/计数摘要
	LastSyncAt    time.Time `json:"lastSyncAt"`
	LastDirection string    `json:"lastDirection"`
	LastMeta      string    `json:"lastMeta,omitempty"`
	// SendSeq 本端作为发送方的单调序号（每次携密发送 +1）
	SendSeq int64 `json:"sendSeq"`
	// RecvSeqPush / RecvSeqPull 收端去重水位：对端 push/pull 方向已见最大 Seq
	RecvSeqPush int64 `json:"recvSeqPush"`
	RecvSeqPull int64 `json:"recvSeqPull"`
}

// RecvSeqFor 方向 → 收端水位字段（envelope.Dir 词汇 = push|pull）
func (s *CredSyncState) RecvSeqFor(dir string) int64 {
	if dir == "pull" {
		return s.RecvSeqPull
	}
	return s.RecvSeqPush
}

// SetRecvSeq 方向 → 收端水位写入
func (s *CredSyncState) SetRecvSeq(dir string, seq int64) {
	if dir == "pull" {
		s.RecvSeqPull = seq
		return
	}
	s.RecvSeqPush = seq
}

// CredSyncStore 手动携密同步状态存储
type CredSyncStore interface {
	// Get 单条（不存在返回 ErrNotFound）
	Get(instanceID string) (*CredSyncState, error)
	// Save 写入/覆盖（读改写调用方自行串行化——单实例条目的更新频率极低）
	Save(s CredSyncState) error
	// List 全量（实例量个位级）
	List() ([]CredSyncState, error)
	// Delete 对端实例删除级联清理
	Delete(instanceID string) error
}

const credSyncKind = "credsync"

type credSyncRepo struct {
	mu  sync.Mutex
	doc DocumentStore
}

// NewCredSyncRepo 构造携密同步状态仓储
func NewCredSyncRepo(doc DocumentStore) CredSyncStore {
	return &credSyncRepo{doc: doc}
}

func (r *credSyncRepo) Get(instanceID string) (*CredSyncState, error) {
	if strings.TrimSpace(instanceID) == "" {
		return nil, ErrInvalidArg
	}
	b, err := r.doc.Get(credSyncKind, instanceID)
	if err != nil {
		return nil, ErrNotFound
	}
	var s CredSyncState
	if json.Unmarshal(b, &s) != nil {
		return nil, ErrNotFound
	}
	s.Key = instanceID
	return &s, nil
}

func (r *credSyncRepo) Save(s CredSyncState) error {
	if strings.TrimSpace(s.InstanceID) == "" {
		return ErrInvalidArg
	}
	s.Key = s.InstanceID
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return r.doc.Upsert(credSyncKind, s.InstanceID, b)
}

func (r *credSyncRepo) List() ([]CredSyncState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(credSyncKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]CredSyncState, 0, len(keys))
	for _, k := range keys {
		b, err := r.doc.Get(credSyncKind, k)
		if err != nil {
			continue
		}
		var s CredSyncState
		if json.Unmarshal(b, &s) != nil {
			continue
		}
		s.Key = k
		out = append(out, s)
	}
	return out, nil
}

func (r *credSyncRepo) Delete(instanceID string) error {
	if strings.TrimSpace(instanceID) == "" {
		return ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(credSyncKind, instanceID); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}
