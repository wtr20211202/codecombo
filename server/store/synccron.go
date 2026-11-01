package store

import (
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 定时同步任务（P-20261023-1 步骤 5）：sync 域的定时拉取/推送。到点由 sync
// 模块分钟巡检评估，按冲突策略档位执行 plan→安全项自动同步、冲突项留通知
// 中心裁决（safe 档）或按镜像档显式单向权威（local-mirror / peer-mirror——
// 备份场景 A→B 定时推送需要镜像档，不能事事人工裁决）。
//
// 调度模型与 agentcron 同范式（每日 HH:MM + 周几集合 + IANA 时区 + 错过补偿），
// 不另建 cron 表达式引擎——内核调度器为间隔制，分钟巡检 + lastRunAt 槽点去重
// 即「每日一次、错过可补」的既有成熟语义（agentcron module.go 同款取舍）。
//
// 车道归属：车道 1（一任务一文档，kind "synccron"，键 = 任务 ID）——沿用
// agentchain 一链一文档的键控形态，不采用 agentcron 单文档全量数组的历史
// 形态（三车道纪律：禁止单文档存整个数组，存量勿模仿）。
type SyncCron struct {
	ID   string `json:"id"` // sc_sync_ + uuid，服务端生成
	Name string `json:"name"`

	// Direction 方向：pull（对端→本端）/ push（本端→对端）
	Direction string `json:"direction"`
	// PeerIDs 目标实例集（push 可多台；pull 语义上取首台——多台拉取按序执行）
	PeerIDs []string `json:"peerIds"`
	// ProjectKeys 项目单元键集（project:<rootBasename>；空 = 全部项目）
	ProjectKeys []string `json:"projectKeys,omitempty"`
	// Contexts 上下文单元 kind 集（notes/sessions/crons/snippets/runtimes/approvals/chains/uistate；
	// 空 = 仅项目本体）
	Contexts []string `json:"contexts,omitempty"`
	// ConflictPolicy 冲突策略三档：safe（默认，只做安全项·冲突留通知）/
	// local-mirror（本端为准镜像）/ peer-mirror（对端为准镜像）
	ConflictPolicy string `json:"conflictPolicy"`
	// IncludeIgnored 含被忽略文件（.gitignore 感知排除的对偶开关，与手动同步同义）
	IncludeIgnored bool `json:"includeIgnored,omitempty"`

	// 调度字段（agentcron 同名同义：评估时区/时刻/周几/启停/错过补偿）
	Hour        int    `json:"hour"`
	Minute      int    `json:"minute"`
	Weekdays    []int  `json:"weekdays,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
	Enabled     bool   `json:"enabled"`
	MissCatchUp bool   `json:"missCatchUp,omitempty"`

	// 运行期事实（RecordRun 单点写入，用户编辑不可触碰——AgentCron 同纪律）
	LastRunAt  time.Time       `json:"lastRunAt,omitempty"`
	LastResult string          `json:"lastResult,omitempty"` // synced / partial / failed / skipped / error:<msg>
	LastNote   string          `json:"lastNote,omitempty"`   // 人类可读结果摘要（单元数/冲突数/跳过原因）
	History    []SyncCronRun   `json:"history,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

// SyncCronRun 单次运行历史条目（最新在尾，环形截断）
type SyncCronRun struct {
	At     time.Time `json:"at"`
	Result string    `json:"result"`
	Note   string    `json:"note,omitempty"`
}

const (
	// SyncCronDirPull / SyncCronDirPush 方向词汇
	SyncCronDirPull = "pull"
	SyncCronDirPush = "push"

	// SyncPolicySafe 只做安全项，冲突留通知中心裁决
	SyncPolicySafe = "safe"
	// SyncPolicyLocalMirror 本端为准镜像（冲突按本端覆盖对端）
	SyncPolicyLocalMirror = "local-mirror"
	// SyncPolicyPeerMirror 对端为准镜像（冲突按对端覆盖本端）
	SyncPolicyPeerMirror = "peer-mirror"

	// synccronRunHistoryMax 运行历史保留条数（环形截断最旧，agentcron 同值）
	synccronRunHistoryMax = 20
	// synccronNoteMaxRune 结果摘要 rune 上限（写入时截断）
	synccronNoteMaxRune = 200
	// synccronKeepMax 任务容量上限（裁剪最旧，AgentChainKeepMax 同款保留策略义务）
	SyncCronKeepMax = 50
)

// ErrSyncCronNotFound 定时同步任务不存在
var ErrSyncCronNotFound = errors.New("sync cron not found")

// NormalizeSyncPolicy 未知/缺省冲突策略归一为 safe（白名单外的值不落盘）
func NormalizeSyncPolicy(p string) string {
	switch p {
	case SyncPolicyLocalMirror, SyncPolicyPeerMirror:
		return p
	}
	return SyncPolicySafe
}

// IsDue 评估任务在 now（已折算到任务时区）是否到点：时刻匹配 + 周几生效
//（空集 = 每天）。与 agentcron 的槽点评估同口径，供调度器与试跑共用
func (c SyncCron) IsDue(now time.Time) bool {
	if now.Hour() != c.Hour || now.Minute() != c.Minute {
		return false
	}
	if len(c.Weekdays) == 0 {
		return true
	}
	wd := int(now.Weekday())
	for _, w := range c.Weekdays {
		if w == wd {
			return true
		}
	}
	return false
}

// Location 任务评估时区（加载失败回落本地时区：平台 tz 数据缺失时宁可退回
// 旧语义，不可让调度崩摆——AgentCron 同纪律）
func (c SyncCron) Location() *time.Location {
	if c.Timezone == "" {
		return time.Local
	}
	if loc, err := time.LoadLocation(c.Timezone); err == nil {
		return loc
	}
	return time.Local
}

// SyncCronStore 定时同步任务存储
type SyncCronStore interface {
	// List 全量列表（创建时间升序）
	List() ([]SyncCron, error)
	// Get 单条（不存在返回 ErrSyncCronNotFound）
	Get(id string) (*SyncCron, error)
	// Create 新建（忽略传入 ID/时间戳/运行期事实，服务端生成）
	Create(input SyncCron) (*SyncCron, error)
	// Update 全量替换用户可编辑字段，保留 ID/CreatedAt 与运行期事实；
	// 不存在返回 ErrSyncCronNotFound
	Update(id string, input SyncCron) (*SyncCron, error)
	// Delete 删除（不存在返回 ErrSyncCronNotFound）
	Delete(id string) error
	// RecordRun 调度器/试跑专用：记录触发时刻与结果并追加一条运行历史
	//（note ≤200 rune 写入时截断；用户编辑路径不走此门）
	RecordRun(id string, at time.Time, result, note string) error
}

const syncCronKind = "synccron"

type syncCronRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

// NewSyncCronRepo 构造定时同步任务仓储
func NewSyncCronRepo(doc DocumentStore) SyncCronStore {
	return &syncCronRepo{doc: doc}
}

func (r *syncCronRepo) loadAll() ([]SyncCron, error) {
	keys, _, err := r.doc.List(syncCronKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]SyncCron, 0, len(keys))
	for _, k := range keys {
		b, err := r.doc.Get(syncCronKind, k)
		if err != nil {
			continue
		}
		var t SyncCron
		if json.Unmarshal(b, &t) != nil {
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (r *syncCronRepo) save(t *SyncCron) error {
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return r.doc.Upsert(syncCronKind, t.ID, b)
}

func (r *syncCronRepo) List() ([]SyncCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.loadAll()
}

func (r *syncCronRepo) Get(id string) (*SyncCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := r.doc.Get(syncCronKind, id)
	if err != nil {
		return nil, ErrSyncCronNotFound
	}
	var t SyncCron
	if json.Unmarshal(b, &t) != nil {
		return nil, ErrSyncCronNotFound
	}
	return &t, nil
}

func (r *syncCronRepo) Create(input SyncCron) (*SyncCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.loadAll()
	if err != nil {
		return nil, err
	}
	// 容量上限裁剪最旧（AgentChainKeepMax 同款保留策略义务）
	if len(all) >= SyncCronKeepMax {
		oldest := all[0]
		if err := r.doc.Delete(syncCronKind, oldest.ID); err != nil {
			return nil, err
		}
	}
	now := time.Now()
	input.ID = "sc_sync_" + uuid.New().String()
	input.CreatedAt = now
	input.UpdatedAt = now
	input.LastRunAt = time.Time{}
	input.LastResult = ""
	input.LastNote = ""
	input.History = nil
	input.ConflictPolicy = NormalizeSyncPolicy(input.ConflictPolicy)
	if err := r.save(&input); err != nil {
		return nil, err
	}
	return &input, nil
}

func (r *syncCronRepo) Update(id string, input SyncCron) (*SyncCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var prev SyncCron
	b, err := r.doc.Get(syncCronKind, id)
	if err != nil {
		return nil, ErrSyncCronNotFound
	}
	if json.Unmarshal(b, &prev) != nil {
		return nil, ErrSyncCronNotFound
	}
	input.ID = prev.ID
	input.CreatedAt = prev.CreatedAt
	input.UpdatedAt = time.Now()
	// 运行期事实保留（用户编辑不可触碰——AgentCron.Update 同纪律）
	input.LastRunAt = prev.LastRunAt
	input.LastResult = prev.LastResult
	input.LastNote = prev.LastNote
	input.History = prev.History
	input.ConflictPolicy = NormalizeSyncPolicy(input.ConflictPolicy)
	if err := r.save(&input); err != nil {
		return nil, err
	}
	return &input, nil
}

func (r *syncCronRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(syncCronKind, id); err != nil {
		return ErrSyncCronNotFound
	}
	return nil
}

func (r *syncCronRepo) RecordRun(id string, at time.Time, result, note string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := r.doc.Get(syncCronKind, id)
	if err != nil {
		return ErrSyncCronNotFound
	}
	var t SyncCron
	if json.Unmarshal(b, &t) != nil {
		return ErrSyncCronNotFound
	}
	t.LastRunAt = at
	t.LastResult = result
	t.LastNote = truncateRunes(note, synccronNoteMaxRune)
	t.History = append(t.History, SyncCronRun{At: at, Result: result, Note: t.LastNote})
	if len(t.History) > synccronRunHistoryMax {
		t.History = t.History[len(t.History)-synccronRunHistoryMax:]
	}
	return r.save(&t)
}
