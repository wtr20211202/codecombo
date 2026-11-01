package store

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 入站事件 Hook 凭据（sch_ 前缀，P-20261003-23）：外部事件（CI 失败/监控告警/
// 脚本）→ POST /api/hooks 的函数级凭据。与 Agent Token（sca_）刻意分域：
// 泄露面只到「往通知中心写噪音」，拿不到任何管理面能力。仅存哈希（quickdrop
// token 同款）：入站校验只需原样比对，服务端没有解出明文的需求。
//
// 生命周期：无自动播种——未签发 = 入站关闭（全部 401），签发/轮换/销毁全部
// 由设置页显式操作并各自入审计（hook.token.rotate / hook.token.revoke）。

// HookTokenMeta 管理页展示用元信息（不含任何秘密值，AgentTokenMeta 同款）
type HookTokenMeta struct {
	Exists    bool   `json:"exists"`
	Prefix    string `json:"prefix"` // 明文前 4 位 hex（sch_ 之后），辅助辨识
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// hookTokenDoc 落盘结构（kind: hooktokens，key: active 单例）
type hookTokenDoc struct {
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Hash      string `json:"hash"` // sha256(plain)，请求校验用
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// HookTokenStore 入站 Hook 凭据存储（单例：签发即轮换）
type HookTokenStore interface {
	// Rotate 签发/轮换凭据：无凭据即签发，已有则新值落盘、旧值立即失效；
	// 返回明文一次（前端展示后只留前缀元信息）
	Rotate() (string, error)
	// Meta 当前凭据元信息（exists=false 表示未签发或已销毁）
	Meta() HookTokenMeta
	// Validate 入站请求校验；仅接受 sch_ 前缀（异令牌族互不误伤）
	Validate(raw string) bool
	// Revoke 销毁（未签发时幂等 no-op）：入站随即全部 401
	Revoke() error
}

type hookTokenRepo struct {
	doc DocumentStore
	mu  sync.RWMutex
	// 5s TTL 缓存单例文档：Validate 在公开入站端点每请求调用（filestore.Get
	// 是磁盘读），quickdropTokenRepo/agentTokenRepo 同款惯例；本进程内
	// Rotate/Revoke 写后立即失效，销毁即时生效
	cache   *hookTokenDoc
	cacheAt time.Time
}

// hookTokenCacheTTL Validate 读缓存的窗口（agentTokenCacheTTL 同值惯例）
const hookTokenCacheTTL = 5 * time.Second

func (r *hookTokenRepo) load() *hookTokenDoc {
	if r.cache != nil && time.Since(r.cacheAt) < hookTokenCacheTTL {
		return r.cache
	}
	data, err := r.doc.Get("hooktokens", "active")
	if err != nil {
		return nil
	}
	var t hookTokenDoc
	if json.Unmarshal(data, &t) != nil || t.Hash == "" {
		return nil
	}
	r.cache, r.cacheAt = &t, time.Now()
	return &t
}

// invalidateCache 写操作后调用（调用方持写锁）：签发/销毁立即反映到后续校验
func (r *hookTokenRepo) invalidateCache() {
	r.cache, r.cacheAt = nil, time.Time{}
}

// Rotate 生成新凭据并落盘（单例键：存在即覆盖 = 轮换语义，旧凭据立即失效）。
// 保留最初创建时间只刷新轮换时间（agentTokenRepo.Rotate 同款）
func (r *hookTokenRepo) Rotate() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.load()
	b := make([]byte, 16)
	// 与 token.go 同策略：随机源不可用时报错而非产出可预测令牌
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	hexPart := hex.EncodeToString(b)
	plain := "sch_" + hexPart
	now := time.Now().UTC().Format(time.RFC3339)
	t := hookTokenDoc{
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
	if _, err := r.doc.Get("hooktokens", "active"); err == nil {
		err = r.doc.Update("hooktokens", "active", data)
		r.invalidateCache()
		return plain, err
	}
	err = r.doc.Create("hooktokens", "active", data)
	r.invalidateCache()
	return plain, err
}

func (r *hookTokenRepo) Meta() HookTokenMeta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	if t == nil {
		return HookTokenMeta{Exists: false}
	}
	return HookTokenMeta{
		Exists:    true,
		Prefix:    t.Prefix,
		CreatedAt: t.CreatedAt,
		RotatedAt: t.RotatedAt,
	}
}

// Validate 只接受 sch_ 前缀 + 哈希常量时间比较：公开端点上的令牌比对不产生
// 可观测的提前返回（sha256 十六进制串等长，ConstantTimeCompare 语义成立）
func (r *hookTokenRepo) Validate(raw string) bool {
	if len(raw) < 4 || raw[:4] != "sch_" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	if t == nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(t.Hash), []byte(sha256Hex(raw))) == 1
}

func (r *hookTokenRepo) Revoke() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.load() == nil {
		return nil
	}
	err := r.doc.Delete("hooktokens", "active")
	r.invalidateCache()
	return err
}
