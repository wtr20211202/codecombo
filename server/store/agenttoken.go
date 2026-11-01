package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/config"

	"github.com/google/uuid"
)

// Agent Token（sca_ 前缀）：专供智能体（终端里运行的 claude/codex/dsh 等）调用
// 本系统 REST API 的长效令牌。与解锁 token（scl_，随解锁滑动续期）的区别：
// 智能体终端是长驻会话，注入 env 的令牌不能随 TTL 静默过期——否则表现为
// 「智能体跑到一半所有工具回调 423」。
//
// 与机器 API Token（sc_，仅存哈希）的区别：agent token 的明文需要在任意时刻
// 创建终端会话时注入环境变量，因此服务端必须可逆——与远程主机密码同一策略
// （config.EncryptToken 加密落盘，机器密钥不出本机）。管理语义：轮换/撤销。

// AgentProjectID 终端会话的哨兵项目 ID（仅用于 tmux 会话名哈希与恢复归类，
// 不是真实项目）
const AgentProjectID = "__agent__"

// AgentTokenMeta 管理页展示用的元信息（不含任何秘密值）
type AgentTokenMeta struct {
	Exists    bool   `json:"exists"`
	Prefix    string `json:"prefix"` // 明文前 4 位 hex（sca_ 之后），辅助辨识
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// agentTokenDoc 落盘结构（collection: agenttokens，key: active 单例）
type agentTokenDoc struct {
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Hash      string `json:"hash"`      // sha256(salt+plain)，用于请求校验
	Encrypted string `json:"encrypted"` // enc: 明文的机器密钥加密态，供终端 env 注入
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt"`
}

// AgentTokenStore 智能体令牌存储
type AgentTokenStore interface {
	// Ensure 无令牌时自动生成一份（开箱即用：终端 env 注入不需要用户先去设置页创建）
	Ensure() error
	// Meta 当前令牌元信息（exists=false 表示已被撤销）
	Meta() AgentTokenMeta
	// Validate 请求校验（X-Lock-Token 路径）；仅接受 sca_ 前缀
	Validate(raw string) bool
	// Plain 解出明文（终端 env 注入用）；无令牌返回空串
	Plain() string
	// Rotate 轮换：生成新明文、旧令牌立即失效；返回新明文（前端展示一次）
	Rotate() (string, error)
	// ImportPlain 以给定明文落盘令牌（换机迁移导入 P-20261003-147：源机明文
	// 随口令信封出域，本机重新派生哈希并重新加密——哈希盐与机器密钥都是本机
	// material 不能跨机携带，只能带明文重派生）。与 Rotate 同语义：已有令牌
	// 立即失效
	ImportPlain(plain string) error
	// Revoke 撤销：删除令牌（已在终端 env 里的旧值随之失效）
	Revoke() error
}

type agentTokenRepo struct {
	doc DocumentStore
	mu  sync.RWMutex
	// 5 秒 TTL 缓存单例文档：Validate 在全局锁定中间件里每个 agent 请求都
	// 调（历史实现每请求 os.ReadFile）；本进程内的 Rotate/Revoke 写后立即
	// 失效，撤销即时生效。与 token.go 哈希缓存同一 TTL 惯例
	cache   *agentTokenDoc
	cacheAt time.Time
}

// agentTokenCacheTTL Validate/Plain 读缓存的窗口
const agentTokenCacheTTL = 5 * time.Second

func (r *agentTokenRepo) load() *agentTokenDoc {
	if r.cache != nil && time.Since(r.cacheAt) < agentTokenCacheTTL {
		return r.cache
	}
	data, err := r.doc.Get("agenttokens", "active")
	if err != nil {
		return nil
	}
	var t agentTokenDoc
	if json.Unmarshal(data, &t) != nil || t.Hash == "" {
		return nil
	}
	r.cache, r.cacheAt = &t, time.Now()
	return &t
}

// invalidateCache 写操作后调用（调用方持写锁）：撤销/轮换立即反映到后续校验
func (r *agentTokenRepo) invalidateCache() {
	r.cache, r.cacheAt = nil, time.Time{}
}

func (r *agentTokenRepo) Ensure() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.load() != nil {
		return nil
	}
	if _, err := r.generateLocked(); err != nil {
		return err
	}
	slog.Info("agent token auto-provisioned")
	return nil
}

