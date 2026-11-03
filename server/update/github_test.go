package update

import (
	"context"
	"net/http"
	"net/http/httptest"
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
