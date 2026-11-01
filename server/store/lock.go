package store

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/bcrypt"

	"codecombo/server/model"
)

// LockConfig 锁定配置（引用 model 包定义，alias 让本包内可直接用 LockConfig）
type LockConfig = model.LockConfig

// ErrInvalidPassword 旧密码不匹配
var ErrInvalidPassword = errors.New("invalid current password")

// ErrPasswordEmpty 新密码为空字符串
var ErrPasswordEmpty = errors.New("password cannot be empty")

// ErrAlreadyInitialized 锁配置已存在（首启设密仅允许一次）
var ErrAlreadyInitialized = errors.New("lock already initialized")

// DEFAULT_PASSWORD_HASH 默认密码 admin 的 bcrypt 哈希（cost=10）
const DEFAULT_PASSWORD_HASH = "$2a$10$B8X0vYa88eizSOQswVqMcesIQu4e9GG.Lvd7ggZeQrNABeAmUE2Ca"

// defaultPassword 出厂默认密码明文（与 DEFAULT_PASSWORD_HASH 同一明文）
const defaultPassword = "admin"

// lockCollection docstore 集合名
const lockCollection = "lock"

// lockConfigKey / lockTokensKey docstore 文档 key
const (
	lockConfigKey = "config"
	lockTokensKey = "tokens"
)

// tokenPersistInterval LastSeen 落盘节流间隔：Validate/Touch 是热路径，
// 续期时间戳只需分钟级精度，≥60s 才写一次盘（与 tokenRepo.LastUsedAt 同策略）
const tokenPersistInterval = 60 * time.Second

// activeToken unlock token 在 active set 中的条目
type activeToken struct {
	Value    string
	LastSeen time.Time
	IssuedAt time.Time
}

// persistedToken 落盘的 token 元数据（map key = sha256Hex(token)，不存原文：
// 解锁 token 与 sc_ 访问 token 同等敏感，磁盘上只允许留哈希）
type persistedToken struct {
	IssuedAt time.Time
	LastSeen time.Time
}

// wsCloserEntry 包装 closer 函数及其稳定 ID
type wsCloserEntry struct {
	id int64
	fn func()
}

// lockStore LockStore 实现
type lockStore struct {
	mu          sync.RWMutex
	doc         DocumentStore
	configCache *LockConfig
	cacheAt     time.Time

	active map[string]*activeToken

	// persisted token 哈希 → 元数据，跨重启持久化到 docstore。
	// 服务重启不再作废浏览器已持有的解锁 token（否则每次重启/升级部署
	// 都强制全员重新解锁，且恢复链路任何一环异常都表现为功能静默失效）
	persisted map[string]*persistedToken

	// lastFlush 上次 LastSeen 批量落盘时刻（tokenPersistInterval 节流）
	lastFlush time.Time

	// wsConns[token] = set of closer entries
	// 一个 token 可对应多个 WS 连接（不同 WS 路由）
	wsConns map[string]map[*wsCloserEntry]struct{}

	// closerByID 通过 closerID 反查 wsCloserEntry 指针，支持 UnregisterWSConn
	closerByID map[int64]*wsCloserEntry

	// closerSeq 全局自增 closerID 生成器
	closerSeq int64

	// tokenTTLOverride 测试专用：非零时覆盖配置中的 TTL
	tokenTTLOverride time.Duration
}

// LockStore 锁定机制存储接口
type LockStore interface {
	GetConfig() LockConfig
	SaveConfig(LockConfig) error
	VerifyPassword(plain string) bool
	UpdatePassword(oldPlain, newPlain string) error
	IssueToken() (string, error)
	ValidateToken(token string) bool
	TouchToken(token string)
	RevokeToken(token string)
	RevokeAllTokens()
	IsDefaultPassword() bool
	HasConfig() bool
	SetupPassword(plain string) error
	InitDefault() error
	RegisterWSConn(token string, closer func()) int64
	UnregisterWSConn(token string, closerID int64)
	StartCleanupLoop(stop <-chan struct{})
}

