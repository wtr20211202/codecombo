package platforms

import (
	"fmt"
	"strings"

	"codecombo/server/git/auth"
)

// GitHubAdapter 匹配 github.com 及其子域；提供 OAuth / PR / Scope 能力
type GitHubAdapter struct{}

func (GitHubAdapter) ID() string { return auth.PlatformGitHub }

func (GitHubAdapter) MatchHost(host string) bool {
	return host == "github.com" || strings.HasSuffix(host, ".github.com")
}

func (GitHubAdapter) OAuthEndpoints(baseURL string) *auth.OAuthEndpoints {
	if baseURL == "" {
		baseURL = "https://github.com"
	}
	return &auth.OAuthEndpoints{
		DeviceCodeURL: baseURL + "/login/device/code",
		TokenURL:      baseURL + "/login/oauth/access_token",
		RevokeURL:     baseURL + "/applications/" + "{client_id}/token", // GitHub 需 Basic Auth
	}
}

func (GitHubAdapter) CreatePRURL(webURL, srcBranch, dstBranch string) string {
	return fmt.Sprintf("%s/compare/%s...%s?expand=1", strings.TrimSuffix(webURL, "/"), dstBranch, srcBranch)
}

func (GitHubAdapter) RecommendedScopes() []string {
	return []string{"repo", "workflow"}
}
