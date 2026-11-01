package platforms

import (
	"fmt"
	"strings"

	"codecombo/server/git/auth"
)

// GiteeAdapter 仅实现 HostMatcher + PRURLBuilder
// 不支持 OAuth Device Flow（Gitee 自家协议）；P0 仅 PAT
type GiteeAdapter struct{}

func (GiteeAdapter) ID() string { return auth.PlatformGitee }

func (GiteeAdapter) MatchHost(host string) bool {
	return host == "gitee.com"
}

func (GiteeAdapter) CreatePRURL(webURL, srcBranch, dstBranch string) string {
	return fmt.Sprintf("%s/pulls/new?head=%s", strings.TrimSuffix(webURL, "/"), srcBranch)
}