// generateLocked 生成新令牌并落盘（调用方持写锁）
func (r *agentTokenRepo) generateLocked() (string, error) {
	b := make([]byte, 16)
	// 与 token.go 同策略：随机源不可用时产出可预测令牌，必须报错
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	hexPart := hex.EncodeToString(b)
	plain := "sca_" + hexPart
	enc, err := config.EncryptToken(plain)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	t := agentTokenDoc{
		ID:        uuid.New().String(),
		Prefix:    hexPart[:4],
		Hash:      sha256Hex(plain),
		Encrypted: enc,
		CreatedAt: now,
		RotatedAt: now,
	}
	data, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	// 单例键：存在即覆盖（轮换语义）
	if _, err := r.doc.Get("agenttokens", "active"); err == nil {
		err = r.doc.Update("agenttokens", "active", data)
		r.invalidateCache()
		return plain, err
	}
	err = r.doc.Create("agenttokens", "active", data)
	r.invalidateCache()
	return plain, err
}

func (r *agentTokenRepo) Meta() AgentTokenMeta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	if t == nil {
		return AgentTokenMeta{Exists: false}
	}
	return AgentTokenMeta{
		Exists:    true,
		Prefix:    t.Prefix,
		CreatedAt: t.CreatedAt,
		RotatedAt: t.RotatedAt,
	}
}

func (r *agentTokenRepo) Validate(raw string) bool {
	if len(raw) < 4 || raw[:4] != "sca_" {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	return t != nil && t.Hash == sha256Hex(raw)
}

func (r *agentTokenRepo) Plain() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t := r.load()
	if t == nil {
		return ""
	}
	plain, err := config.DecryptToken(t.Encrypted)
	if err != nil {
		// 机器密钥变化（重装/数据目录搬迁）导致旧密文不可解：等同于令牌失效，
		// 记录后返回空——调用方（终端 env 注入）跳过注入，不注入坏值
		slog.Warn("agent token decrypt failed — treat as revoked (machine key changed?)", "err", err)
		return ""
	}
	return plain
}

func (r *agentTokenRepo) Rotate() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.load()
	plain, err := r.generateLocked()
	if err != nil {
		return "", err
	}
	if old != nil {
		// 保留最初创建时间，仅刷新轮换时间
		t := r.load()
		t.CreatedAt = old.CreatedAt
		data, _ := json.Marshal(t)
		_ = r.doc.Update("agenttokens", "active", data)
	}
	return plain, nil
}

// ImportPlain 迁移导入：以源机明文本机重派生（哈希盐 + 机器密钥重算，
// 见接口注记）。空明文/明文非 sca_ 前缀拒绝——前缀是令牌族的身份证
// （Validate 只认 sca_，异族明文落进来即成永久无效令牌）
func (r *agentTokenRepo) ImportPlain(plain string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if plain == "" || len(plain) < 4 || plain[:4] != "sca_" {
		return fmt.Errorf("invalid agent token plaintext")
	}
	enc, err := config.EncryptToken(plain)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	t := agentTokenDoc{
		ID:        uuid.New().String(),
		Prefix:    hex.EncodeToString([]byte(plain[4:8])),
		Hash:      sha256Hex(plain),
		Encrypted: enc,
		CreatedAt: now,
		RotatedAt: now,
	}
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	if _, err := r.doc.Get("agenttokens", "active"); err == nil {
		err = r.doc.Update("agenttokens", "active", data)
		r.invalidateCache()
		return err
	}
	err = r.doc.Create("agenttokens", "active", data)
	r.invalidateCache()
	return err
}

func (r *agentTokenRepo) Revoke() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.load() == nil {
		return nil
	}
	err := r.doc.Delete("agenttokens", "active")
	r.invalidateCache()
	return err
}