// newLockStore 构造 lockStore（加载持久化 token 元数据）
func newLockStore(doc DocumentStore) LockStore {
	s := &lockStore{
		doc:        doc,
		active:     make(map[string]*activeToken),
		persisted:  make(map[string]*persistedToken),
		wsConns:    make(map[string]map[*wsCloserEntry]struct{}),
		closerByID: make(map[int64]*wsCloserEntry),
	}
	s.loadPersistedTokens()
	return s
}

// loadPersistedTokens 启动时从 docstore 恢复 token 元数据。
// active 原文 map 保持为空：首次 ValidateToken 以哈希命中后按需重建内存条目
func (s *lockStore) loadPersistedTokens() {
	data, err := s.doc.Get(lockCollection, lockTokensKey)
	if err != nil {
		return
	}
	var m map[string]*persistedToken
	if json.Unmarshal(data, &m) != nil {
		return
	}
	s.persisted = m
}

// persistTokensLocked 持久化 token 元数据（调用前必须持有 s.mu 写锁）。
// force=false 时按 tokenPersistInterval 节流（LastSeen 高频续期场景）；
// 签发/撤销/过期清理必须 force=true（漏盘一次撤销 = 已撤销 token 重启后复活）
func (s *lockStore) persistTokensLocked(force bool) {
	if !force && time.Since(s.lastFlush) < tokenPersistInterval {
		return
	}
	data, err := json.Marshal(s.persisted)
	if err != nil {
		return
	}
	if s.doc.Upsert(lockCollection, lockTokensKey, data) != nil {
		return
	}
	s.lastFlush = time.Now()
}

// GetConfig 读配置（带 5s 缓存）
func (s *lockStore) GetConfig() LockConfig {
	s.mu.RLock()
	if s.configCache != nil && time.Since(s.cacheAt) < 5*time.Second {
		cfg := *s.configCache
		s.mu.RUnlock()
		return cfg
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	// 双检
	if s.configCache != nil && time.Since(s.cacheAt) < 5*time.Second {
		return *s.configCache
	}

	data, err := s.doc.Get(lockCollection, lockConfigKey)
	if err != nil {
		// 配置不存在，返回 zero value（调用方应先调 HasConfig）
		return LockConfig{}
	}
	var cfg LockConfig
	if json.Unmarshal(data, &cfg) != nil {
		return LockConfig{}
	}
	s.configCache = &cfg
	s.cacheAt = time.Now()
	return cfg
}

// SaveConfig 写配置（使缓存失效）
func (s *lockStore) SaveConfig(cfg LockConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal lock config: %w", err)
	}
	if err := s.doc.Upsert(lockCollection, lockConfigKey, data); err != nil {
		return fmt.Errorf("upsert lock config: %w", err)
	}
	s.configCache = &cfg
	s.cacheAt = time.Now()
	return nil
}

// HasConfig 是否已初始化配置。
// 复用 GetConfig 的 5s configCache：pre-setup 阶段（从未设密）安装器/前端
// 高频轮询 + LockMiddleware 每请求直达此处，此前每次都直读磁盘（与 GetConfig
// 的缓存不对称）。SetupPassword/SaveConfig 写路径都会刷新 configCache，窗口一致
func (s *lockStore) HasConfig() bool {
	s.mu.RLock()
	if s.configCache != nil && time.Since(s.cacheAt) < 5*time.Second {
		has := s.configCache.PasswordHash != ""
		s.mu.RUnlock()
		return has
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	// 双检：等锁期间可能已被 GetConfig/SaveConfig 填充
	if s.configCache != nil && time.Since(s.cacheAt) < 5*time.Second {
		return s.configCache.PasswordHash != ""
	}
	data, err := s.doc.Get(lockCollection, lockConfigKey)
	if err != nil {
		return false
	}
	var cfg LockConfig
	if json.Unmarshal(data, &cfg) != nil {
		return false
	}
	s.configCache = &cfg
	s.cacheAt = time.Now()
	return cfg.PasswordHash != ""
}

// SetupPassword 首次设置密码（唯一的生产初始化入口）
// 仅当从未初始化配置时可用；锁内复查防并发 setup 竞态。
// 写入 Enabled=true + 用户密码哈希，不再落入公开已知的默认口令（安全 backlog A3）。
func (s *lockStore) SetupPassword(plain string) error {
	if strings.TrimSpace(plain) == "" {
		return ErrPasswordEmpty
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}

	s.mu.Lock()
	if data, err := s.doc.Get(lockCollection, lockConfigKey); err == nil {
		var cfg LockConfig
		if json.Unmarshal(data, &cfg) == nil && cfg.PasswordHash != "" {
			s.mu.Unlock()
			return ErrAlreadyInitialized
		}
	}
	cfg := LockConfig{
		Enabled:         true,
		AutoLockEnabled: true,
		AutoLockMinutes: 120,
		TokenTTLMinutes: 120,
		PasswordHash:    string(hash),
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("marshal lock config: %w", err)
	}
	if err := s.doc.Create(lockCollection, lockConfigKey, data); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("create lock config: %w", err)
	}
	// 旧 token 一并撤销：忘记密码经 reset-lock 重置时可能仍有重置前签发的
	// 存活 token，重设密码后不应继续有效（与 UpdatePassword 同语义）
	var allClosers []func()
	for token := range s.active {
		closers := s.collectAndDetachClosersLocked(token)
		allClosers = append(allClosers, closers...)
	}
	s.active = make(map[string]*activeToken)
	s.persisted = make(map[string]*persistedToken)
	s.persistTokensLocked(true)
	s.configCache = &cfg
	s.cacheAt = time.Now()
	s.mu.Unlock()
	callClosers(allClosers)
	return nil
}

