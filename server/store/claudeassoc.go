package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// ClaudeSessionAssoc Codecombo 终端 ↔ Claude transcript 会话的拉起关联
//（P-20261031-1）：Codecombo 以 `claude --resume <id>` 拉起会话时落一条
// 「该 transcript 会话由本实例管理」的记录，供会话列表把 Active 判定从
// mtime 启发式升级为终端存活精确事实——
//   - 关联终端仍存活 → 活跃（长思考无 transcript 追加也不再误判非活跃）；
//   - 关联终端已关闭 → claude 进程随 PTY 关闭即死，立即翻非活跃（零延迟，
//     用户关闭终端后马上可恢复，不再被最长 5 分钟的僵尸「进行中」挡住）。
//
// 车道归属（docs/PERSISTENCE_LANES.md）：kind "claudeassoc"，车道 1 应用
// 拥有的关联实体。为什么独立 kind 而不进 agentsessionmeta：后者键=终端 ID
// 且关闭即删（terminal.go DeleteTerminal）/ 启动期清孤儿（pruneStaleSessionMeta
// 只留 Named），恰在「终端已关、需要事后知道曾拉起过谁」的时刻消失——本
// kind 以 transcript 会话 UUID 为键，生命周期跟 transcript 走。为什么不进
// claudeindex：那是车道 3 可重建镜像（mtime/size 对账即整条重建），关联事实
// 入其必丢；为什么不进 claudecur：那是用户人工策展自域，系统事实混入会污染
// 「用户标记过什么」的语义。
//
// 数量上界与保留策略：键控 upsert（一会话一文档，重复恢复同 id 覆盖旧终端），
// 非追加型；列表端点实时校正时对「终端已死且 LaunchedAt 超 assocTTL」的条目
// 尽力 GC（多实例/外部 claude 写同一 transcript 的世界态无法感知，90s 窄窗
// 兜底），稳态存量 = 近 30 天被恢复过的会话数，无需额外 TTL 后台任务。
type ClaudeSessionAssoc struct {
	Key string `json:"-"`
	// ID transcript 会话 UUID（claude --resume 的目标 id）
	ID string `json:"id"`
	// TerminalID 拉起它的终端会话 id（agent-<unixnano>；诊断可读，判定只用
	// 「当前活终端注册表」实时对账，不依赖本字段时效）
	TerminalID string `json:"terminalId"`
	// LaunchedAt 最近一次拉起时刻（GC 时效锚点；重复恢复 upsert 刷新）
	LaunchedAt time.Time `json:"launchedAt"`
}

type ClaudeSessionAssocStore interface {
	// Put 写入/覆盖一条关联（恢复链重复恢复同会话 = upsert 刷新）
	Put(a ClaudeSessionAssoc) error
	// GetBatch prefix 下全部条目（key → entry）
	GetBatch(prefix string) (map[string]ClaudeSessionAssoc, error)
	// Delete GC 一条过期关联
	Delete(key string) error
}

type claudeAssocRepo struct{ doc DocumentStore }

func newClaudeAssocRepo(doc DocumentStore) *claudeAssocRepo { return &claudeAssocRepo{doc: doc} }

const claudeAssocKind = "claudeassoc"

// ClaudeAssocKey 组合键：<rootHash8>__<会话UUID>。rootHash 与 claudeindex/
// claudecur 同款隔离 SC_CLAUDE_DIR/CC_CLAUDE_DIR 覆盖（e2e 多根互不污染）；
// 会话 UUID 在一个存储根内即唯一（transcript 文件名）
func ClaudeAssocKey(root, sessionID string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__" + sessionID
}

// ClaudeAssocPrefix 某存储根下全部关联条目的键前缀
func ClaudeAssocPrefix(root string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__"
}

func (r *claudeAssocRepo) Put(a ClaudeSessionAssoc) error {
	if a.Key == "" || a.ID == "" {
		return ErrInvalidArg
	}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return r.doc.Upsert(claudeAssocKind, a.Key, b)
}

func (r *claudeAssocRepo) GetBatch(prefix string) (map[string]ClaudeSessionAssoc, error) {
	keys, _, err := r.doc.List(claudeAssocKind, ListOpts{Prefix: prefix})
	if err != nil {
		return nil, err
	}
	raw, err := r.doc.GetBatch(claudeAssocKind, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ClaudeSessionAssoc, len(raw))
	for k, b := range raw {
		var a ClaudeSessionAssoc
		if json.Unmarshal(b, &a) == nil {
			a.Key = k
			out[k] = a
		}
	}
	return out, nil
}

func (r *claudeAssocRepo) Delete(key string) error {
	return r.doc.Delete(claudeAssocKind, key)
}
