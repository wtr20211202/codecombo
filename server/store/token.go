package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"codecombo/server/config"

	"github.com/google/uuid"
)

type TokenStore interface {
	List() ([]config.TokenConfig, error)
	Generate(name string, expiresInDays int) (string, config.TokenConfig, error)
	Validate(rawToken string) (*config.TokenConfig, error)
	Delete(id string) error
	HasAny() bool
}

type tokenRepo struct {
	doc     DocumentStore
	cache   map[string]*config.TokenConfig // hash → token
	cacheAt time.Time
	mu      sync.RWMutex
	// lastPersistedUse tokenID → 最近一次 LastUsedAt 落盘时刻。
	// Validate 是每个请求的热路径：历史实现每次成功校验都重写 token 文档，
	// 持续认证流量下形成"每 5s 一次全目录读 + 每请求一次文档重写"的磁盘热点；
	// 节流为 ≥60s 才落盘一次（LastUsedAt 仅用于管理页展示，精度足够）
	lastPersistedUse map[string]time.Time
}

var (
	tokenSalt     []byte
	tokenSaltOnce sync.Once
)

func getTokenSalt() []byte {
	tokenSaltOnce.Do(func() {
		saltPath := filepath.Join(config.DataDir(), "data", "token-salt")
		if data, err := os.ReadFile(saltPath); err == nil && len(data) > 0 {
			tokenSalt = data
			return
		}
		tokenSalt = make([]byte, 16)
		// rand.Read 失败说明系统随机源不可用：继续用全零盐会让 token hash
		// 可被离线预算（A9），直接 Fatal 拒绝启动
		if _, err := rand.Read(tokenSalt); err != nil {
			panic("crypto/rand unavailable for token salt: " + err.Error())
		}
		_ = os.MkdirAll(filepath.Dir(saltPath), 0700)
		_ = os.WriteFile(saltPath, tokenSalt, 0600)
	})
	return tokenSalt
}

func sha256Hex(s string) string {
	salt := getTokenSalt()
	// 必须拷贝进新缓冲：tokenSalt 的底层数组来自 os.ReadFile（带富余容量），
	// 直接 append 会写进共享数组——并发 ValidateToken（每个请求的热路径）
	// 产生数据竞态（race 门禁 TestLockStore_ConcurrentIssueValidate 检出，
	// 基线提交同样复现，属既有缺陷顺手修复）
	buf := make([]byte, 0, len(salt)+len(s))
	buf = append(buf, salt...)
	buf = append(buf, s...)
	h := sha256.Sum256(buf)
	return hex.EncodeToString(h[:])
}

func (r *tokenRepo) List() ([]config.TokenConfig, error) {
	keys, _, err := r.doc.List("tokens", ListOpts{})
	if err != nil {
		return nil, err
	}
	result := make([]config.TokenConfig, 0, len(keys))
	for _, key := range keys {
		data, _ := r.doc.Get("tokens", key)
		var t config.TokenConfig
		if json.Unmarshal(data, &t) == nil {
			result = append(result, t)
		}
	}
	return result, nil
}

func (r *tokenRepo) Generate(name string, expiresInDays int) (string, config.TokenConfig, error) {
	b := make([]byte, 16)
	// rand.Read 失败会产出可预测 token（A9）：必须报错而非继续
	if _, err := rand.Read(b); err != nil {
		return "", config.TokenConfig{}, err
	}
	hexPart := hex.EncodeToString(b)
	plainText := "sc_" + hexPart
	hash := sha256Hex(plainText)

	now := time.Now().UTC().Format(time.RFC3339)
	prefix := hexPart[:4]

	t := config.TokenConfig{
		ID:         uuid.New().String(),
		Name:       name,
		Hash:       hash,
		Prefix:     prefix,
		CreatedAt:  now,
		LastUsedAt: now,
	}
	if expiresInDays > 0 {
		t.ExpiresAt = time.Now().UTC().AddDate(0, 0, expiresInDays).Format(time.RFC3339)
	}

	data, err := json.Marshal(t)
	if err != nil {
		return "", t, err
	}
	if err := r.doc.Create("tokens", t.ID, data); err != nil {
		return "", t, err
	}
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
	return plainText, t, nil
}

func (r *tokenRepo) Validate(rawToken string) (*config.TokenConfig, error) {
	hash := sha256Hex(rawToken)

	// 尝试缓存
	r.mu.RLock()
	if t, ok := r.cache[hash]; ok && time.Since(r.cacheAt) < 5*time.Second {
		r.mu.RUnlock()
		if t.ExpiresAt != "" {
			exp, expErr := time.Parse(time.RFC3339, t.ExpiresAt)
			if expErr == nil && time.Now().UTC().After(exp) {
				return nil, ErrNotFound
			}
		}
		return t, nil
	}
	r.mu.RUnlock()

	// 缓存未命中，走磁盘
	all, err := r.List()
	if err != nil {
		return nil, err
	}

	// 重建缓存
	newCache := make(map[string]*config.TokenConfig, len(all))
	for i := range all {
		newCache[all[i].Hash] = &all[i]
	}
	r.mu.Lock()
	r.cache = newCache
	r.cacheAt = time.Now()
	r.mu.Unlock()

	for i := range all {
		if all[i].Hash == hash {
			t := &all[i]
			if t.ExpiresAt != "" {
				exp, expErr := time.Parse(time.RFC3339, t.ExpiresAt)
				if expErr == nil && time.Now().UTC().After(exp) {
					return nil, ErrNotFound
				}
			}
			now := time.Now().UTC()
			t.LastUsedAt = now.Format(time.RFC3339)
			// 节流落盘：内存值始终更新（返回给前端），磁盘写入 ≥60s 一次
			r.mu.Lock()
			if r.lastPersistedUse == nil {
				r.lastPersistedUse = make(map[string]time.Time)
			}
			last := r.lastPersistedUse[t.ID]
			if now.Sub(last) >= time.Minute {
				if data, err := json.Marshal(t); err == nil {
					if r.doc.Update("tokens", t.ID, data) == nil {
						r.lastPersistedUse[t.ID] = now
					}
				}
			}
			r.mu.Unlock()
			return t, nil
		}
	}
	return nil, ErrNotFound
}

func (r *tokenRepo) Delete(id string) error {
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
	return r.doc.Delete("tokens", id)
}

func (r *tokenRepo) HasAny() bool {
	keys, _, _ := r.doc.List("tokens", ListOpts{Limit: 1})
	return len(keys) > 0
}
