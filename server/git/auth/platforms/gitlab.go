package platforms

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"codecombo/server/git/auth"
)

// GitLabAdapter P0 仅支持 PAT；OAuth Web Flow 拆 P1
// 因此只实现 HostMatcher + PlatformProber + PRURLBuilder
type GitLabAdapter struct{}

func (GitLabAdapter) ID() string { return auth.PlatformGitLab }

func (GitLabAdapter) MatchHost(host string) bool {
	return host == "gitlab.com" || strings.HasSuffix(host, ".gitlab.com")
}

func (GitLabAdapter) Probe(ctx context.Context, baseURL string) (bool, error) {
	if baseURL == "" {
		baseURL = "https://gitlab.com"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/api/v4/version", nil)
	if err != nil {
		return false, err
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return false, nil // 网络错误视为不匹配
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	var v struct {
		Version  string `json:"version"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return false, nil
	}
	// 简化校验：Version 非空即可（原 HasPrefix("1") 已被后者覆盖，冗余）
	return v.Version != "", nil
}

func (GitLabAdapter) CreatePRURL(webURL, srcBranch, dstBranch string) string {
	return fmt.Sprintf("%s/-/merge_requests/new?merge_request[source_branch]=%s&merge_request[target_branch]=%s",
		strings.TrimSuffix(webURL, "/"), srcBranch, dstBranch)
}
