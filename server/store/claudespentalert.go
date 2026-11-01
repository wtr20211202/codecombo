package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

// ClaudeSpendAlert Claude 会话花费阈值告警的已通知标记（P-20261003-157）：
// P-20261002-139 用量聚合命中会话级阈值（notification prefs
// claudeSpendAlertTokens，默认 0=关）时入账一条通知——本 kind 记「哪个会话
// 已经通知过」，防同一会话在后续每次列表请求都重复告警（阈值判定是 ≥ 语义，
// 超阈后会话总量只会继续增长，无标记位则每次列表都命中）。
//
// 车道归属（docs/PERSISTENCE_LANES.md）：kind "claudespentalert"，车道 1。
// 不能进 claudeindex：那是车道 3 可重建镜像（stat 对账即整条重建），标记入其
// 必丢（重建即重复告警）；不能进 claudecur：那是用户自域策展数据（星标/备注/
// 隐藏），机器状态混入会让「清策展」连带丢防重位。
//
// 与 claudecur 同款键设计：<rootHash8>__<会话UUID>——rootHash 与 claudeindex
// 同源（SC_CLAUDE_DIR 覆盖切换互不污染）；会话 UUID 在一个存储根内即唯一。
// 键控 upsert 非追加型，但条目由机器自动累积（每个超阈会话一条）而非用户手动，
// 长运行仍会无界——按 NotifiedAt FIFO 封顶裁剪（Put 内收口），与 notifications
// 上限裁剪同惯例。
type ClaudeSpendAlert struct {
	Key string `json:"-"`
	// ID 会话 UUID（transcript 文件名去 .jsonl）
	ID string `json:"id"`
	// Threshold 触发告警时的阈值快照（对账用：阈值改大后已告警会话不重发——
	// 「一次」语义锚定会话而非阈值档位）
	Threshold  int       `json:"threshold"`
	NotifiedAt time.Time `json:"notifiedAt"`
}

type ClaudeSpendAlertStore interface {
	// Put 写入标记（超出 claudeSpendAlertMax 时按 NotifiedAt FIFO 裁剪最旧）
	Put(a ClaudeSpendAlert) error
	// GetBatch prefix 下全部标记（key → entry）
	GetBatch(prefix string) (map[string]ClaudeSpendAlert, error)
	// Delete 删除一条标记
	Delete(key string) error
	// Count 条目总数（诊断/测试用）
	Count() (int, error)
}

// claudeSpendAlertMax 标记条目上限：单条 ~150B，500 条封顶即 ~75KB 落盘；
// 被裁掉的旧标记后果 = 该会话若仍在阈值之上，下次列表重发一条告警（可接受
// 的最旧失忆语义，与通知中心 200 条封顶同取舍方向）
const claudeSpendAlertMax = 500

type claudeSpendAlertRepo struct{ doc DocumentStore }

func newClaudeSpendAlertRepo(doc DocumentStore) *claudeSpendAlertRepo {
	return &claudeSpendAlertRepo{doc: doc}
}

const claudeSpendAlertKind = "claudespentalert"

// ClaudeSpendAlertKey 组合键：<rootHash8>__<会话UUID>（claudecur 同款）
func ClaudeSpendAlertKey(root, sessionID string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__" + sessionID
}

// ClaudeSpendAlertPrefix 某存储根下全部标记的键前缀
func ClaudeSpendAlertPrefix(root string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__"
}

func (r *claudeSpendAlertRepo) Put(a ClaudeSpendAlert) error {
	if a.Key == "" || a.ID == "" {
		return ErrInvalidArg
	}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if has, _ := r.doc.Has(claudeSpendAlertKind, a.Key); has {
		return r.doc.Update(claudeSpendAlertKind, a.Key, b)
	}
	if err := r.doc.Create(claudeSpendAlertKind, a.Key, b); err != nil {
		return err
	}
	return r.trim()
}

// trim FIFO 封顶：超出 claudeSpendAlertMax 裁 NotifiedAt 最旧的条目。
// 尽力而为（读失败跳过本轮裁剪，上界只是缓增不是正确性依赖）
func (r *claudeSpendAlertRepo) trim() error {
	all, err := r.GetBatch("")
	if err != nil || len(all) <= claudeSpendAlertMax {
		return err
	}
	entries := make([]ClaudeSpendAlert, 0, len(all))
	for k, e := range all {
		e.Key = k
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].NotifiedAt.Before(entries[j].NotifiedAt) })
	for _, e := range entries[:len(all)-claudeSpendAlertMax] {
		_ = r.Delete(e.Key)
	}
	return nil
}

func (r *claudeSpendAlertRepo) GetBatch(prefix string) (map[string]ClaudeSpendAlert, error) {
	keys, _, err := r.doc.List(claudeSpendAlertKind, ListOpts{Prefix: prefix})
	if err != nil {
		return nil, err
	}
	raw, err := r.doc.GetBatch(claudeSpendAlertKind, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ClaudeSpendAlert, len(raw))
	for k, b := range raw {
		var a ClaudeSpendAlert
		if json.Unmarshal(b, &a) == nil {
			a.Key = k
			out[k] = a
		}
	}
	return out, nil
}

func (r *claudeSpendAlertRepo) Delete(key string) error {
	return r.doc.Delete(claudeSpendAlertKind, key)
}

func (r *claudeSpendAlertRepo) Count() (int, error) {
	return r.doc.Count(claudeSpendAlertKind, ListOpts{})
}
