package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// SentinelRule 输出哨兵规则（P-20261004-8）：用户自定义的终端输出模式订阅——
// 长构建/后台 agent 会话中出现「deadlock/OOM/测试失败」等模式时第一时间入账
// 通知中心。匹配侧与端口被动探测共挂输出 tap（滑窗 + 防抖护栏复用，见
// server/terminal/sentinel.go）；本存储只管规则的增删改查。
// 存储与运行书同族：docstore 单文档全量数组 + repo 内互斥
type SentinelRule struct {
	ID      string `json:"id"` // sc_sn_ + uuid，服务端生成
	Name    string `json:"name"`
	Pattern string `json:"pattern"` // RE2 正则（Go regexp 天然无回溯，写入时编译校验）
	// Scope 作用域："global" 全部终端会话；其余值为 projectId（仅该项目的会话）
	Scope string `json:"scope"`
	// Level 通知级别：info / warning / error（映射通知中心条目样式）
	Level     string    `json:"level"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// 哨兵规则词汇常量（API 校验与匹配侧共用同一取值面）
const (
	SentinelScopeGlobal = "global"
	SentinelLevelInfo   = "info"
	SentinelLevelWarn   = "warning"
	SentinelLevelError  = "error"
)

// SentinelLevels level 合法取值（API 写入口逐一比对）
var SentinelLevels = []string{SentinelLevelInfo, SentinelLevelWarn, SentinelLevelError}

// SentinelStore 输出哨兵规则存储（doc store kind=sentinels，单文档全量数组 + repo 内互斥）
type SentinelStore interface {
	// List 全量列表（CreatedAt 升序 = 创建序，UI 稳定展示）
	List() ([]SentinelRule, error)
	// Create 新建（忽略传入 ID/时间戳，服务端生成）；规则数达上限返回
	// ErrTooManySentinels——护栏在存储层保证，绕过 API 的调用方同样受限
	Create(input SentinelRule) (*SentinelRule, error)
	// Update 更新（空字段 = patch 未提供不改写，与 Runbook patch 语义一致；
	// 不存在返回 ErrNotFound）
	Update(id string, patch SentinelRule) (*SentinelRule, error)
	// Delete 删除（不存在返回 ErrNotFound）
	Delete(id string) error
	// Version 规则集版本号：任何写操作自增。匹配侧（terminal 包）逐输出块
	// 比对版本，漂移才重读重编正则——规则编译一次缓存的热路径保障
	Version() int64
}

// ErrTooManySentinels 规则数护栏（≤10 条：模式监控是低频高价值订阅，上限
// 防止误用为日志告警平台拖累输出热路径）
var ErrTooManySentinels = fmt.Errorf("too many sentinel rules (limit %d)", SentinelMaxRules)

// SentinelMaxRules 规则数上限（API 与存储共用同一边界）
const SentinelMaxRules = 10

const sentinelsKind = "sentinels"

type sentinelRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
	// version 规则集版本：写操作自增（原子读，匹配侧热路径零锁比对）
	version atomic.Int64
}

func newSentinelRepo(doc DocumentStore) *sentinelRepo {
	return &sentinelRepo{doc: doc}
}

// load 读取全量规则；文档不存在返回空列表（无系统预置哨兵，首次保存才落盘）。
// 损坏文档按空处理，下次保存自愈
func (r *sentinelRepo) load() ([]SentinelRule, error) {
	data, err := r.doc.Get(sentinelsKind, "all")
	if err != nil {
		return []SentinelRule{}, nil
	}
	var rules []SentinelRule
	if err := json.Unmarshal(data, &rules); err != nil {
		return []SentinelRule{}, nil
	}
	return rules, nil
}

func (r *sentinelRepo) save(rules []SentinelRule) error {
	if rules == nil {
		rules = []SentinelRule{}
	}
	data, err := json.Marshal(rules)
	if err != nil {
		return err
	}
	return r.doc.Upsert(sentinelsKind, "all", data)
}

// bump 写操作后自增版本号：匹配侧的编译缓存据此失效
func (r *sentinelRepo) bump() { r.version.Add(1) }

func (r *sentinelRepo) Version() int64 { return r.version.Load() }

func (r *sentinelRepo) List() ([]SentinelRule, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rules, err := r.load()
	if err != nil {
		return nil, err
	}
	// SliceStable：CreatedAt 并列时保持落盘插入序（创建序是 UI 展示承诺）
	sort.SliceStable(rules, func(i, j int) bool { return rules[i].CreatedAt.Before(rules[j].CreatedAt) })
	return rules, nil
}

func (r *sentinelRepo) Create(input SentinelRule) (*SentinelRule, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rules, err := r.load()
	if err != nil {
		return nil, err
	}
	if len(rules) >= SentinelMaxRules {
		return nil, ErrTooManySentinels
	}
	now := time.Now()
	ru := SentinelRule{
		ID:        "sc_sn_" + uuid.New().String(),
		Name:      input.Name,
		Pattern:   input.Pattern,
		Scope:     input.Scope,
		Level:     input.Level,
		CreatedAt: now,
		UpdatedAt: now,
	}
	rules = append(rules, ru)
	if err := r.save(rules); err != nil {
		return nil, err
	}
	r.bump()
	return &ru, nil
}

func (r *sentinelRepo) Update(id string, patch SentinelRule) (*SentinelRule, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rules, err := r.load()
	if err != nil {
		return nil, err
	}
	for i := range rules {
		if rules[i].ID != id {
			continue
		}
		// patch 语义与 Runbook 一致：空字段 = 未提供，不改写
		if patch.Name != "" {
			rules[i].Name = patch.Name
		}
		if patch.Pattern != "" {
			rules[i].Pattern = patch.Pattern
		}
		if patch.Scope != "" {
			rules[i].Scope = patch.Scope
		}
		if patch.Level != "" {
			rules[i].Level = patch.Level
		}
		rules[i].UpdatedAt = time.Now()
		if err := r.save(rules); err != nil {
			return nil, err
		}
		r.bump()
		out := rules[i]
		return &out, nil
	}
	return nil, ErrNotFound
}

func (r *sentinelRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rules, err := r.load()
	if err != nil {
		return err
	}
	out := rules[:0]
	found := false
	for _, ru := range rules {
		if ru.ID == id {
			found = true
			continue
		}
		out = append(out, ru)
	}
	if !found {
		return ErrNotFound
	}
	if err := r.save(out); err != nil {
		return err
	}
	r.bump()
	return nil
}
