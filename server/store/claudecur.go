package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// ClaudeSessionCur Claude 会话人工策展元数据（P-20261003-67 历史策展层）：
// 星标（反复要看的会话置顶、别按时间沉底）+ 一句人话备注（比全文检索更快的
// 召回锚点）+ 隐藏（P-20261003-112 会话清理的安全形态——索引层移除，transcript
// 文件零触碰，随时可恢复）。检索/命名/用量之外的第三面——人工策展。
//
// 车道归属（docs/PERSISTENCE_LANES.md）：kind "claudecur"，车道 1 用户自域
// 数据（唯一副本，不可重建）。为什么不进 claudeindex：那是车道 3 加速镜像
// （mtime/size 对账即整条重建、消失文件即删），策展数据入其必丢；为什么不进
// agentsessionmeta：那是终端会话元数据（键=终端 ID、关闭即删、启动期清孤儿），
// 与 transcript UUID 不同域。键 = <rootHash8>__<会话UUID>，rootHash 与
// claudeindex 同款（SC_CLAUDE_DIR 测试覆盖切换互不污染）。
//
// transcript 消失后孤儿条目无害：列表/搜索按「存活会话 ∩ 策展」消费（ vanished
// 的策展不产生幽灵命中，见 claudesessions/curation.go），保留即支持同 id
// transcript 重建（claude --resume 续写新文件）后策展自动跟回。数量上界 =
// 用户手动策展过的会话数（键控 upsert，非追加型），无需保留策略。
type ClaudeSessionCur struct {
	Key     string `json:"-"`
	ID      string `json:"id"` // 会话 UUID（transcript 文件名去 .jsonl）
	Starred bool   `json:"starred,omitempty"`
	Note    string `json:"note,omitempty"` // ≤ NoteMaxRunes rune，Put 时钳制
	Hidden  bool   `json:"hidden,omitempty"`
	// Bookmarks 轮级书签（P-20261003-122 回放时间线书签）：星标的 assistant 轮
	// 时刻（RFC3339，timeline 条目的 At 原串）升序去重集——回读策展件，「这轮
	// 结论重要，回放顶部清单直达」。仍是一会话一文档的键控 upsert（数量上限
	// BookmarkMax，Put 时钳制），不另立 kind：与星标/备注同属一次会话的人工
	// 策展，同键读写免去跨文档一致性问题
	Bookmarks []string `json:"bookmarks,omitempty"`
	// Tags 轮级语义标签（P-20261003-256 回放轮级语义标签）：(轮时刻, 标签名) 对
	// 的集合——书签=位置（这轮重要），标签=语义（这轮讲什么主题），长回放主
	// 题导航的互补面。存储形态沿书签先例（一会话一文档键控 upsert、Put 唯一
	// 出口钳制，上限 TagMax），不另立 kind；标签名经 NormalizeTag 消毒（trim+
	// 剥前导 #），集合按 (At,Tag) 排序去重（ClampTags）
	Tags      []ClaudeTurnTag `json:"tags,omitempty"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// ClaudeTurnTag 单个轮级语义标签：(轮时刻, 标签名) 对。At 为 timeline 条目的
// RFC3339 原串（书签同款逻辑键，时区偏移形态原样保留）；Tag 为用户自拟的短
// 主题名（NormalizeTag 消毒后形态）
type ClaudeTurnTag struct {
	At  string `json:"at"`
	Tag string `json:"tag"`
}

type ClaudeSessionCurStore interface {
	// Put 写入/覆盖一条策展（note 超 rune 上限静默钳制，前端 maxlength 先行）
	Put(c ClaudeSessionCur) error
	// GetBatch prefix 下全部条目（key → entry）
	GetBatch(prefix string) (map[string]ClaudeSessionCur, error)
	// Delete 删除一条策展（星标+备注双双清空后由调用方收尾清理）
	Delete(key string) error
	// Count 条目总数（诊断/测试用）
	Count() (int, error)
}

// NoteMaxRunes 备注长度上限（rune）：一句人话备注的量级约束（提案口径 ≤200）
const NoteMaxRunes = 200

// BookmarkMax 单会话轮级书签上限：书签是人工策展动作（点星产生），数百量级
// 已远超真实策展节奏——防御性上限防病态客户端把单文档撑爆，与 NoteMaxRunes
// 同一「Put 唯一出口静默钳制」家族
const BookmarkMax = 200

// TagMax 单会话轮级标签上限（(轮,标签) 对数）：与 BookmarkMax 同族的防御性
// 上限（人工策展量级远低于此），防病态客户端把单文档撑爆
const TagMax = 200

// TagMaxRunes 单个标签名长度上限（rune）：标签是短主题词（#架构/#修复 量级），
// 不是备注——超长输入视为误用，端点 400 拒绝而非静默截断（截断出的残词标签
// 与用户意图不符，且与既有标签撞名后过滤语义失真）
const TagMaxRunes = 32

// ClampNote 备注钳制：按 rune 截到 NoteMaxRunes（中文不截半字，无省略号——
// 备注是用户自写文本，硬截即可；保存端点与 repo.Put 共用此唯一出口）
func ClampNote(s string) string {
	if utf8.RuneCountInString(s) <= NoteMaxRunes {
		return s
	}
	return string([]rune(s)[:NoteMaxRunes])
}

// NormalizeTag 标签名消毒：剥首尾空白与前导 #（hashtag 输入惯例，#架构 与
// 架构 同名）；内部空白原样保留。返回空串 = 无效标签（调用方拒绝）
func NormalizeTag(s string) string {
	return strings.TrimLeft(strings.TrimSpace(s), "#")
}

// ClampTags 标签集钳制：剔空 + (At,Tag) 精确去重 + 按 (At,Tag) 排序（同轮标签
// 相邻、集合形态确定）+ 超 TagMax 保最新（按 At 字典序靠后的轮次，书签同款
// 「保最新」语义；RFC3339 串的字典序即时间序，混合时区偏移形态时退化为近似
// ——书签同口径，不为此引入逐条时间解析）。保存端点与 repo.Put 共用此唯一出口
func ClampTags(list []ClaudeTurnTag) []ClaudeTurnTag {
	if len(list) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(list))
	out := make([]ClaudeTurnTag, 0, len(list))
	for _, p := range list {
		if p.At == "" || p.Tag == "" {
			continue
		}
		k := p.At + "\x00" + p.Tag
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At < out[j].At
		}
		return out[i].Tag < out[j].Tag
	})
	if len(out) > TagMax {
		out = out[len(out)-TagMax:]
	}
	return out
}

// ClampBookmarks 书签集钳制：去重 + 升序排序（RFC3339 同格式串的字典序即时间
// 序）+ 超 BookmarkMax 保最新（时间线上靠后的轮次）。集合语义键控 upsert，
// 非追加型 kind，无保留策略义务；保存端点与 repo.Put 共用此唯一出口
func ClampBookmarks(list []string) []string {
	if len(list) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(list))
	out := make([]string, 0, len(list))
	for _, at := range list {
		if at == "" {
			continue
		}
		if _, dup := seen[at]; dup {
			continue
		}
		seen[at] = struct{}{}
		out = append(out, at)
	}
	sort.Strings(out)
	if len(out) > BookmarkMax {
		out = out[len(out)-BookmarkMax:]
	}
	return out
}

type claudeCurRepo struct{ doc DocumentStore }

func newClaudeCurRepo(doc DocumentStore) *claudeCurRepo { return &claudeCurRepo{doc: doc} }

const claudeCurKind = "claudecur"

// ClaudeCurKey 组合键：<rootHash8>__<会话UUID>（会话 UUID 在一个存储根内即唯一
// ——transcript 文件名；rootHash 与 claudeindex 同款隔离 SC_CLAUDE_DIR 覆盖）
func ClaudeCurKey(root, sessionID string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__" + sessionID
}

// ClaudeCurPrefix 某存储根下全部策展条目的键前缀
func ClaudeCurPrefix(root string) string {
	rh := sha256.Sum256([]byte(root))
	return hex.EncodeToString(rh[:4]) + "__"
}

func (r *claudeCurRepo) Put(c ClaudeSessionCur) error {
	if c.Key == "" || c.ID == "" {
		return ErrInvalidArg
	}
	c.Note = ClampNote(c.Note)
	c.Bookmarks = ClampBookmarks(c.Bookmarks)
	c.Tags = ClampTags(c.Tags)
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return r.doc.Upsert(claudeCurKind, c.Key, b)
}

func (r *claudeCurRepo) GetBatch(prefix string) (map[string]ClaudeSessionCur, error) {
	keys, _, err := r.doc.List(claudeCurKind, ListOpts{Prefix: prefix})
	if err != nil {
		return nil, err
	}
	raw, err := r.doc.GetBatch(claudeCurKind, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ClaudeSessionCur, len(raw))
	for k, b := range raw {
		var c ClaudeSessionCur
		if json.Unmarshal(b, &c) == nil {
			c.Key = k
			out[k] = c
		}
	}
	return out, nil
}

func (r *claudeCurRepo) Delete(key string) error {
	return r.doc.Delete(claudeCurKind, key)
}

func (r *claudeCurRepo) Count() (int, error) {
	return r.doc.Count(claudeCurKind, ListOpts{})
}
