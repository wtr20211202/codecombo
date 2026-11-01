package store

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"codecombo/server/errmarkers"
)

// 智能体会话排队指令（P-20261003-248）：agent 运行中想到的新指令先排队，
// 完成回执（task.progress done/failed）命中后由 api/terminal 的队列引擎依次
// 写入会话 PTY——连续指令流不打断、不抢跑。
//
// 独立 kind（agentsessionqueue）而非并入 AgentSessionMeta 文档：创建链的
// saveAgentSessionMeta 是异步整文档 Save（api/terminal/terminal.go），队列若
// 同文档共存，创建早期的 upsert 会把刚排入的指令整段覆写丢掉——按域拆文档，
// 各写各的键，竞态面即不存在。会话关闭时删除（CloseTerminal 同 meta 生命周期）。

// AgentQueueMaxItems 单会话排队上限：排队是「下一步计划」不是待办箱——
// 超出说明用户该先处理失败/结果再排，硬上限防无界增长
const AgentQueueMaxItems = 5

// AgentQueueItemMaxRunes 单条指令上限（rune）：一句话到一小段任务描述的
// 量级；写终端走 PTY 逐字节回显，超长指令更适合直接开新会话
const AgentQueueItemMaxRunes = 2000

// ErrQueueFull / ErrQueueInvalid 排队校验错误（handler 映射 409/400；错误
// 原文是稳定标记，前端 KNOWN_ERROR_I18N 按原文映射双语——改措辞须两侧同步）。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29）
var (
	ErrQueueFull    = errors.New(errmarkers.QueueFull)
	ErrQueueInvalid = errors.New(errmarkers.QueueInvalid)
)

// AgentQueuedItem 一条排队指令
type AgentQueuedItem struct {
	Text     string    `json:"text"`
	QueuedAt time.Time `json:"queuedAt"`
}

// AgentSessionQueue 单会话的排队指令队列（一会话一文档）
type AgentSessionQueue struct {
	SessionID string            `json:"sessionID"`
	Items     []AgentQueuedItem `json:"items"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

type AgentSessionQueueStore interface {
	Get(sessionID string) (*AgentSessionQueue, error) // 不存在返回 (nil, nil)
	Append(sessionID, text string) (*AgentSessionQueue, error)
	Replace(sessionID string, texts []string) (*AgentSessionQueue, error)
	PopHead(sessionID string) (AgentQueuedItem, bool, error)
	Delete(sessionID string) error
	List() ([]AgentSessionQueue, error)
}

type agentSessionQueueRepo struct {
	doc DocumentStore
	mu  sync.Mutex // Append/Replace/PopHead 是读-改-写三段——repo 内互斥串行化，
	// 防并发排队丢条目（UIStateStore.Merge 同款先例；filestore 锁只盖单次磁盘操作）
}

func newAgentSessionQueueRepo(doc DocumentStore) *agentSessionQueueRepo {
	return &agentSessionQueueRepo{doc: doc}
}

const agentSessionQueueKind = "agentsessionqueue"

// sanitizeInstruction 指令规整：控制字符（含换行）折叠为空格——排队指令按
// 单行语义写终端（换行会让 TUI 提前提交半条指令），trim 后校验非空与长度
func sanitizeInstruction(text string) (string, error) {
	cleaned := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text))
	if cleaned == "" || utf8.RuneCountInString(cleaned) > AgentQueueItemMaxRunes {
		return "", ErrQueueInvalid
	}
	return cleaned, nil
}

func (r *agentSessionQueueRepo) Get(sessionID string) (*AgentSessionQueue, error) {
	b, err := r.doc.Get(agentSessionQueueKind, sessionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var q AgentSessionQueue
	if err := json.Unmarshal(b, &q); err != nil {
		return nil, err
	}
	return &q, nil
}

// save 写入（调用方持 r.mu）
func (r *agentSessionQueueRepo) save(q *AgentSessionQueue) error {
	q.UpdatedAt = time.Now()
	b, err := json.Marshal(q)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentSessionQueueKind, q.SessionID, b)
}

// Append 排队入尾（满则 ErrQueueFull，原队列不动）
func (r *agentSessionQueueRepo) Append(sessionID, text string) (*AgentSessionQueue, error) {
	cleaned, err := sanitizeInstruction(text)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	q, err := r.Get(sessionID)
	if err != nil {
		return nil, err
	}
	if q == nil {
		q = &AgentSessionQueue{SessionID: sessionID}
	}
	if len(q.Items) >= AgentQueueMaxItems {
		return nil, ErrQueueFull
	}
	q.Items = append(q.Items, AgentQueuedItem{Text: cleaned, QueuedAt: time.Now()})
	if err := r.save(q); err != nil {
		return nil, err
	}
	return q, nil
}

// Replace 整表替换（编辑/删除/重排共用单一写口；上限与单条规整同 Append）
func (r *agentSessionQueueRepo) Replace(sessionID string, texts []string) (*AgentSessionQueue, error) {
	if len(texts) > AgentQueueMaxItems {
		return nil, ErrQueueFull
	}
	items := make([]AgentQueuedItem, 0, len(texts))
	for _, t := range texts {
		cleaned, err := sanitizeInstruction(t)
		if err != nil {
			return nil, err
		}
		items = append(items, AgentQueuedItem{Text: cleaned, QueuedAt: time.Now()})
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	q := &AgentSessionQueue{SessionID: sessionID, Items: items}
	if len(items) == 0 {
		// 空表 = 清空语义：删文档而非存空 items（Get 返回 nil,nil 口径一致）
		if err := r.doc.Delete(agentSessionQueueKind, sessionID); err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		return q, nil
	}
	if err := r.save(q); err != nil {
		return nil, err
	}
	return q, nil
}

// PopHead 弹出队首（发送成功后由队列引擎调用；空队列返回 ok=false）
func (r *agentSessionQueueRepo) PopHead(sessionID string) (AgentQueuedItem, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	q, err := r.Get(sessionID)
	if err != nil || q == nil || len(q.Items) == 0 {
		return AgentQueuedItem{}, false, err
	}
	head := q.Items[0]
	q.Items = q.Items[1:]
	if len(q.Items) == 0 {
		if err := r.doc.Delete(agentSessionQueueKind, sessionID); err != nil && !errors.Is(err, ErrNotFound) {
			return head, false, err
		}
		return head, true, nil
	}
	if err := r.save(q); err != nil {
		return head, false, err
	}
	return head, true, nil
}

// Delete 删除会话队列（幂等：不存在视同已删——CloseTerminal 清账路径不关心先后）
func (r *agentSessionQueueRepo) Delete(sessionID string) error {
	if err := r.doc.Delete(agentSessionQueueKind, sessionID); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (r *agentSessionQueueRepo) List() ([]AgentSessionQueue, error) {
	keys, _, err := r.doc.List(agentSessionQueueKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentSessionQueue, 0, len(keys))
	for _, k := range keys {
		if q, err := r.Get(k); err == nil && q != nil {
			out = append(out, *q)
		}
	}
	return out, nil
}
