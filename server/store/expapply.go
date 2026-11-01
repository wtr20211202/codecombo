package store

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

// ErrExpApplyNotFound 落盘记录不存在
var ErrExpApplyNotFound = errors.New("compare experiment apply record not found")

// 对比实验采用落盘记录（P-20261004-72 ②强制备份前置）：mode=apply 每次
// 执行前把「即将被破坏的工作区状态」快照进本记录——tracked 回滚文件的
// 正向还原补丁（git diff --binary，git apply 双向可还原）+ 待删除 untracked
// 文件的字节原样备份。apply 的删除/回滚不可跳过备份（记录落库失败即拒绝
// 执行）；落盘出问题时用户可凭记录手工还原。
//
// 存储：车道 1 kind "expapply"，一动作一文档（append 型）。补丁/文件字节
// 内嵌文档体与 filehistory（P-20261002-130）同款取舍：单记录有硬字节上限
// （超限拒绝 apply 宁拒勿删），省一条车道 2 旁路且「备份可查」单 GET 即得。
//
// 一致性：repo 级互斥锁串行化「裁剪 → 写文档」读改写（compareexp 同桁）。

// expApplyKind 文档 kind 名
const expApplyKind = "expapply"

// ExpApplyKeepMax 落盘记录容量上限（裁剪最旧）：apply 是低频用户动作，
// 上限兜底防无限堆积（compareexp 50 / notifications 200 同款保留策略义务）。
// 实验删除时其记录级联清账（DeleteExperiment 调 DeleteByExperiment），
// 孤儿记录不占额度
const ExpApplyKeepMax = 20

// ExpApplyBackupMaxBytes 单次落盘备份字节上限（补丁 + untracked 字节累计）：
// 超限拒绝 apply——备份不完整时执行删除/回滚等于盲删，宁拒勿删。
// 8MB 与单 diff 输出上限（MaxDiffOutput 5MB）同量级，对比实验产物远够
const ExpApplyBackupMaxBytes = 8 << 20

// ExpApplyRecord 一次采用落盘的执行记录 + 备份
type ExpApplyRecord struct {
	ID        string `json:"id"` // expapply-<unixnano>，服务端生成
	ExpID     string `json:"expId"`
	Side      string `json:"side"` // 采用侧 a/b
	Dir       string `json:"dir"`  // 实际作用目录（= 未采用侧工作目录）
	BaseHead  string `json:"baseHead,omitempty"`
	// BaseHead 回滚基准（未采用侧 startHead）；Kept/RolledBack/Deleted/Noop
	// 计数与 Notes 见 AdoptApplyResult 同词汇
	Kept       int      `json:"kept"`
	RolledBack int      `json:"rolledBack"`
	Deleted    int      `json:"deleted"`
	Noop       int      `json:"noop"`
	Notes      []string `json:"notes,omitempty"`

	// ── 强制备份（apply 前置，落库失败即拒绝执行）──
	// Patch tracked 回滚文件的正向还原补丁（git diff --binary 拼接，
	// git apply 可整体还原；BaseHead 为补丁基线）
	Patch string `json:"patch,omitempty"`
	// Untracked 被删除的未跟踪文件内容备份（路径 → 原字节；JSON 落盘
	// 自动 base64，二进制安全——filehistory Content 同款保真通道）
	Untracked map[string][]byte `json:"untracked,omitempty"`
	// PatchBytes 备份补丁字节数（列表轻量展示；Patch 本体经单条端点另取）
	PatchBytes int  `json:"patchBytes,omitempty"`
	Truncated  bool `json:"truncated,omitempty"` // 备份不完整标记（当前实现超限即拒绝，恒 false；字段留作降级路径）

	CreatedAt time.Time `json:"createdAt"`
}

// ExpApplyStore 对比实验落盘记录存储（doc store kind=expapply，一动作一文档）
type ExpApplyStore interface {
	// Create 新建（忽略传入 ID/CreatedAt，服务端生成；超出容量上限裁剪最旧）
	Create(input ExpApplyRecord) (*ExpApplyRecord, error)
	// Update 执行结果回写（计数/注记；不存在返回 ErrExpApplyNotFound）
	Update(rec *ExpApplyRecord) error
	// Get 单条（不存在返回 ErrExpApplyNotFound）
	Get(id string) (*ExpApplyRecord, error)
	// Delete 单条删除（apply 执行失败时回收本次备份，不动同实验其他记录）
	Delete(id string) error
	// ListByExperiment 某实验的落盘记录（创建时间倒序）
	ListByExperiment(expID string) ([]ExpApplyRecord, error)
	// DeleteByExperiment 实验删除时级联清账，返回删除数
	DeleteByExperiment(expID string) (int, error)
}

type expApplyRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newExpApplyRepo(doc DocumentStore) *expApplyRepo {
	return &expApplyRepo{doc: doc}
}

// NewExpApplyID 记录 ID 生成（expapply-<unixnano>，cmp-/agent- 同款形态）
func NewExpApplyID(now time.Time) string {
	return "expapply-" + strconv.FormatInt(now.UnixNano(), 10)
}

func (r *expApplyRepo) Create(input ExpApplyRecord) (*ExpApplyRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	input.ID = NewExpApplyID(time.Now())
	input.CreatedAt = time.Now()
	b, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	if err := r.doc.Create(expApplyKind, input.ID, b); err != nil {
		return nil, err
	}
	r.pruneLocked()
	return &input, nil
}

func (r *expApplyRepo) Update(rec *ExpApplyRecord) error {
	if rec == nil || rec.ID == "" {
		return ErrExpApplyNotFound
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if has, _ := r.doc.Has(expApplyKind, rec.ID); !has {
		return ErrExpApplyNotFound
	}
	return r.doc.Update(expApplyKind, rec.ID, b)
}

func (r *expApplyRepo) Get(id string) (*ExpApplyRecord, error) {
	b, err := r.doc.Get(expApplyKind, id)
	if err != nil {
		return nil, ErrExpApplyNotFound
	}
	var rec ExpApplyRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (r *expApplyRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(expApplyKind, id); err != nil {
		return ErrExpApplyNotFound
	}
	return nil
}

func (r *expApplyRepo) ListByExperiment(expID string) ([]ExpApplyRecord, error) {
	keys, _, err := r.doc.List(expApplyKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]ExpApplyRecord, 0, 4)
	for _, k := range keys {
		rec, err := r.Get(k)
		if err == nil && rec.ExpID == expID {
			out = append(out, *rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (r *expApplyRepo) DeleteByExperiment(expID string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(expApplyKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		rec, err := r.Get(k)
		if err == nil && rec.ExpID == expID {
			if r.doc.Delete(expApplyKind, k) == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// pruneLocked 容量裁剪（锁内调用）：超出 ExpApplyKeepMax 删最旧。
// ListByExperiment 是按实验过滤的视图，容量治理走全量 List（同 compareexp）
func (r *expApplyRepo) pruneLocked() {
	keys, _, err := r.doc.List(expApplyKind, ListOpts{})
	if err != nil {
		return
	}
	recs := make([]ExpApplyRecord, 0, len(keys))
	for _, k := range keys {
		if rec, err := r.Get(k); err == nil {
			recs = append(recs, *rec)
		}
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].CreatedAt.Before(recs[j].CreatedAt) })
	for i := 0; i < len(recs)-ExpApplyKeepMax; i++ {
		_ = r.doc.Delete(expApplyKind, recs[i].ID)
	}
}
