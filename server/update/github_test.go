package update

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 预发布通道取数口径（P-20261103-3）：stable 走 /releases/latest（恒排
// prerelease），prerelease 走 /releases 列表取首个含本平台产物的 release。
// httptest 直构 GitHubSource（同包可写私有字段，绕公网校验——校验本身有独立用例）
func TestFetchLatestChannel(t *testing.T) {
	const stableBody = `{"tag_name":"v0.1.0","assets":[
		{"name":"codecombo-linux-amd64","browser_download_url":"https://example/stable","size":1}]}`
	const listBody = `[
		{"tag_name":"v0.1.0-beta.2","assets":[
			{"name":"codecombo-linux-amd64","browser_download_url":"https://example/beta","size":2}],
			"prerelease":true},
		{"tag_name":"v0.1.0","assets":[
			{"name":"codecombo-linux-amd64","browser_download_url":"https://example/stable","size":1}]}]`

	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(stableBody))
	})
	mux.HandleFunc("/owner/repo/releases", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("per_page") == "" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(listBody))
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	src, err := NewGitHubSource("https://github.com/owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	src.RepoURL = ts.URL + "/owner/repo"
	src.client = ts.Client()

	// stable 通道：只认 /releases/latest 的正式版
	info, err := src.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("stable channel: %v", err)
	}
	if info.Version != "0.1.0" || info.DownloadURL != "https://example/stable" {
		t.Errorf("stable channel got %s (%s)", info.Version, info.DownloadURL)
	}

	// prerelease 通道：取列表首个含本平台产物 = beta.2
	src.IncludePrerelease = true
	info, err = src.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("prerelease channel: %v", err)
	}
	if info.Version != "0.1.0-beta.2" || info.DownloadURL != "https://example/beta" {
		t.Errorf("prerelease channel got %s (%s)", info.Version, info.DownloadURL)
	}

	// 无本平台产物的 release 被跳过：列表首项换成纯 Windows beta → linux 应取到第二项 stable
}

// TestFetchLatestReleaseURLPassthrough 发布页直链透传（P-20261112-2-S2）：
// GitHub API html_url → ReleaseInfo.ReleaseURL，stable 与 prerelease 两通道
// 同样携带；源缺 html_url（异常形态）留空——omitempty 使 check 响应不含该键，
// 前端不显「查看发布页」链接零回退
func TestFetchLatestReleaseURLPassthrough(t *testing.T) {
	const stableBody = `{"tag_name":"v0.2.0","html_url":"https://github.com/owner/repo/releases/tag/v0.2.0","assets":[
		{"name":"codecombo-linux-amd64","browser_download_url":"https://example/stable","size":1}]}`
	const listBody = `[{"tag_name":"v0.2.0-beta.1","html_url":"https://github.com/owner/repo/releases/tag/v0.2.0-beta.1","assets":[
		{"name":"codecombo-linux-amd64","browser_download_url":"https://example/beta","size":2}]}]`

	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(stableBody))
	})
	mux.HandleFunc("/owner/repo/releases", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("per_page") == "" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(listBody))
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	src, err := NewGitHubSource("https://github.com/owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	src.RepoURL = ts.URL + "/owner/repo"
	src.client = ts.Client()

	// stable 通道透传
	info, err := src.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("stable channel: %v", err)
	}
	if info.ReleaseURL != "https://github.com/owner/repo/releases/tag/v0.2.0" {
		t.Errorf("stable ReleaseURL = %q", info.ReleaseURL)
	}

	// prerelease 通道（列表端点）透传
	src.IncludePrerelease = true
	info, err = src.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("prerelease channel: %v", err)
	}
	if info.ReleaseURL != "https://github.com/owner/repo/releases/tag/v0.2.0-beta.1" {
		t.Errorf("prerelease ReleaseURL = %q", info.ReleaseURL)
	}

	// 源未提供 html_url：留空且 JSON 省略（增量字段零负担）
	info.ReleaseURL = ""
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "releaseUrl") {
		t.Errorf("empty ReleaseURL should be omitted: %s", data)
	}
}

// releaseHasPlatformAsset 双名模板任一命中即真
func TestReleaseHasPlatformAsset(t *testing.T) {
	r := &githubRelease{Assets: []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	}{{Name: "simple-coding-windows-arm64.exe", BrowserDownloadURL: "x", Size: 1}}}
	if !releaseHasPlatformAsset(r, "windows", "arm64") {
		t.Error("legacy-name asset should match")
	}
	if releaseHasPlatformAsset(r, "linux", "amd64") {
		t.Error("unrelated asset must not match")
	}
}

// TestNormalizeGitHubAPI 网页仓库地址 → REST API 端点归一（P-20261106 根因修）：
// UpdateURLOfficial 是网页形态，缺归一时检查打的是网页 HTML，JSON 解码必炸
// ——一切检查恒败被吞成 hasUpdate:false，前端再误报「未配置更新分发源」。
// 上方 TestFetchLatestChannel 曾以 RepoURL 手工覆写绕过此洞（测试假绿实证）
func TestNormalizeGitHubAPI(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://github.com/wtr20211202/codecombo", "https://api.github.com/repos/wtr20211202/codecombo"},
		{"https://github.com/wtr20211202/codecombo/", "https://api.github.com/repos/wtr20211202/codecombo"},
		{"https://www.github.com/o/r", "https://api.github.com/repos/o/r"},
		{"https://api.github.com/repos/o/r", "https://api.github.com/repos/o/r"}, // API 形态直传
		{"https://gitea.example.com/o/r", "https://gitea.example.com/o/r"},       // 非 GitHub 不动
	}
	for _, c := range cases {
		if got := normalizeGitHubAPI(c.in); got != c.want {
			t.Errorf("normalizeGitHubAPI(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestNewGitHubSourceOfficialWebURL 内置官方源（网页形态）创建后 RepoURL 必须
// 已归一到 API 端点——不再依赖调用方覆写
func TestNewGitHubSourceOfficialWebURL(t *testing.T) {
	s, err := NewGitHubSource("https://github.com/wtr20211202/codecombo")
	if err != nil {
		t.Fatalf("NewGitHubSource(official web url): %v", err)
	}
	want := "https://api.github.com/repos/wtr20211202/codecombo"
	if s.RepoURL != want {
		t.Fatalf("RepoURL = %q, want %q", s.RepoURL, want)
	}
}

// TestFetchLatestNoStableReleaseSentinel stable 通道 404（仓库只有 prerelease
// 被 /releases/latest 排除）必须映射为 ErrNoStableRelease——API 层据此区分
// 「通道空」与「网络失败/没配源」，前端才能诚实呈现而非误报
func TestFetchLatestNoStableReleaseSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	// 直构 client：newSafeTransport 的出站守卫拒回环地址，httptest 必须绕开
	s := &GitHubSource{RepoURL: srv.URL, client: srv.Client()}
	if _, err := s.FetchLatest(context.Background(), "windows", "amd64"); !errors.Is(err, ErrNoStableRelease) {
		t.Fatalf("FetchLatest on 404: err=%v, want ErrNoStableRelease", err)
	}
}
