package platforms

import (
	"strings"

	"codecombo/server/git/auth"
)

// GenericAdapter 兜底：匹配所有 host；仅实现 HostMatcher + PRURLBuilder
type GenericAdapter struct{}

func (GenericAdapter) ID() string { return auth.PlatformGeneric }

// MatchHost 永远返回 true（兜底，必须在 Registry 末尾）
func (GenericAdapter) MatchHost(host string) bool { return true }

func (GenericAdapter) CreatePRURL(webURL, srcBranch, dstBranch string) string {
	return strings.TrimSuffix(webURL, "/") + "/pulls/new"
}
