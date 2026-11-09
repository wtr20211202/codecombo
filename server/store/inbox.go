package store

import (
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"
)

// 会话收件箱（P-20261004-68）：agent 间定向消息——「会话 A 发现了会话 B 需要
// 的信息（配置在 X / 测试套件 Y 在抖别误判 / 我改了 Z 你别动）」的定点投递层。
// 与笔记库（notesmulti，P-20261108-3 单库化后项目无关）分工：笔记 = 共享持久层
// （所有人可见、无地址性），消息 = 定向瞬态层（有地址、拉取即读、24h 过期即焚）。
//
// 车道 1（可查询实体）：一会话一文档，kind=inbox，键 = 目标会话 ID
//（CC_TERMINAL_ID 同一命名空间）。瞬态语义由保留策略承担：单会话环形 20 条
// 裁最旧 + 单条 TTL 24h（Append/Take 惰性剪枝）+ 文档级 CleanupBefore 巡检口
//（模块小时级 ticker 兜底）。目标会话关闭后的无主收件箱**不做级联清理**
//（提案修正项：随 TTL 自然过期即可，避免碰 CloseTerminal 热路径）。
type InboxMessage struct {
	// ID 消息标识（msg-<unixnano>；同会话并发投递由 repo 锁串行，同时刻
	// 不会重复；agent 侧可用于去重/引用）
	ID string `json:"id"`
	// From 发送方会话 ID（POST 调用方的 X-Session-ID 头，CC_TERMINAL_ID
	// 同一命名空间；定向消息必须有发送方地址，接收方才知道找谁核对）
	From string `json:"from"`
	// Body 消息正文（≤2KB UTF-8，上限在发布口校验——store 信任已规整输入）
	Body string `json:"body"`
	// At 投递时刻
	At time.Time `json:"at"`
	// Read 已读标记（拉取即读：Take 返回即置位；环形窗口内保留供对账，
	// 再拉取不再出现）
	Read bool `json:"read"`
}

