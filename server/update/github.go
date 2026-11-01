package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// GitHubSource GitHub Releases 更新源
type GitHubSource struct {
	RepoURL string // 如 https://api.github.com/repos/user/simple-coding
	client  *http.Client
}

// NewGitHubSource 创建 GitHub 更新源。
// 仅接受 https 的公网地址（更新承载可执行文件，通道安全是供应链第一道闸），
// 不合法时返回错误由调用方决定提示方式
func NewGitHubSource(repoURL string) (*GitHubSource, error) {
	if err := ValidatePublicHTTPSURL(repoURL); err != nil {
		return nil, err
	}
	return &GitHubSource{
		RepoURL: strings.TrimRight(repoURL, "/"),
		client:  &http.Client{Timeout: 30 * time.Second, Transport: newSafeTransport()},
	}, nil
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

// FetchLatest 获取最新 Release 信息
func (s *GitHubSource) FetchLatest(ctx context.Context, platform, arch string) (*ReleaseInfo, error) {
	url := s.RepoURL + "/releases/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request failed: %w", err)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return nil, fmt.Errorf("github api returned %d: %s", resp.StatusCode, string(body))
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode release failed: %w", err)
	}

	// 查找匹配平台的 asset：产物名模板双认（P-20261025-1 标识切换）——
	// codecombo-{os}-{arch} 优先（新发布物），simple-coding-{os}-{arch} 回落
	// （更新源过渡期仍挂旧名资产的形态）；伴生校验资产（.sha256/.sig）随所
	// 匹配的产物名同源拉取，杜绝新旧名交叉取样的供应链错配
	target := ""
	downloadURL := ""
	fileSize := int64(0)
	for _, candidate := range assetNameCandidates(platform, arch) {
		for _, asset := range release.Assets {
			if asset.Name == candidate {
				target = candidate
				downloadURL = asset.BrowserDownloadURL
				fileSize = asset.Size
				break
			}
		}
		if target != "" {
			break
		}
	}
	if target != "" {
		version := strings.TrimPrefix(release.TagName, "v")
		info := &ReleaseInfo{
			Version:     version,
			Changelog:   release.Body,
			DownloadURL: downloadURL,
			FileSize:    fileSize,
		}
		// 伴随校验资产（安全 backlog A5）：<二进制名>.sha256 / <二进制名>.sig。
		// 存在则拉取内容填充校验字段；缺失则留空，由 ApplyUpdate 按无校验策略处理
		for _, companion := range release.Assets {
			switch companion.Name {
			case target + ".sha256":
				if data, err := s.fetchSmall(ctx, companion.BrowserDownloadURL); err == nil {
					info.ChecksumSHA256 = data
				}
			case target + ".sig":
				if data, err := s.fetchSmall(ctx, companion.BrowserDownloadURL); err == nil {
					info.Signature = data
				}
			}
		}
		return info, nil
	}

	return nil, fmt.Errorf("no asset found for %s/%s (looking for %s)", platform, arch, assetName(platform, arch))
}

// fetchSmall 拉取小文本资产（checksum / 签名文件），上限 64KB
func (s *GitHubSource) fetchSmall(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: status %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// assetName 根据平台生成 asset 文件名（正名，首个候选）
func assetName(platform, arch string) string {
	return assetNameCandidates(platform, arch)[0]
}

// assetNameCandidates 产物名候选序：正名 codecombo-{os}-{arch} 优先，旧名
// simple-coding-{os}-{arch} 回落（更新源资产新旧名过渡期双认，P-20261025-1）
func assetNameCandidates(platform, arch string) []string {
	ext := ""
	if platform == "windows" {
		ext = ".exe"
	}
	return []string{
		fmt.Sprintf("codecombo-%s-%s%s", platform, arch, ext),
		fmt.Sprintf("simple-coding-%s-%s%s", platform, arch, ext),
	}
}

// DetectPlatform 检测当前平台
func DetectPlatform() (os string, arch string) {
	return runtime.GOOS, runtime.GOARCH
}