// InitDefault 写入默认 admin 密码配置——仅测试/种子数据使用，
// 生产代码不得调用：首启一律走 SetupPassword（无配置时 LockMiddleware 全量 423）
// 注意：调用方应确保本进程单次调用，避免并发初始化竞态。
func (s *lockStore) InitDefault() error {
	return s.SaveConfig(LockConfig{
		Enabled:         true,
		AutoLockEnabled: true,
		AutoLockMinutes: 120,
		TokenTTLMinutes: 120,
		PasswordHash:    DEFAULT_PASSWORD_HASH,
	})
}

// IsDefaultPassword 是否仍是默认密码。
// 用验证式比较而非与出厂哈希常量做字符串等值：bcrypt 每次加盐，同一明文
// 重设（admin→admin 回环，e2e 密码用例的清理路径即同值回写）后存储哈希
// 必然改变，等值比较会永久误报「非默认密码」——isDefaultPassword 字段、
// 前端改密引导与依赖该守卫的 e2e 用例随之失真
func (s *lockStore) IsDefaultPassword() bool {
	cfg := s.GetConfig()
	if cfg.PasswordHash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(cfg.PasswordHash), []byte(defaultPassword)) == nil
}

// VerifyPassword 校验密码
func (s *lockStore) VerifyPassword(plain string) bool {
	cfg := s.GetConfig()
	if cfg.PasswordHash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(cfg.PasswordHash), []byte(plain)) == nil
}

// UpdatePassword 修改密码（校验旧密码 + 写新哈希 + RevokeAllTokens）
func (s *lockStore) UpdatePassword(oldPlain, newPlain string) error {
	// 拒绝空新密码（仅 TrimSpace 防止纯空白），其余长度交由用户决定（YAGNI）
	if strings.TrimSpace(newPlain) == "" {
		return ErrPasswordEmpty
	}
	if !s.VerifyPassword(oldPlain) {
		return ErrInvalidPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPlain), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	cfg := s.GetConfig()
	cfg.PasswordHash = string(hash)
	if err := s.SaveConfig(cfg); err != nil {
		return err
	}
	s.RevokeAllTokens()
	return nil
}

// ── Task 1.4 实现：token 签发 / 校验 / 撤销 ──

// tokenTTL 获取当前 token TTL（基于配置或测试 override）
func (s *lockStore) tokenTTL() time.Duration {
	s.mu.RLock()
	override := s.tokenTTLOverride
	s.mu.RUnlock()
	if override > 0 {
		return override
	}
	cfg := s.GetConfig()
	mins := cfg.TokenTTLMinutes
	if mins <= 0 {
		mins = 120
	}
	return time.Duration(mins) * time.Minute
}

