package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Quickdrop 快投递（P-20261006-51）：手机/脚本 → 工作台实例的最轻投递通道。
// 两个车道 1 kind：quickdroptokens（投递凭据单例）与 quickdrops（投递收件箱，
// append 型带保留策略）。收件箱语义与 AgentAsk 同级敏感面：内容明文短 TTL
//（DropTTL 24h，创建即定倒计时，到期清理双路径），不长期留痕。

// QuickdropTokenMeta 管理页展示用元信息（不含任何秘密值，AgentTokenMeta 同款）
type QuickdropTokenMeta struct {
	Exists    bool   `json:"exists"`
	Prefix    string `json:"prefix"`    // 明文前 4 位 hex（scd_ 之后），辅助辨识
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// quickdropTokenDoc 落盘结构（kind: quickdroptokens，key: active 单例）。
// 只存哈希不存明文：token 是投递凭据（访客提交时原样回传比对），没有
// agent token 那种「服务端要解出明文注入终端 env」的需求——机器 API token
// 的仅哈希策略够用
type quickdropTokenDoc struct {
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Hash      string `json:"hash"` // sha256(plain)，请求校验用
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// QuickdropTokenStore 投递凭据存储（单例，生成即轮换）
type QuickdropTokenStore interface {
	// Generate 生成/轮换 token：已有令牌立即失效（轮换语义），返回明文一次
	Generate() (string, error)
	// Meta 当前令牌元信息（exists=false 表示未生成或已撤销）
	Meta() QuickdropTokenMeta
	// Validate 投递请求校验；仅接受 scd_ 前缀（异令牌族互不误伤）
	Validate(raw string) bool
	// Revoke 撤销（未生成时幂等 no-op）
	Revoke() error
}

type quickdropTokenRepo struct {
	doc DocumentStore
	mu  sync.RWMutex
	// 5s TTL 缓存单例文档：Validate 在公开投递端点每请求调用（filestore.Get
	// 是磁盘读），agentTokenRepo 同款惯例；本进程内 Generate/Revoke 写后
	// 立即失效，撤销即时生效
	cache   *quickdropTokenDoc
	cacheAt time.Time
}

// quickdropTokenCacheTTL Validate 读缓存的窗口（agentTokenCacheTTL 同值惯例）
const quickdropTokenCacheTTL = 5 * time.Second

func (r *quickdropTokenRepo) load() *quickdropTokenDoc {
	if r.cache != nil && time.Since(r.cacheAt) < quickdropTokenCacheTTL {
		return r.cache
	}
	data, err := r.doc.Get("quickdroptokens", "active")
	if err != nil {
		return nil
	}
	var t quickdropTokenDoc
	if json.Unmarshal(data, &t) != nil || t.Hash == "" {
		return nil
	}
	r.cache, r.cacheAt = &t, time.Now()
	return &t
}

// invalidateCache 写操作后调用（调用方持写锁）：轮换/撤销即时反映到后续校验
func (r *quickdropTokenRepo) invalidateCache() {
	r.cache, r.cacheAt = nil, time.Time{}
}

// Generate 生成新令牌并落盘（单例键：存在即覆盖 = 轮换语义，旧令牌立即失效）。
// 保留最初创建时间只刷新轮换时间（agentTokenRepo.Rotate 同款）
func (r *quickdropTokenRepo) Generate() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.load()
	b := make([]byte, 16)
	// 与 token.go 同策略：随机源不可用时报错而非产出可预测令牌
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	hexPart := hex.EncodeToString(b)
	plain := "scd_" + hexPart
	now := time.Now().UTC().Format(time.RFC3339)
	t := quickdropTokenDoc{
		ID:        uuid.New().String(),
		Prefix:    hexPart[:4],
		Hash:      sha256Hex(plain),
		CreatedAt: now,
		RotatedAt: now,
	}
	if old != nil {
		t.CreatedAt = old.CreatedAt
	}
	data, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	if _, err := r.doc.Get("quickdroptokens", "active"); err == nil {
		err = r.doc.Update("quickdroptokens", "active", data)
		r.invalidateCache()
		return plain, err
	}
	err = r.doc.Create("quickdroptokens", "active", data)
	r.invalidateCache()
	return plain, err
}

func (r *quickdropTokenRepo) Meta() QuickdropTokenMeta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	if t == nil {
		return QuickdropTokenMeta{Exists: false}
	}
	return QuickdropTokenMeta{
		Exists:    true,
		Prefix:    t.Prefix,
		CreatedAt: t.CreatedAt,
		RotatedAt: t.RotatedAt,
	}
}

