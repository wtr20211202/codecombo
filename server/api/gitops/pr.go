package gitops

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"codecombo/server/git"
	"codecombo/server/git/auth"
	"codecombo/server/git/auth/platforms"

	shared "codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// parseRemoteURL 从 git remote URL 提取 host / owner / repo。
// 不再做平台关键字匹配——平台识别完全交给 platforms.Match。
// 支持 HTTPS、SCP（git@host:owner/repo）、ssh:// 三种形态。
func parseRemoteURL(rawURL string) (host, owner, repo string, err error) {
	// HTTPS / HTTP: https://host[:port]/owner/repo[.git]
	if strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://") {
		u, e := url.Parse(rawURL)
		if e != nil {
			return "", "", "", fmt.Errorf("parse url: %w", e)
		}
		host = u.Host
		path := strings.Trim(u.Path, "/")
		parts := strings.SplitN(path, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return "", "", "", fmt.Errorf("invalid url path: %s", u.Path)
		}
		owner = parts[0]
		repo = strings.TrimSuffix(parts[1], ".git")
		return host, owner, repo, nil
	}

	// ssh://[user@]host[:port]/owner/repo[.git]
	if strings.HasPrefix(rawURL, "ssh://") {
		s := strings.TrimPrefix(rawURL, "ssh://")
		// 去掉 user@
		if at := strings.Index(s, "@"); at >= 0 {
			s = s[at+1:]
		}
		// s = host[:port]/owner/repo
		slash := strings.Index(s, "/")
		if slash < 0 {
			return "", "", "", fmt.Errorf("invalid ssh url: %s", rawURL)
		}
		host = s[:slash]
		path := strings.Trim(s[slash:], "/")
		parts := strings.SplitN(path, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return "", "", "", fmt.Errorf("invalid ssh url path: %s", rawURL)
		}
		owner = parts[0]
		repo = strings.TrimSuffix(parts[1], ".git")
		return host, owner, repo, nil
	}

	// SCP-like: git@host:owner/repo[.git]
	if strings.HasPrefix(rawURL, "git@") || strings.Contains(rawURL, ":") {
		colon := strings.Index(rawURL, ":")
		if colon < 0 {
			return "", "", "", fmt.Errorf("invalid scp url: %s", rawURL)
		}
		host = rawURL[:colon]
		// 去掉可能的 user@ 前缀
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		path := rawURL[colon+1:]
		parts := strings.SplitN(path, "/", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return "", "", "", fmt.Errorf("invalid scp path: %s", rawURL)
		}
		owner = parts[0]
		repo = strings.TrimSuffix(parts[1], ".git")
		return host, owner, repo, nil
	}

	return "", "", "", fmt.Errorf("unsupported remote url: %s", rawURL)
}

// buildPRURL 用 PlatformAdapter 构造 PR/MR 创建 URL。
// adapter 若实现 PRURLBuilder 则用其专属模板，否则兜底 /pulls/new。
func buildPRURL(adapter auth.PlatformAdapter, webURL, src, dst string) string {
	return auth.CreatePRURLOf(adapter, webURL, src, dst)
}

// CreatePullRequest 创建 Pull Request（打开浏览器）
// POST /api/projects/:id/create-pr
// 自动取当前分支作为 source branch；目标分支传空交由平台默认（main）。
func CreatePullRequest(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// 获取当前分支作为 source
	currentBranch, err := git.GetCurrentBranch(p.Path)
	if err != nil || currentBranch == "" {
		shared.Error(c, http.StatusBadRequest, "Cannot get current branch", nil)
		return
	}

	// 取 origin remote URL（fallback 第一个 remote）
	remotes, err := git.GetRemotes(p.Path)
	if err != nil || len(remotes) == 0 {
		shared.Error(c, http.StatusBadRequest, "No remote configured", nil)
		return
	}
	var remoteURL string
	for _, r := range remotes {
		if r.Name == "origin" {
			remoteURL = r.URL
			break
		}
	}
	if remoteURL == "" {
		remoteURL = remotes[0].URL
	}

	host, owner, repo, err := parseRemoteURL(remoteURL)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Cannot parse remote URL", nil)
		return
	}

	// 平台识别交给 PlatformAdapter 注册表（静态优先 → Probe 兜底 → Generic）
	adapter := platforms.Match(c.Request.Context(), host)
	webURL := fmt.Sprintf("https://%s/%s/%s", host, owner, repo)
	// source = 当前分支；target 取仓库默认分支（main），供 GitHub compare 模板使用
	// 其他平台（GitLab/Gitee/Generic）CreatePRURL 不使用 dst 参数
	prURL := buildPRURL(adapter, webURL, currentBranch, "main")

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"url":      prURL,
			"platform": adapter.ID(),
			"branch":   currentBranch,
			"owner":    owner,
			"repo":     repo,
		},
	})
}