// IssueToken 生成新 token
//
// Token 用作 Sec-WebSocket-Protocol 子协议（前端 new WebSocket(url, [token])），
// RFC 6455 限定子协议字符集仅允许 VCHAR / "!" / "#" / "$" / "%" / "&" / "'" / "(" / ")"
// / "*" / "+" / "-" / "." / "/" / ":" / "<" / "=" / ">" / "?" / "@" / "[" / "\\" / "]"
// / "^" / "_" / "`" / "{" / "|" / "}" / "~"，但浏览器实现普遍拒绝 "=" padding。
// 因此使用 RawURLEncoding（无 padding，字符集 A-Za-z0-9-_）。
func (s *lockStore) IssueToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random: %w", err)
	}
	token := "scl_" + base64.RawURLEncoding.EncodeToString(b)

	now := time.Now()
	s.mu.Lock()
	s.active[token] = &activeToken{
		Value:    token,
		LastSeen: now,
		IssuedAt: now,
	}
	s.persisted[sha256Hex(token)] = &persistedToken{IssuedAt: now, LastSeen: now}
	// 签发必须立即落盘：此刻若崩溃，浏览器已拿到 token 而磁盘无记录 → 重启后被 423
	s.persistTokensLocked(true)
	s.mu.Unlock()
	return token, nil
}

// ValidateToken 校验并滑动续期
func (s *lockStore) ValidateToken(token string) bool {
	if token == "" {
		return false
	}
	ttl := s.tokenTTL()
	now := time.Now()
	hash := sha256Hex(token)

	s.mu.Lock()
	at, ok := s.active[token]
	if !ok {
		// 内存未命中（典型：服务重启后浏览器带着旧 token 回来）：
		// 落盘元数据仍在 TTL 内 → 重建内存条目，用户无感恢复，无需重新解锁
		if pt, pok := s.persisted[hash]; pok && now.Sub(pt.LastSeen) <= ttl {
			pt.LastSeen = now
			s.active[token] = &activeToken{Value: token, LastSeen: now, IssuedAt: pt.IssuedAt}
			s.mu.Unlock()
			return true
		}
		s.mu.Unlock()
		return false
	}
	if now.Sub(at.LastSeen) > ttl {
		// 过期：锁内移除 token + 收集 closers，锁外调用避免 closer 阻塞拖死锁
		delete(s.active, token)
		delete(s.persisted, hash)
		s.persistTokensLocked(true)
		closers := s.collectAndDetachClosersLocked(token)
		s.mu.Unlock()
		callClosers(closers)
		return false
	}
	at.LastSeen = now
	if pt, pok := s.persisted[hash]; pok {
		pt.LastSeen = now
	}
	s.persistTokensLocked(false)
	s.mu.Unlock()
	return true
}

// TouchToken 活连接续期：仅刷新 LastSeen（WS 存续 / 长流式请求期间调用），
// 不做校验也不触发 closers——token 已失效时静默跳过
func (s *lockStore) TouchToken(token string) {
	if token == "" {
		return
	}
	hash := sha256Hex(token)
	now := time.Now()
	s.mu.Lock()
	at, ok := s.active[token]
	if !ok {
		s.mu.Unlock()
		return
	}
	at.LastSeen = now
	if pt, pok := s.persisted[hash]; pok {
		pt.LastSeen = now
	}
	s.persistTokensLocked(false)
	s.mu.Unlock()
}

// RevokeToken 撤销单个 token（仅当前 token 失效）
func (s *lockStore) RevokeToken(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	delete(s.active, token)
	delete(s.persisted, sha256Hex(token))
	s.persistTokensLocked(true)
	closers := s.collectAndDetachClosersLocked(token)
	s.mu.Unlock()
	callClosers(closers)
}

// RevokeAllTokens 撤销所有 token（改密码、关闭功能）
func (s *lockStore) RevokeAllTokens() {
	s.mu.Lock()
	var allClosers []func()
	for token := range s.active {
		closers := s.collectAndDetachClosersLocked(token)
		allClosers = append(allClosers, closers...)
	}
	s.active = make(map[string]*activeToken)
	s.persisted = make(map[string]*persistedToken)
	s.persistTokensLocked(true)
	s.mu.Unlock()
	callClosers(allClosers)
}

