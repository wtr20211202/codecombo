package store

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
)

// ErrCompareExpNotFound 对比实验不存在
var ErrCompareExpNotFound = errors.New("compare experiment not found")

// 对比实验状态与侧别词汇（前端按值映射 i18n 文案；Result 复用完成链
// done/failed 同值 + error:<msg> 入库形态，与 agentcron LastResult 同词汇）
const (
	// CompareExpRunning 双侧至少一侧尚无终结回执
	CompareExpRunning = "running"
	// CompareExpReady 双侧均已拿到终结回执（done/failed/error），可进对比视图决断
	CompareExpReady = "ready"

	// CompareAdoptNone 未标注采用
	CompareAdoptNone = ""
	// CompareAdoptA / CompareAdoptB 「以 A/B 为准」标注（MVP：仅持久化标注，
	// 工作区取舍由用户人工 git 处理——自动化二阶段另议）
	CompareAdoptA = "a"
	CompareAdoptB = "b"
)

// CompareSide 对比实验单侧（一个 agent 会话）。SessionID 是完成链归属锚点
// （task.progress 载荷 terminalId），AgentSessionID 是底层智能体会话 id
// （payload.sessionId，claude 场景即对话 uuid——token 用量对账键）。
// Dir 为该侧会话工作目录：缺省共用实验目录；分目录（worktree 隔离竞写）
// 时逐侧独立——对比面（产出归属）以各侧会话元数据为准，本字段仅记账
type CompareSide struct {
	SessionID string `json:"sessionId"`
	Runtime   string `json:"runtime,omitempty"` // 选型后的实际运行时（空 = 选型降级纯 shell）
	Name      string `json:"name,omitempty"`
	Dir       string `json:"dir,omitempty"`
	Launched  bool   `json:"launched"`
	// Result 终结回执：""（等待）/ done / failed / error:<发起失败摘要>
	Result string `json:"result,omitempty"`
	// AgentSessionID 底层智能体会话 id（终结回执携带时捕获；token 用量对账键）
	AgentSessionID string `json:"agentSessionId,omitempty"`
}

