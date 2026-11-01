package auth

import "context"

// Platform 常量：平台唯一标识（与各 adapter 的 ID() 返回值保持一致）
// 消除 "github" / "gitlab" / "gitea" / "gitee" / "generic" 字面量散落导致的拼写错误
const (
	PlatformGitHub  = "github"
	PlatformGitLab  = "gitlab"
	PlatformGitea   = "gitea"
	PlatformGitee   = "gitee"
	PlatformGeneric = "generic"
)

// PlatformAdapter 是最小契约：仅含平台 ID + Host 匹配
// 其他能力（OAuth 端点、PR URL、scope 推荐等）通过接口断言按需查询
type PlatformAdapter interface {
	// ID 返回平台唯一标识："github" / "gitlab" / "gitea" / "gitee" / "generic"
	ID() string

	// MatchHost 判断该 adapter 是否匹配某 host
	// Registry 按 PlatformRegistry 顺序遍历，命中即返回
	MatchHost(host string) bool
}

// 能力小接口（ISP）：平台按需实现

// PlatformProber 探测兜底：注册到 ProbeRegistry
// 用于 host 不在静态注册表但可能匹配（如自建 Gitea）的场景
type PlatformProber interface {
	Probe(ctx context.Context, baseURL string) (bool, error)
}

// OAuthCapable 表示该平台支持 OAuth
// 返回 nil 表示该平台/该 host 不支持 OAuth
type OAuthCapable interface {
	OAuthEndpoints(baseURL string) *OAuthEndpoints
}

// PRURLBuilder 构造 PR/MR 创建 URL
type PRURLBuilder interface {
	CreatePRURL(webURL, srcBranch, dstBranch string) string
}

// ScopeAdvisor 推荐该平台 OAuth 授权时的 scope 列表
type ScopeAdvisor interface {
	RecommendedScopes() []string
}

// 能力查询辅助函数

// OAuthEndpointsOf 取 adapter 的 OAuth 端点；不支持 OAuth 则返回 nil
func OAuthEndpointsOf(a PlatformAdapter, baseURL string) *OAuthEndpoints {
	if c, ok := a.(OAuthCapable); ok {
		return c.OAuthEndpoints(baseURL)
	}
	return nil
}

// CreatePRURLOf 取 adapter 的 PR 创建 URL；不支持则兜底 pulls/new
func CreatePRURLOf(a PlatformAdapter, webURL, src, dst string) string {
	if b, ok := a.(PRURLBuilder); ok {
		return b.CreatePRURL(webURL, src, dst)
	}
	// 兜底：pulls/new
	return webURL + "/pulls/new"
}

// ScopesOf 取 adapter 推荐的 scope 列表；不支持则返回 nil
func ScopesOf(a PlatformAdapter) []string {
	if s, ok := a.(ScopeAdvisor); ok {
		return s.RecommendedScopes()
	}
	return nil
}
