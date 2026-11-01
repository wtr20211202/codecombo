package store

import "errors"

// 错误类型
var (
	ErrNotFound      = errors.New("document not found")
	ErrAlreadyExists = errors.New("document already exists")
	ErrInvalidArg    = errors.New("invalid argument")
)

// ListOpts 查询选项
type ListOpts struct {
	Offset int
	Limit  int
	Prefix string
	Match  map[string]any
	Sort   SortOrder
}

// SortOrder 排序选项
type SortOrder struct {
	Field      string
	Descending bool
}

// DocumentStore 通用文档存储接口（15 个方法）
type DocumentStore interface {
	// ── 单条操作（7 个）──
	Create(kind string, key string, data []byte) error
	Update(kind string, key string, data []byte) error
	Patch(kind string, key string, patch map[string]any) error
	Get(kind string, key string) ([]byte, error)
	Delete(kind string, key string) error
	Has(kind string, key string) (bool, error)
	// Upsert 存在即 Update 否则 Create——repo 层「Has→Update/Create」三步
	// 样板（P-20261006-42）的单方法收口。Has 判定的 error 一律按不存在处理：
	// 这是对历史样板 has, _ := 语义的原样收编（等价替换，零行为变化优先）——
	// Has 误判false时落 Create，其键校验会让非法 kind/key 的错误从 Upsert
	// 冒出，不存在静默丢写；新实现（SQLite 等）按同一语义实现并过 conformance
	Upsert(kind string, key string, data []byte) error

	// ── 批量操作（6 个）──
	GetBatch(kind string, keys []string) (map[string][]byte, error)
	CreateBatch(kind string, items map[string][]byte) error
	UpdateBatch(kind string, items map[string][]byte) error
	PatchBatch(kind string, patches map[string]map[string]any) error
	DeleteBatch(kind string, keys []string) error
	Clear(kind string) error

	// ── 查询操作（2 个）──
	List(kind string, opts ListOpts) (keys []string, total int, err error)
	Count(kind string, opts ListOpts) (int, error)
}