func (r *quickdropTokenRepo) Validate(raw string) bool {
	if len(raw) < 4 || raw[:4] != "scd_" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	return t != nil && t.Hash == sha256Hex(raw)
}

func (r *quickdropTokenRepo) Revoke() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.load() == nil {
		return nil
	}
	err := r.doc.Delete("quickdroptokens", "active")
	r.invalidateCache()
	return err
}

// Quickdrop 一条投递（内容本体 + 到达元数据）。From 是投递来源 IP——与审计
// 同级的元数据（谁投来的），不是正文的一部分；前端列表展示来源便于辨识
//「手机投的」还是「脚本投的」
type Quickdrop struct {
	ID        string    `json:"id"` // sc_qd_ + uuid
	Content   string    `json:"content"`
	From      string    `json:"from,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"` // 创建即定 now+DropTTL，倒计时是安全边界
}

const (
	// DropTTL 投递内容存活窗口：创建起算 24h，到期由清理 ticker 删除 +
	// List/Get 惰性把守双路径（AgentAsk/Share snippet 同语义——内容明文
	// 敏感面，过窗即删不长期留痕）
	DropTTL = 24 * time.Hour

	// MaxDropBytes 投递内容字节上限（手机粘贴一段报错/代码/想法的量级，
	// 4KB 兜底防把投递收件箱当无限 pastebin——大内容走 Share snippet 32KiB）
	MaxDropBytes = 4 << 10

	// MaxDrops 收件箱条数上限（append 型 kind 必须带保留策略的上限维度，
	// notifications 200 同款惯例）：20 条 × 4KB = 80KB 封顶，Add 后裁最旧
	MaxDrops = 20
)

// QuickdropStore 投递收件箱存储
type QuickdropStore interface {
	// Add 入账：分配 id/时刻（ExpiresAt = now+DropTTL 创建即定），并把超出
	// MaxDrops 的最旧条目裁掉。返回落库后的记录
	Add(q Quickdrop) (Quickdrop, error)
	// List 存活投递清单（新→旧；已过期条目剔除不返回）
	List() ([]Quickdrop, error)
	// Get 单条（不存在/已过期 → ErrNotFound——过期未及清理的记录对消费面
	// 已死亡，与 share getLive 同口径）
	Get(id string) (*Quickdrop, error)
	// Delete 摘除单条（转发消费后手动清理）；未知/已清账 id 幂等成功——
	// dismiss 语义（双击/与 TTL 清理竞态都收敛为成功，错误只在存储故障冒出）
	Delete(id string) error
	// CleanupExpired 删除已过保留窗口的全部条目，返回删除条数（保留策略 ticker 用）
	CleanupExpired(now time.Time) (int, error)
}

type quickdropRepo struct {
	doc DocumentStore
}

func newQuickdropRepo(doc DocumentStore) *quickdropRepo { return &quickdropRepo{doc: doc} }

const quickdropKind = "quickdrops"

// NewQuickdropID 投递 ID（服务端生成，客户端不可指定；NewAgentAskID 同款先例）
func NewQuickdropID() string {
	return "sc_qd_" + uuid.NewString()
}

