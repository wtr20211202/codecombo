package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"codecombo/server/config"

	"github.com/google/uuid"
)

// AuthType 常量：凭据的认证类型
// 用于消除 "basic" / "oauth-device" / "oauth-web" 字面量散落导致的拼写错误
const (
	AuthTypeBasic       = "basic"
	AuthTypeOAuthDevice = "oauth-device"
	AuthTypeOAuthWeb    = "oauth-web"
)

// Status 常量：凭据的有效状态
const (
	StatusActive  = "active"
	StatusExpired = "expired"
)

// Credential 是 HTTPS 凭据记录（迁移自 server/config/credential.go）
// 支持多种 AuthType：basic (PAT/密码)、oauth-device、oauth-web (P1)
type Credential struct {
	ID            string    `json:"id"`
	Host          string    `json:"host"`            // 标准化 host（含端口）
	Platform      string    `json:"platform"`        // "github"/"gitlab"/"gitea"/"gitee"/"generic"
	AuthType      string    `json:"auth_type"`       // "basic" | "oauth-device" | "oauth-web"
	Username      string    `json:"username"`        // OAuth 下由 TokenUsername() 填充
	Secret        string    `json:"secret"`          // enc: 前缀加密
	RefreshToken  string    `json:"refresh_token"`   // enc:；仅 oauth-*
	ExpiresAt     time.Time `json:"expires_at"`      // 仅 oauth-*；零值 = 永不过期
	Scope         string    `json:"scope"`           // 仅 oauth-*
	OAuthClientID string    `json:"oauth_client_id"` // 仅 oauth-*
	Status        string    `json:"status"`          // "active" | "expired"
	LastError     string    `json:"last_error"`      // refresh 失败原因
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	LastUsedAt    time.Time `json:"last_used_at"`
}

