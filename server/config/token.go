package config

// TokenConfig API Token 配置模型
type TokenConfig struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	Prefix     string `json:"prefix"`
	ExpiresAt  string `json:"expiresAt"`
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt"`
}
