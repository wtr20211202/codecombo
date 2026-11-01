package store

import (
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 联邦派发记录（P-20261004-131）：中心侧对「派到从实例的会话」落一条寻址账，
// 中心的进度回流轮询（前端 useFleetTaskBackflow）据此知道「哪些实例上有我派
// 出去的会话、对端会话 id 是什么」——没有这份账，中心页面刷新/换浏览器/agent
// 令牌直接 API 派发后，回流通道就断了对端寻址。会话本体仍在对端（P-101 诚实
// 边界不变），记录只含寻址元数据（实例 id/名/地址 + 远端会话 id/名 + 运行时），
// 不含任务指令内容（launchArgs 属会话内容不入账，与审计同口径）。
//
// 车道 1（可查询实体）：一记录一文档，kind=dispatch，键 = 记录 ID。
// append 型 kind 保留策略（PERSISTENCE_LANES 红线）：环形上限 200 条裁最旧 +
// TTL 7 天（List/Append 惰性剪枝 + module 每日 ticker 兜底清理），与 agenttask
// 同一量级思考——回流态清理挂记录生命周期：记录消失（过期/手删），前端轮询
// 与 bySession 的 remote 条目随之收账。
type DispatchRecord struct {
	// ID 记录标识（uuid；一次派发一条，远端会话 id 每次创建均新，天然不重）
	ID string `json:"id"`
	// InstanceID 目标实例 id（注册实例库的 ID 命名空间，switch-instance 链同源）
	InstanceID string `json:"instanceId"`
	// InstanceName 目标实例展示名（派发时刻快照——实例改名/删除后徽标仍有源可标）
	InstanceName string `json:"instanceName,omitempty"`
	// InstanceURL 目标实例地址（派发时刻快照，诊断用）
	InstanceURL string `json:"instanceUrl,omitempty"`
	// RemoteSessionID 对端会话 id（对端 /api/agent-tasks?sessionId= 的查询键）
	RemoteSessionID string `json:"remoteSessionId"`
	// RemoteSessionName 对端会话名（徽标/监控卡显示名）
	RemoteSessionName string `json:"remoteSessionName,omitempty"`
	// Runtime 对端会话运行时（派发时刻快照）
	Runtime string `json:"runtime,omitempty"`
	// At 派发时刻
	At time.Time `json:"at"`
}

// DispatchRecordStore 联邦派发记录存储
type DispatchRecordStore interface {
	// Append 落一条派发记录（容量满裁最旧、过期条目顺带剪枝）
	Append(rec DispatchRecord) error
	// List 全量记录（新在前；惰性剪枝过期条目）
	List() ([]DispatchRecord, error)
	// Delete 删除单条记录（幂等——前端「不再跟踪」入口与清理链共用）
	Delete(id string) error
	// CleanupBefore 删除派发早于 before 的记录（TTL 巡检口），返回删除数
	CleanupBefore(before time.Time) (int, error)
}

const dispatchKind = "dispatch"

// DispatchKeepMax 记录环形上限：派发记录是「最近的跨机寻址账」不是档案柜，
// 200 条与通知上限同一量级思考（PERSISTENCE_LANES append kind 保留策略）
const DispatchKeepMax = 200

// DispatchTTL 单条记录存活窗口：对端会话的生命周期以天计（agent 任务常见
// 小时级，接续链可拉长到天级），7 天与 agenttask 落库保留窗对齐——回流跟踪
// 的意义随任务终态消亡，过期记录不再值得轮询
const DispatchTTL = 7 * 24 * time.Hour

type dispatchRecordRepo struct {
	mu  sync.Mutex // Append/List 的读-改-写三段互斥（inbox 同款先例）
	doc DocumentStore
}

func newDispatchRecordRepo(doc DocumentStore) *dispatchRecordRepo {
	return &dispatchRecordRepo{doc: doc}
}

func (r *dispatchRecordRepo) Append(rec DispatchRecord) error {
	if rec.InstanceID == "" || rec.RemoteSessionID == "" {
		return errors.New("dispatch record: empty instance or session")
	}
	if rec.ID == "" {
		rec.ID = uuid.NewString()
	}
	if rec.At.IsZero() {
		rec.At = time.Now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.listLocked(rec.At)
	if err != nil {
		return err
	}
	all = append(all, rec)
	if len(all) > DispatchKeepMax {
		all = all[len(all)-DispatchKeepMax:]
	}
	b, err := json.Marshal(all)
	if err != nil {
		return err
	}
	// 单文档装全量记录：记录是「最近派发」小集合（上限 200），一文档免去
	// List 时的全 kind 扫描；轮询每 15s 读一次，读放大最小化
	return r.doc.Upsert(dispatchKind, "records", b)
}

// listLocked 读全量并剪枝过期（调用方持 r.mu；剪枝结果不回写——下次 Append
// 顺带落盘，CleanupBefore 每日兜底）
func (r *dispatchRecordRepo) listLocked(now time.Time) ([]DispatchRecord, error) {
	b, err := r.doc.Get(dispatchKind, "records")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var all []DispatchRecord
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, err
	}
	cutoff := now.Add(-DispatchTTL)
	kept := all[:0:0]
	for _, rec := range all {
		if rec.At.Before(cutoff) {
			continue
		}
		kept = append(kept, rec)
	}
	return kept, nil
}

func (r *dispatchRecordRepo) List() ([]DispatchRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.listLocked(time.Now())
	if err != nil {
		return nil, err
	}
	sort.Slice(all, func(i, j int) bool { return all[i].At.After(all[j].At) })
	return all, nil
}

func (r *dispatchRecordRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.listLocked(time.Now())
	if err != nil {
		return err
	}
	kept := all[:0:0]
	for _, rec := range all {
		if rec.ID == id {
			continue
		}
		kept = append(kept, rec)
	}
	if len(kept) == len(all) {
		return nil // 幂等：无此 id 视为已删
	}
	b, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	return r.doc.Upsert(dispatchKind, "records", b)
}

func (r *dispatchRecordRepo) CleanupBefore(before time.Time) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := r.doc.Get(dispatchKind, "records")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return 0, nil
		}
		return 0, err
	}
	var all []DispatchRecord
	if err := json.Unmarshal(b, &all); err != nil {
		return 0, err
	}
	kept := all[:0:0]
	for _, rec := range all {
		if rec.At.Before(before) {
			continue
		}
		kept = append(kept, rec)
	}
	if len(kept) == len(all) {
		return 0, nil
	}
	nb, err := json.Marshal(kept)
	if err != nil {
		return 0, err
	}
	if err := r.doc.Update(dispatchKind, "records", nb); err != nil {
		return 0, err
	}
	return len(all) - len(kept), nil
}
