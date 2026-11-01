package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// 多实例项目同步账本（P-20261023-1，二审增强·正确性前提）：每「单元×对端实例」
// 记录上次成功同步时两端的单元指纹，plan 四态判定以基线为参照——没有基线时
// 「单向更新 vs 双向冲突」不可区分，覆盖语义会静默丢掉对端独立工作，这是判定
// 正确性前提而非可选增强。
//
// 车道归属：车道 1 结构化状态（应用拥有的可查询实体），kind "syncledger"，
// 一账一文档（键 = LedgerKey 派生的安全 hex 段，原文存文档体内）。单元或对端
// 实例删除时级联清理（DeleteByPeer / DeleteByUnit），防陈旧基线误判——陈旧
// 基线会让「对端已重建的项目」被误判为 skip。
type SyncLedgerEntry struct {
	Key string `json:"-"`
	// PeerID 对端实例 ID（实例注册表命名空间）
	PeerID string `json:"peerId"`
	// UnitKey 跨实例稳定单元键（project:<rootBasename> / notes:<rootBasename> 等，
	// 见 sync 模块 UnitKey 构造）
	UnitKey string `json:"unitKey"`
	// LocalFP / PeerFP 上次成功同步时刻两端各自的聚合指纹
	LocalFP string `json:"localFp"`
	PeerFP  string `json:"peerFp"`
	// LocalSize / PeerSize 两端总字节（展示与落后标记参考）
	LocalSize int64 `json:"localSize"`
	PeerSize  int64 `json:"peerSize"`
	// Direction 上次同步方向（push = 本端→对端；pull = 对端→本端）
	Direction string `json:"direction"`
	// SyncedAt 上次成功同步时刻
	SyncedAt time.Time `json:"syncedAt"`
}

// SyncLedgerStore 同步账本存储
type SyncLedgerStore interface {
	// Get 单条（不存在返回 ErrNotFound）
	Get(peerID, unitKey string) (*SyncLedgerEntry, error)
	// Put 写入/覆盖一条账目（同步成功后调用）
	Put(e SyncLedgerEntry) error
	// List 全量账目（实例量×单元量个位~十位级，全量读足够）
	List() ([]SyncLedgerEntry, error)
	// DeleteByPeer 对端实例删除时级联清理（RemoveInstance 链）
	DeleteByPeer(peerID string) error
	// DeleteByUnit 单元删除（项目删除级联）时清理该单元全部对端账目
	DeleteByUnit(unitKey string) error
}

// LedgerKey 账目存储键：peerID+unitKey 的 sha256 前 10 字节 hex（安全段规避
// 单元键里的路径分隔符/非法字符；原文存文档体内）。构造为纯函数供删除端点
// 复算（不依赖读出原文）
func LedgerKey(peerID, unitKey string) string {
	h := sha256.Sum256([]byte(peerID + "\x00" + unitKey))
	return hex.EncodeToString(h[:10])
}

const syncLedgerKind = "syncledger"

type syncLedgerRepo struct {
	mu  sync.Mutex // 读改写（List 级联删除按前缀过滤）需 repo 内互斥
	doc DocumentStore
}

// NewSyncLedgerRepo 构造同步账本仓储
func NewSyncLedgerRepo(doc DocumentStore) SyncLedgerStore {
	return &syncLedgerRepo{doc: doc}
}

func (r *syncLedgerRepo) Get(peerID, unitKey string) (*SyncLedgerEntry, error) {
	b, err := r.doc.Get(syncLedgerKind, LedgerKey(peerID, unitKey))
	if err != nil {
		return nil, ErrNotFound
	}
	var e SyncLedgerEntry
	if json.Unmarshal(b, &e) != nil {
		return nil, ErrNotFound
	}
	e.Key = LedgerKey(peerID, unitKey)
	return &e, nil
}

func (r *syncLedgerRepo) Put(e SyncLedgerEntry) error {
	if e.PeerID == "" || e.UnitKey == "" {
		return ErrInvalidArg
	}
	e.Key = LedgerKey(e.PeerID, e.UnitKey)
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return r.doc.Upsert(syncLedgerKind, e.Key, b)
}

func (r *syncLedgerRepo) List() ([]SyncLedgerEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(syncLedgerKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]SyncLedgerEntry, 0, len(keys))
	for _, k := range keys {
		b, err := r.doc.Get(syncLedgerKind, k)
		if err != nil {
			continue
		}
		var e SyncLedgerEntry
		if json.Unmarshal(b, &e) != nil {
			continue
		}
		e.Key = k
		out = append(out, e)
	}
	return out, nil
}

// DeleteByPeer 级联清理某对端的全部账目。List+逐删而非按前缀区间猜键：
// 键是 hash 派生无前缀语义，全量小表扫描成本可忽略
func (r *syncLedgerRepo) DeleteByPeer(peerID string) error {
	if strings.TrimSpace(peerID) == "" {
		return ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deleteLocked(func(e SyncLedgerEntry) bool { return e.PeerID == peerID })
}

func (r *syncLedgerRepo) DeleteByUnit(unitKey string) error {
	if strings.TrimSpace(unitKey) == "" {
		return ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deleteLocked(func(e SyncLedgerEntry) bool { return e.UnitKey == unitKey })
}

func (r *syncLedgerRepo) deleteLocked(pred func(SyncLedgerEntry) bool) error {
	keys, _, err := r.doc.List(syncLedgerKind, ListOpts{})
	if err != nil {
		return err
	}
	var doomed []string
	for _, k := range keys {
		b, err := r.doc.Get(syncLedgerKind, k)
		if err != nil {
			continue
		}
		var e SyncLedgerEntry
		if json.Unmarshal(b, &e) != nil {
			continue
		}
		if pred(e) {
			doomed = append(doomed, k)
		}
	}
	if len(doomed) == 0 {
		return nil
	}
	return r.doc.DeleteBatch(syncLedgerKind, doomed)
}
