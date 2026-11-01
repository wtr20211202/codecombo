package gitops

import (
	"context"
	"strings"
	"testing"

	"codecombo/server/git/auth"
	"codecombo/server/git/auth/platforms"
)

// TestBuildPRURL 覆盖 4 大平台的 PR/MR URL 构造。
// 平台识别完全交给 platforms.Match（静态注册表命中，不会触发网络 Probe）。
func TestBuildPRURL(t *testing.T) {
	cases := []struct {
		name     string
		webURL   string
		src, dst string
		want     string
	}{
		{
			name:   "github",
			webURL: "https://github.com/owner/repo",
			src:    "feature", dst: "main",
			want: "https://github.com/owner/repo/compare/main...feature?expand=1",
		},
		{
			name:   "gitlab",
			webURL: "https://gitlab.com/owner/repo",
			src:    "feature", dst: "main",
			want: "https://gitlab.com/owner/repo/-/merge_requests/new?merge_request[source_branch]=feature&merge_request[target_branch]=main",
		},
		{
			name:   "gitea",
			webURL: "https://gitea.com/owner/repo",
			src:    "feature", dst: "main",
			want: "https://gitea.com/owner/repo/compare/main...feature",
		},
		{
			name:   "gitee",
			webURL: "https://gitee.com/owner/repo",
			src:    "feature", dst: "main",
			want: "https://gitee.com/owner/repo/pulls/new?head=feature",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			adapter := matchForURL(c.webURL)
			if adapter == nil {
				t.Fatalf("no adapter matched")
			}
			got := buildPRURL(adapter, c.webURL, c.src, c.dst)
			if got != c.want {
				t.Errorf("got  = %q\nwant = %q", got, c.want)
			}
		})
	}
}

// matchForURL 测试辅助：从 webURL 提取 host 后调 platforms.Match。
// 对 github.com / gitlab.com / gitea.com / gitee.com 四大静态注册表 host，
// Match 不会触发 Probe 网络调用。
func matchForURL(webURL string) auth.PlatformAdapter {
	host := stripScheme(webURL)
	// 仅取 host 部分（去掉 path）
	if i := strings.Index(host, "/"); i >= 0 {
		host = host[:i]
	}
	return platforms.Match(context.Background(), host)
}

func stripScheme(s string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(s, prefix) {
			return s[len(prefix):]
		}
	}
	return s
}

// TestParseRemoteURL 覆盖 SSH / HTTPS / SCP 三种 remote URL 形态。
func TestParseRemoteURL(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantHost  string
		wantOwner string
		wantRepo  string
		wantErr   bool
	}{
		{
			name:      "https with .git",
			raw:       "https://github.com/owner/repo.git",
			wantHost:  "github.com",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "https without .git",
			raw:       "https://gitlab.com/group/sub.git",
			wantHost:  "gitlab.com",
			wantOwner: "group",
			wantRepo:  "sub",
		},
		{
			name:      "scp ssh form",
			raw:       "git@github.com:owner/repo.git",
			wantHost:  "github.com",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "ssh:// form",
			raw:       "ssh://git@gitea.com/owner/repo.git",
			wantHost:  "gitea.com",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:      "ssh:// with port",
			raw:       "ssh://git@gitea.com:2222/owner/repo.git",
			wantHost:  "gitea.com:2222",
			wantOwner: "owner",
			wantRepo:  "repo",
		},
		{
			name:    "unsupported scheme",
			raw:     "file:///path/to/repo",
			wantErr: true,
		},
		{
			name:    "empty",
			raw:     "",
			wantErr: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			host, owner, repo, err := parseRemoteURL(c.raw)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if host != c.wantHost {
				t.Errorf("host = %q, want %q", host, c.wantHost)
			}
			if owner != c.wantOwner {
				t.Errorf("owner = %q, want %q", owner, c.wantOwner)
			}
			if repo != c.wantRepo {
				t.Errorf("repo = %q, want %q", repo, c.wantRepo)
			}
		})
	}
}