// collectAndDetachClosersLocked 锁内：从 wsConns[token] 收集所有 closer，
// 清理 closerByID 反查索引与 wsConns[token]（不调用 closer 本身）
// 调用前必须持有 s.mu 写锁
func (s *lockStore) collectAndDetachClosersLocked(token string) []func() {
	conns, ok := s.wsConns[token]
	if !ok {
		return nil
	}
	closers := make([]func(), 0, len(conns))
	for entry := range conns {
		if entry.fn != nil {
			closers = append(closers, entry.fn)
		}
		delete(s.closerByID, entry.id)
	}
	delete(s.wsConns, token)
	return closers
}

// callClosers 锁外：依次调用 closer
// 注意：closer 内部不允许回调 lockStore 的方法，否则会重入死锁
func callClosers(closers []func()) {
	for _, c := range closers {
		c()
	}
}

// ── Task 1.5 实现：WS 连接注册 + cleanup ──

// RegisterWSConn 注册 WS 连接的 closer，返回稳定 closerID 用于反注册
func (s *lockStore) RegisterWSConn(token string, closer func()) int64 {
	if token == "" || closer == nil {
		return 0
	}
	id := atomic.AddInt64(&s.closerSeq, 1)
	entry := &wsCloserEntry{id: id, fn: closer}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.closerByID[id]; exists {
		// 自增 ID 冲突几乎不可能，防御性返回 0
		return 0
	}
	if s.wsConns[token] == nil {
		s.wsConns[token] = make(map[*wsCloserEntry]struct{})
	}
	s.wsConns[token][entry] = struct{}{}
	s.closerByID[id] = entry
	return id
}

// UnregisterWSConn 反注册 WS 连接的 closer（按 closerID）
func (s *lockStore) UnregisterWSConn(token string, closerID int64) {
	if token == "" || closerID == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.closerByID[closerID]
	if !ok {
		return
	}
	delete(s.closerByID, closerID)
	if conns, ok := s.wsConns[token]; ok {
		delete(conns, entry)
		if len(conns) == 0 {
			delete(s.wsConns, token)
		}
	}
}

// StartCleanupLoop 后台清理过期 token（默认 1 分钟周期）
func (s *lockStore) StartCleanupLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			s.cleanupOnce()
		}
	}
}

// cleanupOnce 扫描并清理过期 token
func (s *lockStore) cleanupOnce() {
	ttl := s.tokenTTL()
	now := time.Now()

	s.mu.Lock()
	var allClosers []func()
	dirty := false
	for token, at := range s.active {
		if now.Sub(at.LastSeen) > ttl {
			delete(s.active, token)
			delete(s.persisted, sha256Hex(token))
			closers := s.collectAndDetachClosersLocked(token)
			allClosers = append(allClosers, closers...)
			dirty = true
		}
	}
	// 孤儿清扫：重启后从未被 Validate 重建内存条目的落盘残留，同样按 TTL 淘汰
	for hash, pt := range s.persisted {
		if now.Sub(pt.LastSeen) > ttl {
			delete(s.persisted, hash)
			dirty = true
		}
	}
	if dirty {
		s.persistTokensLocked(true)
	}
	s.mu.Unlock()
	callClosers(allClosers)
}

// ── 测试专用 helper（生产代码不调用） ──

// TriggerCleanupExpiredForTesting 测试专用：立即触发一次过期清理
func TriggerCleanupExpiredForTesting(ls LockStore) {
	type cleaner interface{ cleanupOnce() }
	if c, ok := ls.(cleaner); ok {
		c.cleanupOnce()
	}
}

// SetTokenTTLForTesting 测试专用：覆盖 token TTL（0 表示恢复使用配置）
func SetTokenTTLForTesting(ls LockStore, d time.Duration) {
	type ttlSetter interface{ setTokenTTLOverride(time.Duration) }
	if ts, ok := ls.(ttlSetter); ok {
		ts.setTokenTTLOverride(d)
	}
}

// setTokenTTLOverride 设置测试 TTL 覆盖
func (s *lockStore) setTokenTTLOverride(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokenTTLOverride = d
}
