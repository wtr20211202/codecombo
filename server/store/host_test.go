package store_test

import (
	"testing"

	"codecombo/server/store"
)

func TestHostFromURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"https 标准端口剥离", "https://github.com/foo/bar.git", "github.com"},
		{"http 标准端口剥离", "http://example.com/path", "example.com"},
		{"非标准端口保留", "http://localhost:3000/coding/repo.git", "localhost:3000"},
		{"SCP 风格 URL", "git@github.com:foo/bar.git", "github.com"},
		{"SCP 风格无 path", "git@github.com:foo.git", "github.com"},
		{"ssh 协议", "ssh://git@github.com/foo/bar.git", "github.com"},
		{"ssh 协议带端口", "ssh://git@gitea.com:2222/foo/bar.git", "gitea.com:2222"},
		{"末尾空格必须 trim", "localhost:3000 ", "localhost:3000"},
		{"前后空格必须 trim", "  localhost:3000  ", "localhost:3000"},
		{"大小写归一", "HTTP://LOCALHOST:3000/Path", "localhost:3000"},
		{"带用户信息", "https://user@github.com/repo", "github.com"},
		{"裸 host", "github.com", "github.com"},
		{"裸 host 带端口", "gitea.com:3000", "gitea.com:3000"},
		{"空字符串", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := store.HostFromURL(tc.in)
			if got != tc.want {
				t.Errorf("HostFromURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestHostFromURL_TrimSpaceRegression 专门回归一个真实线上 bug：
// 用户在前端输入 "localhost:3000 "（末尾带空格）保存凭据，导致推送时
// URL 解析出的 host "localhost:3000" 与数据库里的 "localhost:3000 " 不匹配，
// 凭据未注入，git 认证失败。
func TestHostFromURL_TrimSpaceRegression(t *testing.T) {
	savedHost := store.HostFromURL("localhost:3000 ") // 模拟数据库里历史脏数据
	urlHost := store.HostFromURL("http://localhost:3000/coding/simple-coding.git")
	if savedHost != urlHost {
		t.Errorf("host mismatch after normalize: saved=%q url=%q", savedHost, urlHost)
	}
}
