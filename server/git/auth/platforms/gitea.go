package platforms

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"codecombo/server/git/auth"
)

// probeClient 仅供 Probe 探测用的 HTTP client
//
// 单独抽出原因：
//   - http.DefaultClient 无 Timeout，平台不可达时挂 30s+
//   - Match 已在外层加 5s ctx 超时，client 层再加一道双保险
//   - 与正式 OAuth / API 调用用的 client 隔离（连接池 / TLS 配置互不影响）
var probeClient = &http.Client{Timeout: 5 * time.Second}

// GiteaAdapter 匹配 gitea.com 及自建实例（通过 Probe 探测）；提供 OAuth / PR / Scope 能力
type GiteaAdapter struct{}

func (GiteaAdapter) ID() string { return auth.PlatformGitea }

func (GiteaAdapter) MatchHost(host string) bool {
	return host == "gitea.com" || strings.HasSuffix(host, ".gitea.com")
}

func (GiteaAdapter) Probe(ctx context.Context, baseURL string) (bool, error) {
	if baseURL == "" {
		baseURL = "https://gitea.com"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/api/v1/version", nil)
	if err != nil {
		return false, err
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return false, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	var v struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return false, nil
	}
	// 校验 Version 非空，避免任何 200 + JSON 的端点被误判为 Gitea
	return v.Version != "", nil
}

func (GiteaAdapter) OAuthEndpoints(baseURL string) *auth.OAuthEndpoints {
	if baseURL == "" {
		baseURL = "https://gitea.com"
	}
	return &auth.OAuthEndpoints{
		DeviceCodeURL: baseURL + "/login/oauth/device_code",
		TokenURL:      baseURL + "/login/oauth/access_token",
		RevokeURL:     baseURL + "/login/oauth/revoke",
	}
}

func (GiteaAdapter) CreatePRURL(webURL, srcBranch, dstBranch string) string {
	return fmt.Sprintf("%s/compare/%s...%s", strings.TrimSuffix(webURL, "/"), dstBranch, srcBranch)
}

func (GiteaAdapter) RecommendedScopes() []string {
	return []string{"read", "write"}
}