// SessionInbox 单会话收件箱（一会话一文档）
type SessionInbox struct {
	SessionID string         `json:"sessionID"`
	Messages  []InboxMessage `json:"messages"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// InboxStore 会话收件箱存储
type InboxStore interface {
	// Append 投递一条消息（容量满裁最旧、过期条目顺带剪枝），返回投递后的收件箱
	Append(sessionID, from, body string, at time.Time) (*SessionInbox, error)
	// Take 拉取即读（drain 语义）：返回全部未读消息（投递序，旧→新）并就地
	// 标记已读持久化——再次拉取返回空，agent 无需自记游标。无收件箱返回 (nil, nil)
	Take(sessionID string, at time.Time) ([]InboxMessage, error)
	// Get 收件箱现状（含已读；不存在返回 (nil, nil)）
	Get(sessionID string) (*SessionInbox, error)
	// Delete 删除会话收件箱（幂等；预留显式清理口，当前无调用方挂接——
	// 会话关闭不级联清理，见文件头注记）
	Delete(sessionID string) error
	// CleanupBefore 删除最近消息早于 before 的整个收件箱文档（无主收件箱
	// TTL 巡检口），返回删除数
	CleanupBefore(before time.Time) (int, error)
}

const inboxKind = "inbox"

// InboxKeepMax 单会话收件箱容量上限（环形裁最旧）：收件箱是「最近的定向
// 留言」不是档案柜——agent 会话生命周期内的高频协作量级；上限即保留策略
//（append 型 kind 同 PR 带保留策略的三车道义务），20 条与排队指令 5 条、
// 链定义 50 条同一量级思考
const InboxKeepMax = 20

// InboxTTL 单条消息存活窗口：瞬态层的过期语义——跨会话协作信息在会话存续
// 期有效（会话消亡后收件箱无主），24h 足够覆盖「投递时目标会话临时不在/重启」
// 的补拉窗口，又不至于把未读留言变成永久堆积
const InboxTTL = 24 * time.Hour

// ErrInboxInvalid 收件箱输入校验错误（handler 侧另有字节上限与稳定错误码，
// 此为 store 层对空投递的最后防线）
var ErrInboxInvalid = errors.New("inbox: empty session or message")

type inboxRepo struct {
	mu  sync.Mutex // Append/Take 是读-改-写三段——repo 内互斥串行化，防并发
	// 投递/拉取丢条目（AgentSessionQueue 同款先例；filestore 锁只盖单次磁盘操作）
	doc DocumentStore
}

func newInboxRepo(doc DocumentStore) *inboxRepo {
	return &inboxRepo{doc: doc}
}

// NewInboxMessageID 消息 ID 生成（msg-<unixnano>，chain- 同款形态；拆出便于
// 测试固定时刻）
func NewInboxMessageID(now time.Time) string {
	return "msg-" + strconv.FormatInt(now.UnixNano(), 10)
}

func (r *inboxRepo) Get(sessionID string) (*SessionInbox, error) {
	b, err := r.doc.Get(inboxKind, sessionID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var in SessionInbox
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, err
	}
	return &in, nil
}

// save 写入（调用方持 r.mu）
func (r *inboxRepo) save(in *SessionInbox) error {
	in.UpdatedAt = time.Now()
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return r.doc.Upsert(inboxKind, in.SessionID, b)
}

// pruneInboxLocked 惰性剪枝（锁内调用）：剪掉过期条目（At 早于 now-TTL）。容量
// 裁剪在 Append 追加后单独做——两条保留策略各管一面：TTL 管「多旧算失效」，
// 环形上限管「最多留几条」，过期剪枝先行可保住未读消息不被容量逐出
func pruneInboxLocked(in *SessionInbox, now time.Time) {
	cutoff := now.Add(-InboxTTL)
	kept := in.Messages[:0:0]
	for _, m := range in.Messages {
		if m.At.Before(cutoff) {
			continue
		}
		kept = append(kept, m)
	}
	in.Messages = kept
}

func (r *inboxRepo) Append(sessionID, from, body string, at time.Time) (*SessionInbox, error) {
	if sessionID == "" || body == "" {
		return nil, ErrInboxInvalid
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	in, err := r.Get(sessionID)
	if err != nil {
		return nil, err
	}
	if in == nil {
		in = &SessionInbox{SessionID: sessionID}
	}
	pruneInboxLocked(in, at)
	in.Messages = append(in.Messages, InboxMessage{
		ID:   NewInboxMessageID(at),
		From: from,
		Body: body,
		At:   at,
	})
	if len(in.Messages) > InboxKeepMax {
		in.Messages = in.Messages[len(in.Messages)-InboxKeepMax:]
	}
	if err := r.save(in); err != nil {
		return nil, err
	}
	return in, nil
}

func (r *inboxRepo) Take(sessionID string, at time.Time) ([]InboxMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	in, err := r.Get(sessionID)
	if err != nil || in == nil {
		return nil, err
	}
	pruneInboxLocked(in, at)
	unread := make([]InboxMessage, 0, len(in.Messages))
	for i := range in.Messages {
		if !in.Messages[i].Read {
			in.Messages[i].Read = true
			unread = append(unread, in.Messages[i])
		}
	}
	if len(unread) > 0 {
		if err := r.save(in); err != nil {
			return nil, err
		}
	}
	return unread, nil
}

func (r *inboxRepo) Delete(sessionID string) error {
	if err := r.doc.Delete(inboxKind, sessionID); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (r *inboxRepo) CleanupBefore(before time.Time) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(inboxKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		in, err := r.Get(k)
		// 判据 = 「没有晚于截止的消息」：以最新消息时刻为准而非文档 UpdatedAt
		//（Take 标已读会推进 UpdatedAt，但内容陈旧度不变——按 UpdatedAt 判会把
		// 只被拉取过的死收件箱误判为活跃）。空表/解析失败（损坏文档不滞留，
		// 巡检口既有语义）按 UpdatedAt 兜底
		if err != nil || inboxIdleAt(in, before) {
			if r.doc.Delete(inboxKind, k) == nil {
				removed++
			}
		}
	}
	return removed, nil
}

// inboxIdleAt 收件箱是否已无未过期内容：最新消息早于 before（或空表按最后
// 写入时刻）
func inboxIdleAt(in *SessionInbox, before time.Time) bool {
	if in == nil {
		return true
	}
	if len(in.Messages) == 0 {
		return in.UpdatedAt.Before(before)
	}
	return !in.Messages[len(in.Messages)-1].At.After(before)
}
