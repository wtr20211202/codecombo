package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// ClaudeIndexStore Claude Code 本地会话的可重建索引（车道 3 加速，
// 见 docs/PERSISTENCE_LANES.md 车道 3：~/.claude/projects 是外部工具的
// 数据，以对等身份只读消费；本索引是其列表元数据的镜像——损坏或删除后
// 可全量重建，绝不成为唯一副本）。
//
// kind "claudeindex"，键 = <rootHash>__<dirHash>__<会话ID>（全 hex 安全段，
// 规避编码目录名里的 '.'/'..' 触发键黑名单），root/dir 原文存文档体内。
// rootHash 隔离不同存储根（SC_CLAUDE_DIR 测试覆盖切换时互不污染）。
type ClaudeIndexStore interface {
	// Put 写入/覆盖一条索引（对账时新文件或变更文件）
	Put(e ClaudeIndexEntry) error
	// GetBatch prefix 下全部条目（key → entry）
	GetBatch(prefix string) (map[string]ClaudeIndexEntry, error)
	// Delete 删除一条索引（源文件消失时对账清除）
	Delete(key string) error
	// Count 条目总数（诊断/测试用）
	Count() (int, error)
}

// ClaudeIndexEntry 一条会话的列表元数据（claudesessions.Session 的持久化
// 形态；Mtime/MtimeNs 用于变更检测——stat 到 mtime 变化才重读文件内容）。
// Usage* 为 token 用量聚合（P-20261002-139）的镜像；UsageKnown 标记条目
// 是否做过 usage 聚合扫描——历史上写入的旧条目无此标记，命中判定额外
// 要求该标记，升级后首次列表对旧条目一次性重扫补齐，此后恢复零内容读
type ClaudeIndexEntry struct {
	Key          string    `json:"-"`
	ID           string    `json:"id"`
	Dir          string    `json:"dir"` // claude projects 下的编码目录名
	Title        string    `json:"title"`
	Cwd          string    `json:"cwd,omitempty"`
	FirstAt      time.Time `json:"firstAt"`
	LastAt       time.Time `json:"lastAt"`
	MessageCount int       `json:"messageCount"`
	SizeBytes    int64     `json:"sizeBytes"`
	MtimeNs      int64     `json:"mtimeNs"`

	UsageKnown     bool  `json:"usageKnown"`               // 已做过 usage 聚合扫描（旧版条目 false → 未命中重扫）
	UsageInput     int64 `json:"usageInput,omitempty"`     // input 累计
	UsageOutput    int64 `json:"usageOutput,omitempty"`    // output 累计
	UsageCacheRead int64 `json:"usageCacheRead,omitempty"` // cache_read 累计
	UsageTotal     int64 `json:"usageTotal,omitempty"`     // 总量（= input+output+cache_read，列表展示值）

	// 结构化台账聚合（P-20261005-208，claudesessions/ledger.go）镜像；同
	// UsageKnown 升级标记——旧条目 LedgerKnown false → 命中判定未命中，升级后
	// 首次列表一次性重扫补齐（幂等，无迁移脚本）
	LedgerKnown      bool  `json:"ledgerKnown"`                // 已做过台账聚合扫描
	LedgerFiles      int   `json:"ledgerFiles,omitempty"`      // 写文件去重数
	LedgerCommands   int   `json:"ledgerCommands,omitempty"`   // shell 命令次数
	LedgerDurationMs int64 `json:"ledgerDurationMs,omitempty"` // 首尾工具活动跨时
}

type claudeIndexRepo struct{ doc DocumentStore }

func newClaudeIndexRepo(doc DocumentStore) *claudeIndexRepo { return &claudeIndexRepo{doc: doc} }

const claudeIndexKind = "claudeindex"

// ClaudeIndexKey 组合键：<rootHash8>__<dirHash12>__<会话ID>
func ClaudeIndexKey(root, dir, sessionID string) string {
	rh := sha256.Sum256([]byte(root))
	dh := sha256.Sum256([]byte(dir))
	return fmt.Sprintf("%s__%s__%s", hex.EncodeToString(rh[:4]), hex.EncodeToString(dh[:6]), sessionID)
}

// ClaudeIndexPrefix 某 root（可选叠加某 dir）下全部条目的键前缀
func ClaudeIndexPrefix(root, dir string) string {
	rh := sha256.Sum256([]byte(root))
	if dir == "" {
		return hex.EncodeToString(rh[:4]) + "__"
	}
	dh := sha256.Sum256([]byte(dir))
	return hex.EncodeToString(rh[:4]) + "__" + hex.EncodeToString(dh[:6]) + "__"
}

func (r *claudeIndexRepo) Put(e ClaudeIndexEntry) error {
	if e.Key == "" {
		return ErrInvalidArg
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return r.doc.Upsert(claudeIndexKind, e.Key, b)
}

func (r *claudeIndexRepo) GetBatch(prefix string) (map[string]ClaudeIndexEntry, error) {
	keys, _, err := r.doc.List(claudeIndexKind, ListOpts{Prefix: prefix})
	if err != nil {
		return nil, err
	}
	raw, err := r.doc.GetBatch(claudeIndexKind, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ClaudeIndexEntry, len(raw))
	for k, b := range raw {
		var e ClaudeIndexEntry
		if json.Unmarshal(b, &e) == nil {
			e.Key = k
			out[k] = e
		}
	}
	return out, nil
}

func (r *claudeIndexRepo) Delete(key string) error {
	return r.doc.Delete(claudeIndexKind, key)
}

func (r *claudeIndexRepo) Count() (int, error) {
	return r.doc.Count(claudeIndexKind, ListOpts{})
}