func (r *quickdropRepo) Add(q Quickdrop) (Quickdrop, error) {
	// 空与纯空白拒绝：投递「一段报错/一段代码」的最小有效载荷非空；
	// 全空白内容只会产生一条空通知（API 层已先 trim，这里兜底防未来调用方）
	if strings.TrimSpace(q.Content) == "" {
		return q, fmt.Errorf("%w: quickdrop content is empty", ErrInvalidArg)
	}
	if len(q.Content) > MaxDropBytes {
		return q, fmt.Errorf("%w: quickdrop exceeds %d bytes", ErrInvalidArg, MaxDropBytes)
	}
	q.ID = NewQuickdropID()
	now := time.Now()
	if q.CreatedAt.IsZero() {
		q.CreatedAt = now
	}
	q.ExpiresAt = now.Add(DropTTL)
	data, err := json.Marshal(q)
	if err != nil {
		return q, err
	}
	if err := r.doc.Create(quickdropKind, q.ID, data); err != nil {
		return q, err
	}
	// 有界收件箱：每次 Add 后裁到上限（notificationRepo trimOldest 同款惯例）
	keys, total, _ := r.doc.List(quickdropKind, ListOpts{})
	if total > MaxDrops {
		type item struct {
			key  string
			at   time.Time
			data []byte
		}
		items := make([]item, 0, total)
		for _, k := range keys {
			b, err := r.doc.Get(quickdropKind, k)
			if err != nil {
				continue
			}
			var d Quickdrop
			if json.Unmarshal(b, &d) != nil {
				continue
			}
			items = append(items, item{key: k, at: d.CreatedAt, data: b})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].at.Before(items[j].at) })
		for i := 0; i < len(items)-MaxDrops; i++ {
			_ = r.doc.Delete(quickdropKind, items[i].key)
		}
	}
	return q, nil
}

// List 存活清单（新→旧）。过期条目就地剔除不返回——清理 ticker 有周期间隙，
// 消费面不等它（share 访客面「清理间隙访客把守」同款双保险）
func (r *quickdropRepo) List() ([]Quickdrop, error) {
	keys, _, err := r.doc.List(quickdropKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	now := time.Now()
	out := make([]Quickdrop, 0, len(keys))
	for _, k := range keys {
		data, err := r.doc.Get(quickdropKind, k)
		if err != nil {
			continue
		}
		var q Quickdrop
		if json.Unmarshal(data, &q) != nil {
			continue
		}
		if !q.ExpiresAt.IsZero() && !q.ExpiresAt.After(now) {
			continue
		}
		out = append(out, q)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (r *quickdropRepo) Get(id string) (*Quickdrop, error) {
	data, err := r.doc.Get(quickdropKind, id)
	if err != nil {
		return nil, ErrNotFound
	}
	var q Quickdrop
	if json.Unmarshal(data, &q) != nil {
		return nil, ErrNotFound
	}
	if !q.ExpiresAt.IsZero() && !q.ExpiresAt.After(time.Now()) {
		return nil, ErrNotFound
	}
	return &q, nil
}

func (r *quickdropRepo) Delete(id string) error {
	if err := r.doc.Delete(quickdropKind, id); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}

// CleanupExpired 实现 QuickdropStore.CleanupExpired（DropTTL 到期清账；
// 单条失败不阻断整轮，下一周期重试同批余量——share CleanupExpired 同款）
func (r *quickdropRepo) CleanupExpired(now time.Time) (int, error) {
	keys, _, err := r.doc.List(quickdropKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		data, err := r.doc.Get(quickdropKind, k)
		if err != nil {
			continue
		}
		var q Quickdrop
		if json.Unmarshal(data, &q) != nil {
			continue
		}
		if q.ExpiresAt.IsZero() || q.ExpiresAt.After(now) {
			continue
		}
		if r.doc.Delete(quickdropKind, k) == nil {
			removed++
		}
	}
	return removed, nil
}
