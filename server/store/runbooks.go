package store

import (
	"encoding/json"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Runbook 运行书（P-20261003-24）：多步运维序列（部署三连/发版清单/环境巡检）的
// 有序步骤列表，逐条「发送到终端」由人确认回车执行。存储与片段（C2）同族：
// docstore 单文档全量数组 + repo 内互斥；步骤命令是纯文本，可含 P-20261002-123
// 占位符模板（{参数}）——存储层不感知插值语义，前端发送时经 textTemplate 展开
type Runbook struct {
	ID string `json:"id"` // sc_rb_ + uuid，服务端生成
	// OnFailure 失败语义（P-20261004-13）：""/"continue" = 连续发送（默认，现状）；
	// "stop" = 序贯执行中任一步骤非 0 退出码即停。存储层只存不解析——逐条等待
	// 退出码与停止语义由前端运行器（useRunbookRunner）经 OSC 133 帧实现
	OnFailure   string        `json:"onFailure,omitempty"`
	Title       string        `json:"title"`
	Description string        `json:"description,omitempty"`
	Steps       []RunbookStep `json:"steps"` // 有序：数组序即执行序
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

// RunbookStep 单个步骤：命令（必填，支持占位符模板）+ 可选说明
type RunbookStep struct {
	Command     string `json:"command"`
	Description string `json:"description,omitempty"`
}

// RunbookStore 运行书存储（doc store kind=runbooks，单文档全量数组 + repo 内互斥）
type RunbookStore interface {
	// List 全量列表（Title 字典序）
	List() ([]Runbook, error)
	// Get 单本查询（不存在返回 ErrNotFound；P-20261004-108 服务端执行链按 id 取书）
	Get(id string) (*Runbook, error)
	// Create 新建（忽略传入 ID/时间戳，服务端生成；Steps 深拷贝防调用方改写别名）
	Create(input Runbook) (*Runbook, error)
	// Update 更新（Steps 空 = 未提供该字段不改写——与 Snippet patch 语义一致；
	// 不存在返回 ErrNotFound）
	Update(id string, patch Runbook) (*Runbook, error)
	// Delete 删除
	Delete(id string) error
}

const runbooksKind = "runbooks"

type runbookRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newRunbookRepo(doc DocumentStore) *runbookRepo {
	return &runbookRepo{doc: doc}
}

// load 读取全量运行书；文档不存在返回空列表（运行书无系统预置数据，
// 首次保存才落盘）。损坏文档按空处理，下次保存自愈
func (r *runbookRepo) load() ([]Runbook, error) {
	data, err := r.doc.Get(runbooksKind, "all")
	if err != nil {
		return []Runbook{}, nil
	}
	var books []Runbook
	if err := json.Unmarshal(data, &books); err != nil {
		return []Runbook{}, nil
	}
	return books, nil
}

func (r *runbookRepo) save(books []Runbook) error {
	if books == nil {
		books = []Runbook{}
	}
	data, err := json.Marshal(books)
	if err != nil {
		return err
	}
	return r.doc.Upsert(runbooksKind, "all", data)
}

// copySteps 深拷贝步骤切片：存入的 Steps 与调用方传入的别名脱钩
// （Create 后调用方改 steps[0] 不得影响已落库文档的下次 save）
func copySteps(in []RunbookStep) []RunbookStep {
	out := make([]RunbookStep, len(in))
	copy(out, in)
	return out
}

func (r *runbookRepo) List() ([]Runbook, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	books, err := r.load()
	if err != nil {
		return nil, err
	}
	sort.Slice(books, func(i, j int) bool { return books[i].Title < books[j].Title })
	return books, nil
}

func (r *runbookRepo) Get(id string) (*Runbook, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	books, err := r.load()
	if err != nil {
		return nil, err
	}
	for i := range books {
		if books[i].ID == id {
			out := books[i]
			return &out, nil
		}
	}
	return nil, ErrNotFound
}

func (r *runbookRepo) Create(input Runbook) (*Runbook, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	books, err := r.load()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	b := Runbook{
		ID:          "sc_rb_" + uuid.New().String(),
		OnFailure:   input.OnFailure,
		Title:       input.Title,
		Description: input.Description,
		Steps:       copySteps(input.Steps),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	books = append(books, b)
	if err := r.save(books); err != nil {
		return nil, err
	}
	return &b, nil
}

func (r *runbookRepo) Update(id string, patch Runbook) (*Runbook, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	books, err := r.load()
	if err != nil {
		return nil, err
	}
	for i := range books {
		if books[i].ID != id {
			continue
		}
		// patch 语义与 Snippet 一致：空字段 = 未提供，不改写（Steps 空切片同理，
		// 防止误传把步骤清空——清空场景应删除整本运行书）
		if patch.Title != "" {
			books[i].Title = patch.Title
		}
		if patch.Description != "" {
			books[i].Description = patch.Description
		}
		// OnFailure 空 = patch 未提供（与 Title/Description 同款 patch 语义）；
		// 合法值校验在 API 层（store 只存不解析）
		if patch.OnFailure != "" {
			books[i].OnFailure = patch.OnFailure
		}
		if len(patch.Steps) > 0 {
			books[i].Steps = copySteps(patch.Steps)
		}
		books[i].UpdatedAt = time.Now()
		if err := r.save(books); err != nil {
			return nil, err
		}
		out := books[i]
		return &out, nil
	}
	return nil, ErrNotFound
}

func (r *runbookRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	books, err := r.load()
	if err != nil {
		return err
	}
	out := books[:0]
	found := false
	for _, b := range books {
		if b.ID == id {
			found = true
			continue
		}
		out = append(out, b)
	}
	if !found {
		return ErrNotFound
	}
	return r.save(out)
}