// CompareExperiment 双 agent 对比实验（P-20261003-46）：同一 prompt 双开两个
// runtime 会话竞写，双侧完成后按各会话 startHead 快照面做产出对比。
// 车道 1（可查询实体）：一实验一文档，kind=compareexp，键 = 实验 ID；
// 追加型增长由 Create 内容量裁剪（CompareExpKeepMax）+ 采用标注随记录存续
type CompareExperiment struct {
	ID     string `json:"id"` // cmp-<unixnano>，服务端生成
	Prompt string `json:"prompt"`
	Dir    string `json:"dir,omitempty"` // 双侧共用的工作目录（空 = 用户主目录）
	// Status 状态机：running → ready（双侧终结回执齐备，见 ApplySideResult；
	// 无回滚——ready 后即使某侧会话重启也不再回 running）
	Status string `json:"status"`

	A CompareSide `json:"a"`
	B CompareSide `json:"b"`

	// Adopted 采用标注："" / a / b（SetAdopted 单点写入）
	Adopted string `json:"adopted,omitempty"`

	// ApplySnapshot 采用标注时点的工作区指纹（P-20261004-72 ③安全失败参照）：
	// 标注动作把「另一侧独有」行动文件的 sha256 快照在案，apply 执行前对账——
	// 标注后文件被手改（hash 失配/文件增减）即拒绝落盘（P-49 冲突惯例）。
	// 旧记录（升级前标注）无此字段 → apply 先补一次新标注（重取指纹，零间隙）
	// 再执行。omitempty：未标注/旧记录不落键，升级兼容零迁移
	ApplySnapshot *CompareApplySnapshot `json:"applySnapshot,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	ReadyAt   time.Time `json:"readyAt,omitempty"`
}

// CompareApplySnapshot 采用标注时点的工作区指纹（路径 → 文件内容 sha256 hex）。
// 只快照 apply 的行动集（另一侧独有文件），采用侧保留文件与双方文件不入表——
// 快照体随行动集有界（对比实验产物量级）
type CompareApplySnapshot struct {
	Side       string            `json:"side"`       // 标注侧（快照归属）
	CapturedAt time.Time         `json:"capturedAt"` // 标注时刻
	Files      map[string]string `json:"files"`      // 行动文件路径 → sha256 hex（缺失 = 标注时文件不存在）
}

// CompareExperimentStore 对比实验存储（doc store kind=compareexp，一实验一文档）
type CompareExperimentStore interface {
	// Create 新建（忽略传入 ID/CreatedAt/Status，服务端生成；超出容量上限裁剪最旧）
	Create(input CompareExperiment) (*CompareExperiment, error)
	// Get 单条（不存在返回 ErrCompareExpNotFound）
	Get(id string) (*CompareExperiment, error)
	// List 全量列表（创建时间倒序）
	List() ([]CompareExperiment, error)
	// Delete 删除（不存在返回 ErrCompareExpNotFound）
	Delete(id string) error
	// SetSideResult 完成链回执落位：按会话 ID 匹配 running 实验的某侧写入
	// Result（agentSessionID 非空时一并捕获）；双侧齐备即翻 ready。
	// 未命中任何实验返回 ErrCompareExpNotFound（调用方区分「无实验在听」与「已终结」）
	SetSideResult(id, sessionID, result, agentSessionID string) (*CompareExperiment, error)
	// SetAdopted 采用标注（side 仅接受 ""/a/b，其他值报 ErrInvalidArg）
	SetAdopted(id, side string) (*CompareExperiment, error)
	// SetAdoptedSnapshot 采用标注 + 工作区指纹快照（P-20261004-72）：side 非空时
	// 记录该侧行动文件指纹表（nil 表 = 无行动文件，同样落快照防旧形态歧义），
	// side="" 清除标注与快照；标注变更即整体重拍（用户重新决断 = 新参照系）
	SetAdoptedSnapshot(id, side string, files map[string]string) (*CompareExperiment, error)
	// CleanupBefore 删除创建时间早于 before 的记录（保留窗口外的历史），返回删除数
	CleanupBefore(before time.Time) (int, error)
}

const compareExpKind = "compareexp"

// CompareExpKeepMax 实验记录容量上限（裁剪最旧）：对比实验是低频用户动作，
// 上限兜底防无限堆积（通知中心 200 / agenttask 7 天同款的保留策略义务）
const CompareExpKeepMax = 50

type compareExpRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newCompareExpRepo(doc DocumentStore) *compareExpRepo {
	return &compareExpRepo{doc: doc}
}

func (r *compareExpRepo) Get(id string) (*CompareExperiment, error) {
	b, err := r.doc.Get(compareExpKind, id)
	if err != nil {
		return nil, ErrCompareExpNotFound
	}
	var exp CompareExperiment
	if err := json.Unmarshal(b, &exp); err != nil {
		return nil, err
	}
	return &exp, nil
}

func (r *compareExpRepo) save(exp *CompareExperiment) error {
	b, err := json.Marshal(exp)
	if err != nil {
		return err
	}
	return r.doc.Upsert(compareExpKind, exp.ID, b)
}

func (r *compareExpRepo) Create(input CompareExperiment) (*CompareExperiment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	input.ID = NewCompareExpID(time.Now())
	input.CreatedAt = time.Now()
	input.Status = CompareExpRunning
	if err := r.save(&input); err != nil {
		return nil, err
	}
	r.pruneLocked()
	return &input, nil
}

func (r *compareExpRepo) List() ([]CompareExperiment, error) {
	keys, _, err := r.doc.List(compareExpKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]CompareExperiment, 0, len(keys))
	for _, k := range keys {
		if exp, err := r.Get(k); err == nil {
			out = append(out, *exp)
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

func (r *compareExpRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(compareExpKind, id); err != nil {
		return ErrCompareExpNotFound
	}
	return nil
}

// SetSideResult 完成链回执落位。状态迁移收敛在 ApplySideResult 纯函数
// （单测覆盖），本方法只负责取改存
func (r *compareExpRepo) SetSideResult(id, sessionID, result, agentSessionID string) (*CompareExperiment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	exp, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if !ApplySideResult(exp, sessionID, result, agentSessionID) {
		return exp, nil // 非本实验的会话/重复回执：幂等返回现状
	}
	if err := r.save(exp); err != nil {
		return nil, err
	}
	return exp, nil
}

func (r *compareExpRepo) SetAdopted(id, side string) (*CompareExperiment, error) {
	return r.SetAdoptedSnapshot(id, side, nil)
}

// SetAdoptedSnapshot 实现 interface（SetAdopted 委托本方法 side=nil files 形态；
// 保留两入口是语义注记：SetAdopted = 纯标注（MVP 语义零变化），Snapshot 版 =
// 标注 + apply 参照系重拍）
func (r *compareExpRepo) SetAdoptedSnapshot(id, side string, files map[string]string) (*CompareExperiment, error) {
	switch side {
	case CompareAdoptNone, CompareAdoptA, CompareAdoptB:
	default:
		return nil, ErrInvalidArg
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	exp, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if exp.Adopted != side || side != CompareAdoptNone {
		exp.Adopted = side
		if side == CompareAdoptNone {
			exp.ApplySnapshot = nil
		} else {
			exp.ApplySnapshot = &CompareApplySnapshot{
				Side:       side,
				CapturedAt: time.Now(),
				Files:      files,
			}
		}
		if err := r.save(exp); err != nil {
			return nil, err
		}
	}
	return exp, nil
}

func (r *compareExpRepo) CleanupBefore(before time.Time) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(compareExpKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		exp, err := r.Get(k)
		if err != nil || exp.CreatedAt.Before(before) {
			if r.doc.Delete(compareExpKind, k) == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// pruneLocked 容量裁剪（锁内调用）：超出 CompareExpKeepMax 删最旧。
// List 已按创建时间倒序，尾部即最旧
func (r *compareExpRepo) pruneLocked() {
	exps, err := r.List()
	if err != nil {
		return
	}
	for i := CompareExpKeepMax; i < len(exps); i++ {
		_ = r.doc.Delete(compareExpKind, exps[i].ID)
	}
}

// NewCompareExpID 实验 ID 生成（cmp-<unixnano>，与 agent-<unixnano> 会话 ID
// 同款形态；拆出便于测试固定时刻）
func NewCompareExpID(now time.Time) string {
	return "cmp-" + strconv.FormatInt(now.UnixNano(), 10)
}

// ApplySideResult 状态迁移纯函数（单测锚点）：按会话 ID 匹配某侧写入终结回执，
// 双侧齐备即翻 ready 并记 ReadyAt。返回是否发生变更（重复回执/非本实验会话
// 幂等 no-op——ready 后到达的迟到回执不再变更，已终结结果不覆写）
func ApplySideResult(exp *CompareExperiment, sessionID, result, agentSessionID string) bool {
	if exp == nil || sessionID == "" || result == "" || exp.Status != CompareExpRunning {
		return false
	}
	var side *CompareSide
	switch {
	case exp.A.SessionID == sessionID:
		side = &exp.A
	case exp.B.SessionID == sessionID:
		side = &exp.B
	default:
		return false
	}
	if side.Result != "" {
		return false
	}
	side.Result = result
	if agentSessionID != "" {
		side.AgentSessionID = agentSessionID
	}
	if exp.A.Result != "" && exp.B.Result != "" {
		exp.Status = CompareExpReady
		exp.ReadyAt = time.Now()
	}
	return true
}