// CredentialPublic 前端展示用，不含 Secret / RefreshToken
type CredentialPublic struct {
	ID         string    `json:"id"`
	Host       string    `json:"host"`
	Platform   string    `json:"platform"`
	AuthType   string    `json:"auth_type"`
	Username   string    `json:"username"`
	HasSecret  bool      `json:"hasSecret"`
	Status     string    `json:"status"`
	ExpiresAt  time.Time `json:"expires_at"`
	LastError  string    `json:"last_error"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	LastUsedAt time.Time `json:"last_used_at"`
}

// ToPublic 转为不含敏感字段的展示对象
func (c Credential) ToPublic() CredentialPublic {
	return CredentialPublic{
		ID:         c.ID,
		Host:       c.Host,
		Platform:   c.Platform,
		AuthType:   c.AuthType,
		Username:   c.Username,
		HasSecret:  c.Secret != "",
		Status:     c.Status,
		ExpiresAt:  c.ExpiresAt,
		LastError:  c.LastError,
		CreatedAt:  c.CreatedAt,
		UpdatedAt:  c.UpdatedAt,
		LastUsedAt: c.LastUsedAt,
	}
}

// CredentialStore 凭据存储
type CredentialStore interface {
	List() ([]*Credential, error)
	ListPublic() ([]CredentialPublic, error)
	FindByHost(host string) ([]*Credential, error)        // 返回该 host 全部 cred（按优先级排序）
	FindEncryptedByHost(host string) (*Credential, error) // 轻量路径：返回单条最佳
	FindByID(id string) (*Credential, error)              // 按 ID 精确查找（未找到返回 nil, nil）
	Save(c *Credential) error
	Delete(id string) error
	UpdateLastUsedAt(id string, t time.Time) error
}

type credentialRepo struct{ doc DocumentStore }

// NewCredentialRepo 暴露 credential 仓储工厂（供测试与外部包构造）
func NewCredentialRepo(doc DocumentStore) CredentialStore {
	return &credentialRepo{doc: doc}
}

func (r *credentialRepo) List() ([]*Credential, error) {
	keys, _, err := r.doc.List("credentials", ListOpts{})
	if err != nil {
		return nil, err
	}
	result := make([]*Credential, 0, len(keys))
	for _, key := range keys {
		data, _ := r.doc.Get("credentials", key)
		var c Credential
		if json.Unmarshal(data, &c) == nil {
			result = append(result, &c)
		}
	}
	return result, nil
}

func (r *credentialRepo) ListPublic() ([]CredentialPublic, error) {
	all, err := r.List()
	if err != nil {
		return nil, err
	}
	out := make([]CredentialPublic, 0, len(all))
	for _, c := range all {
		out = append(out, c.ToPublic())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out, nil
}

// FindByHost 返回该 host 全部凭据（不解密），按优先级排序
func (r *credentialRepo) FindByHost(host string) ([]*Credential, error) {
	host = HostFromURL(host)
	if host == "" {
		return nil, nil
	}
	all, err := r.List()
	if err != nil {
		return nil, err
	}
	out := make([]*Credential, 0)
	for _, c := range all {
		// 容错：历史数据可能存了未 trim 的 host，再次标准化后比较
		if HostFromURL(c.Host) == host {
			out = append(out, c)
		}
	}
	// 按优先级排序，确保调用方拿到的顺序可预期
	sort.SliceStable(out, func(i, j int) bool {
		return credentialLess(out[i], out[j])
	})
	return out, nil
}

// FindEncryptedByHost 返回该 host 下最佳凭据（按优先级）
// helper 子进程轻量路径用，避免反序列化所有 cred
// 优先级：Status active > expired；AuthType oauth-device > oauth-web > basic；UpdatedAt 最新
func (r *credentialRepo) FindEncryptedByHost(host string) (*Credential, error) {
	creds, err := r.FindByHost(host)
	if err != nil {
		return nil, err
	}
	return pickBestCredential(creds), nil
}

// Save 写入凭据，校验 AuthType / Status 字段
// 敏感字段（Secret / RefreshToken）若未加密则按 enc: 前缀加密
// 按 ID 去重：同 ID 视为更新（保留 CreatedAt），不同 ID 各自独立存储
// 这与 V1 按 host+username 去重不同——V2 允许同 host 下多种 AuthType 共存
func (r *credentialRepo) Save(c *Credential) error {
	if c.AuthType != AuthTypeBasic && c.AuthType != AuthTypeOAuthDevice && c.AuthType != AuthTypeOAuthWeb {
		return fmt.Errorf("invalid auth_type: %q", c.AuthType)
	}
	if c.Status != StatusActive && c.Status != StatusExpired {
		return fmt.Errorf("invalid status: %q", c.Status)
	}
	newID := c.ID
	if newID == "" {
		newID = uuid.NewString()
	}
	c.Host = normalizeHost(c.Host)

	// 加密敏感字段
	if c.Secret != "" && !config.IsEncrypted(c.Secret) {
		enc, err := config.EncryptToken(c.Secret)
		if err != nil {
			return fmt.Errorf("encrypt secret: %w", err)
		}
		c.Secret = enc
	}
	if c.RefreshToken != "" && !config.IsEncrypted(c.RefreshToken) {
		enc, err := config.EncryptToken(c.RefreshToken)
		if err != nil {
			return fmt.Errorf("encrypt refresh_token: %w", err)
		}
		c.RefreshToken = enc
	}

	// 按 ID 查找已存在记录：同 ID 视为更新，保留 CreatedAt
	existing, _ := r.FindByID(newID)
	if existing != nil {
		c.ID = existing.ID
		c.CreatedAt = existing.CreatedAt
		c.UpdatedAt = time.Now()
		data, _ := json.Marshal(c)
		return r.doc.Update("credentials", c.ID, data)
	}

	c.ID = newID
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now()
	}
	c.UpdatedAt = time.Now()
	data, _ := json.Marshal(c)
	return r.doc.Create("credentials", c.ID, data)
}

// FindByID 按 ID 精确查找
//
// 未找到返回 (nil, nil)（与 doc.Get 的 not-found 容错一致）；
// JSON 解析失败也返回 nil（视为损坏数据，由上层重建或忽略）
//
// 用于替代 List() 全量遍历找 ID 的 N+1 场景（测试 handler / OAuth 刷新 handler 等）
func (r *credentialRepo) FindByID(id string) (*Credential, error) {
	data, err := r.doc.Get("credentials", id)
	if err != nil {
		return nil, nil // 容错：未找到返回 nil
	}
	var c Credential
	if json.Unmarshal(data, &c) != nil {
		return nil, nil
	}
	return &c, nil
}

func (r *credentialRepo) Delete(id string) error {
	return r.doc.Delete("credentials", id)
}

// UpdateLastUsedAt 更新最近使用时间戳（仅 patch 单字段）
func (r *credentialRepo) UpdateLastUsedAt(id string, t time.Time) error {
	data, err := r.doc.Get("credentials", id)
	if err != nil {
		return err
	}
	var c Credential
	if json.Unmarshal(data, &c) != nil {
		return ErrNotFound
	}
	c.LastUsedAt = t
	out, _ := json.Marshal(c)
	return r.doc.Update("credentials", id, out)
}

// pickBestCredential 选择优先级最高的凭据
func pickBestCredential(creds []*Credential) *Credential {
	if len(creds) == 0 {
		return nil
	}
	best := creds[0]
	for _, c := range creds[1:] {
		if credentialLess(best, c) {
			best = c
		}
	}
	return best
}

// credentialLess 返回 true 表示 a 优先级低于 b（b 更优）
func credentialLess(a, b *Credential) bool {
	// 1. Status: active 优先
	sa, sb := statusOrder(a.Status), statusOrder(b.Status)
	if sa != sb {
		return sa > sb
	}
	// 2. AuthType: oauth-device > oauth-web > basic
	ta, tb := authTypeOrder(a.AuthType), authTypeOrder(b.AuthType)
	if ta != tb {
		return ta > tb
	}
	// 3. UpdatedAt 最新
	return a.UpdatedAt.Before(b.UpdatedAt)
}

func statusOrder(s string) int {
	if s == StatusActive {
		return 0
	}
	return 1
}

func authTypeOrder(t string) int {
	switch t {
	case AuthTypeOAuthDevice:
		return 0
	case AuthTypeOAuthWeb:
		return 1
	case AuthTypeBasic:
		return 2
	}
	return 3
}

// ── host 标准化（迁移自 server/config/credential.go） ──

// HostFromURL 从 URL 提取 host（支持 https://、http://、git@ 三种格式）
func HostFromURL(rawURL string) string {
	return normalizeHost(rawURL)
}

// normalizeHost 标准化 host：trim 前后空格、去协议、去 user@、识别端口或 path、转小写
//
// 支持格式：
//   - URL：https://host[:port]/path、http://host[:port]/path
//   - SCP：user@host:path/path.git（path 不以 / 开头，`:` 后非纯数字）
//   - 裸 host[:port]
//
// 端口识别规则：`:` 后到下一个 `/` 或末尾必须全是数字才算端口，否则视为 SCP path
// 直接 strip。仅 80/443/22 三个标准端口会被剥离，其余保留。
func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	for i := 0; i < len(raw); i++ {
		if raw[i] == ':' && i+2 < len(raw) && raw[i+1] == '/' && raw[i+2] == '/' {
			raw = raw[i+3:]
			break
		}
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] == '@' {
			raw = raw[i+1:]
			break
		}
	}
	if i := strings.IndexByte(raw, ':'); i >= 0 {
		port := raw[i+1:]
		if pidx := strings.IndexByte(port, '/'); pidx >= 0 {
			port = port[:pidx]
		}
		if isAllDigits(port) {
			if port == "80" || port == "443" || port == "22" {
				raw = raw[:i]
			} else {
				raw = raw[:i] + ":" + port
			}
		} else {
			// 非数字：SCP 风格的 path（如 git@github.com:foo/bar.git 的 foo），直接 strip
			raw = raw[:i]
		}
	}
	if i := strings.IndexByte(raw, '/'); i >= 0 {
		raw = raw[:i]
	}
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// isAllDigits 判断字符串非空且全是 ASCII 数字
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
