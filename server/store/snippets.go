package store

import (
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ErrSystemSnippet 系统预置片段不可删除
var ErrSystemSnippet = errors.New("system snippet cannot be deleted")

// 片段种类（P-20261002-44）：命令片段（终端消费）与代码片段（编辑器消费）。
// 内容统一存 Command 字段——终端插命令、编辑器插代码同构；旧数据无 Kind 字段，
// 读取时归一为 command（零迁移，无需任何存量改写脚本）
const (
	SnippetKindCommand = "command"
	SnippetKindCode    = "code"
)

// NormalizeSnippetKind 未知/缺省 Kind 归一为 command（白名单外的值不落盘）
func NormalizeSnippetKind(kind string) string {
	if kind == SnippetKindCode {
		return SnippetKindCode
	}
	return SnippetKindCommand
}

// Snippet 命令片段（C2）：确定性执行的常用命令库。
// scope 只保留 global|host——项目级常用命令的真实归宿是 Makefile/justfile 等版本库文件
type Snippet struct {
	ID          string    `json:"id"` // sc_snip_ + uuid，服务端生成
	Title       string    `json:"title"`
	Command     string    `json:"command"`
	Description string    `json:"description,omitempty"`
	Tags        []string  `json:"tags,omitempty"`
	Scope       string    `json:"scope"` // global | host
	ScopeID     string    `json:"scopeId,omitempty"`
	Kind        string    `json:"kind,omitempty"`     // command | code（缺省 command）
	Language    string    `json:"language,omitempty"` // code 片段语言（monaco language id，如 typescript；空 = 任意语言可用）
	IsSystem    bool      `json:"isSystem,omitempty"` // 系统预置片段：不可删除，可另存副本
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// SnippetStore 命令片段存储（doc store kind=snippets，单文档全量数组 + repo 内互斥）
type SnippetStore interface {
	// List 全量列表（Title 字典序；首次调用时播种系统片段）
	List() ([]Snippet, error)
	// Create 新建（忽略传入 ID/IsSystem/时间戳，服务端生成）
	Create(input Snippet) (*Snippet, error)
	// Update 更新（系统片段允许编辑内容但不可改 IsSystem；不存在返回 ErrNotFound）
	Update(id string, patch Snippet) (*Snippet, error)
	// Delete 删除（系统片段拒绝删除）
	Delete(id string) error
}

const snippetsKind = "snippets"

// systemSnippets 系统预置片段 2 条（原 F1 唯一真实增量，评审裁决并入）：
// tmux 持久会话启动 agent / 直接 claude
func systemSnippets() []Snippet {
	now := time.Now()
	return []Snippet{
		{
			ID:          "sc_snip_" + uuid.New().String(),
			Title:       "启动 agent（tmux 持久会话）",
			Command:     "tmux new -s agent || tmux attach -t agent",
			Description: "在持久 tmux 会话中启动 CLI agent（claude/codex 等），断线后 tmux attach -t agent 重连。首次使用先安装：apt install tmux，agent 首次启动按提示登录。",
			Tags:        []string{"agent", "tmux"},
			Scope:       "global",
			Kind:        SnippetKindCommand,
			IsSystem:    true,
			CreatedAt:   now,
			UpdatedAt:   now,
		},
		{
			ID:          "sc_snip_" + uuid.New().String(),
			Title:       "启动 agent（claude）",
			Command:     "claude",
			Description: "直接启动 claude CLI coding agent；可按需替换为 codex 等其他 CLI。",
			Tags:        []string{"agent", "claude"},
			Scope:       "global",
			Kind:        SnippetKindCommand,
			IsSystem:    true,
			CreatedAt:   now,
			UpdatedAt:   now,
		},
	}
}

type snippetRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newSnippetRepo(doc DocumentStore) *snippetRepo {
	return &snippetRepo{doc: doc}
}

// load 读取全量片段；文档不存在时播种系统片段（调用方持有 mu）。
// 迁移：早期版本 seed 未生成 ID，存量无 ID 条目在此回填（无 ID 会导致前端
// 编辑走错分支、列表 key 冲突渲染错乱）
func (r *snippetRepo) load() ([]Snippet, error) {
	data, err := r.doc.Get(snippetsKind, "all")
	if err != nil {
		// 首次使用：播种系统片段
		seeds := systemSnippets()
		if err := r.save(seeds); err != nil {
			return nil, err
		}
		return seeds, nil
	}
	var snippets []Snippet
	if err := json.Unmarshal(data, &snippets); err != nil {
		return []Snippet{}, nil // 损坏文档按空处理，下次保存自愈
	}
	migrated := false
	for i := range snippets {
		if snippets[i].ID == "" {
			snippets[i].ID = "sc_snip_" + uuid.New().String()
			migrated = true
		}
		// Kind 归一：旧数据无 Kind 字段（缺省 command）；白名单外值一并收敛，
		// 前端终端/编辑器两侧按 Kind 过滤时不歧视空值
		if normalized := NormalizeSnippetKind(snippets[i].Kind); normalized != snippets[i].Kind {
			snippets[i].Kind = normalized
			migrated = true
		}
	}
	if migrated {
		if err := r.save(snippets); err != nil {
			return nil, err
		}
	}
	return snippets, nil
}

func (r *snippetRepo) save(snippets []Snippet) error {
	if snippets == nil {
		snippets = []Snippet{}
	}
	data, err := json.Marshal(snippets)
	if err != nil {
		return err
	}
	return r.doc.Upsert(snippetsKind, "all", data)
}

func (r *snippetRepo) List() ([]Snippet, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	snippets, err := r.load()
	if err != nil {
		return nil, err
	}
	sort.Slice(snippets, func(i, j int) bool { return snippets[i].Title < snippets[j].Title })
	return snippets, nil
}

func (r *snippetRepo) Create(input Snippet) (*Snippet, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	snippets, err := r.load()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	s := Snippet{
		ID:          "sc_snip_" + uuid.New().String(),
		Title:       input.Title,
		Command:     input.Command,
		Description: input.Description,
		Tags:        input.Tags,
		Scope:       input.Scope,
		ScopeID:     input.ScopeID,
		Kind:        NormalizeSnippetKind(input.Kind),
		Language:    input.Language,
		IsSystem:    false, // 用户创建一律非系统片段
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if s.Scope == "" {
		s.Scope = "global"
	}
	snippets = append(snippets, s)
	if err := r.save(snippets); err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *snippetRepo) Update(id string, patch Snippet) (*Snippet, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	snippets, err := r.load()
	if err != nil {
		return nil, err
	}
	for i := range snippets {
		if snippets[i].ID != id {
			continue
		}
		// 系统片段允许编辑内容（改出副本效果）但不改变 IsSystem 身份与 ID
		if patch.Title != "" {
			snippets[i].Title = patch.Title
		}
		if patch.Command != "" {
			snippets[i].Command = patch.Command
		}
		if patch.Description != "" {
			snippets[i].Description = patch.Description
		}
		if patch.Tags != nil {
			snippets[i].Tags = patch.Tags
		}
		if patch.Scope != "" {
			snippets[i].Scope = patch.Scope
		}
		// Kind/Language：Kind 仅接受白名单值（未知值视为「未提供该字段」不改写，
		// 防止 patch 误传把 code 片段静默降级成 command）；Language 空值不改（
		// 与 Title/Command 同语义——patch 为空字段表示「不更新该字段」）
		if patch.Kind == SnippetKindCommand || patch.Kind == SnippetKindCode {
			snippets[i].Kind = patch.Kind
		}
		if patch.Language != "" {
			snippets[i].Language = patch.Language
		}
		snippets[i].UpdatedAt = time.Now()
		if err := r.save(snippets); err != nil {
			return nil, err
		}
		out := snippets[i]
		return &out, nil
	}
	return nil, ErrNotFound
}

func (r *snippetRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	snippets, err := r.load()
	if err != nil {
		return err
	}
	out := snippets[:0]
	found := false
	for _, s := range snippets {
		if s.ID == id {
			found = true
			if s.IsSystem {
				return ErrSystemSnippet // 系统片段不可删除
			}
			continue
		}
		out = append(out, s)
	}
	if !found {
		return ErrNotFound
	}
	return r.save(out)
}
