package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ErrReleaseNotFound 端点 404（fetchRelease 包裹，errors.Is 可判）——
// GitHubSource 之外的中心分发路径同样消费此哨兵（文案不改语义）
var ErrReleaseNotFound = errors.New("release not found")

// ErrNoStableRelease stable 通道无正式版：/releases/latest 恒排 prerelease，
// 仓库只有 beta/rc 时 404。这是「通道空」不是「没配源」——beta.2 曾把它吞成
// hasUpdate:false、前端再依分发源字段为空误报「未配置更新分发源」（实锚：
// 用户实例源回填正常、stable 通道 404，弹了误导提示）
var ErrNoStableRelease = errors.New("no stable release on the stable channel yet")

// GitHubSource GitHub Releases 更新源
type GitHubSource struct {
	RepoURL string // 如 https://api.github.com/repos/user/simple-coding
	client  *http.Client
	// IncludePrerelease 预发布通道（P-20261103-3）：false=只认最新稳定版
	//（/releases/latest 语义）；true=取发布时间最新的 release（含 beta/rc）。
	// GitHub 的 /releases/latest 恒排 prerelease，想跟进 beta/rc 必须走列表端点
	IncludePrerelease bool
}

// NewGitHubSource 创建 GitHub 更新源。
// 仅接受 https 的公网地址（更新承载可执行文件，通道安全是供应链第一道闸），
// 不合法时返回错误由调用方决定提示方式
func NewGitHubSource(repoURL string) (*GitHubSource, error) {
	if err := ValidatePublicHTTPSURL(repoURL); err != nil {
		return nil, err
	}
	return &GitHubSource{
		RepoURL: normalizeGitHubAPI(strings.TrimRight(repoURL, "/")),
		// safeRoundTripper：出站路径每请求现选（显式代理/env 代理/直连三态，
		// P-20261109-12）——设置保存即生效，无须重建源
		client: &http.Client{Timeout: 30 * time.Second, Transport: safeRoundTripper{}},
	}, nil
}

// normalizeGitHubAPI 网页仓库地址归一到 REST API 端点：github.com/<o>/<r> →
// api.github.com/repos/<o>/<r>。UpdateURLOfficial 是网页形态（设置里可读可
// 跳转），而本源的取数端点全按 API 形态拼接——beta.2 实锚：缺这步归一，检查
// 打的是网页 HTML，JSON 解码必炸，一切检查恒败并被吞成 hasUpdate:false，
// 前端再误报「未配置更新分发源」（beta.1 起的死洞；此前 httptest 直构 API
// 形态 URL 绕过了它，测试全绿假象）。API 形态直传不动（带 API token 的场景）
func normalizeGitHubAPI(raw string) string {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil {
		return raw
	}
	host := strings.ToLower(u.Hostname())
	if host == "github.com" || host == "www.github.com" {
		return "https://api.github.com/repos" + u.Path
	}
	return raw
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
	var release *githubRelease
	if s.IncludePrerelease {
		// 预发布通道：/releases 按创建时间倒序列全量（含 prerelease），
		// 取第一个带本平台产物的 release——「最新可装」语义
		rel, err := s.fetchLatestIncludingPrerelease(ctx, platform, arch)
		if err != nil {
			return nil, err
		}
		release = rel
	} else {
		rel, err := s.fetchRelease(ctx, s.RepoURL+"/releases/latest")
		if err != nil {
			// 404=仓库无正式版（全为 prerelease 被端点排除）→「通道空」类型化，
			// 让 API 层与「网络失败/源非法」区分开
			if errors.Is(err, ErrReleaseNotFound) {
				return nil, ErrNoStableRelease
			}
			return nil, err
		}
		release = rel
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
		// 三态（P-20261109-9）：不在列表=缺失（留空，ApplyUpdate 按无校验策略
		// 处理）；在列表且拉到=填内容；在列表但拉取失败=填 *FetchErr 原因（旧
		// 实现吞错，拉取失败被误报成「release 没提供」）。check 期急切拉取不
		// 懒加载——面板据此即时提示「更新将被拒」，不等用户点了更新才暴露
		s.fetchCompanions(ctx, release, target, info)
		return info, nil
	}

	return nil, fmt.Errorf("no asset found for %s/%s (looking for %s)", platform, arch, assetName(platform, arch))
}

// 伴随资产拉取预算（P-20261109-9）：单资产一份总预算（context.WithTimeout）
// 覆盖全部尝试与退避，两资产并发——坏链路下 check 最坏耗时由旧口径「client
// 30s × 两文件串行 = 60s」收到一份预算；首试 + 2 次退避重试吸收连接重置 /
// DNS 抖动 / CDN 5xx 等瞬时故障。主包下载的重试牵动状态机（进度/半截文件），
// 另立不并入。包级变量便于测试压缩时长
var (
	companionFetchBudget   = 10 * time.Second
	companionFetchAttempts = 3
	// companionRetryBackoff 第 n 次重试前的退避（n 从 1 起：500ms、1s）
	companionRetryBackoff = func(retry int) time.Duration {
		return time.Duration(250<<retry) * time.Millisecond
	}
)

// errEmptyCompanion 伴随资产拉到空内容：在列表即「release 提供了」，空内容按
// 拉取失败计，不退化成「缺失」被误报为没提供；确定性结果不重试
var errEmptyCompanion = errors.New("empty content")

// companionStatusError 伴随资产非 200 响应（重试判定按状态码分流）
type companionStatusError struct {
	url    string
	status int
}

func (e *companionStatusError) Error() string {
	return fmt.Sprintf("fetch %s: status %d", e.url, e.status)
}

// fetchCompanions 并发拉取本产物的伴随校验资产，按三态填充 info
func (s *GitHubSource) fetchCompanions(ctx context.Context, release *githubRelease, target string, info *ReleaseInfo) {
	var checksumURL, sigURL string
	var hasChecksum, hasSig bool
	for _, asset := range release.Assets {
		switch {
		case asset.Name == target+".sha256" && !hasChecksum:
			checksumURL, hasChecksum = asset.BrowserDownloadURL, true
		case asset.Name == target+".sig" && !hasSig:
			sigURL, hasSig = asset.BrowserDownloadURL, true
		}
	}
	var wg sync.WaitGroup
	// 两 goroutine 各写本资产的一对字段（内存位置不重叠），wg.Wait 建立先行关系。
	// 拉取失败逐资产 slog.Warn：主进程日志镜像 stderr，是该失败的落点之一
	//（update.log 属 _do_update 子进程，伴随拉取在主进程，那里记录不到）
	fetch := func(name, url string, content, fetchErr *string) {
		defer wg.Done()
		data, err := s.fetchCompanion(ctx, url)
		if err != nil {
			slog.Warn("update: companion asset fetch failed", "asset", name, "err", err)
			*fetchErr = err.Error()
			return
		}
		*content = data
	}
	if hasChecksum {
		wg.Add(1)
		go fetch(target+".sha256", checksumURL, &info.ChecksumSHA256, &info.ChecksumFetchErr)
	}
	if hasSig {
		wg.Add(1)
		go fetch(target+".sig", sigURL, &info.Signature, &info.SigFetchErr)
	}
	wg.Wait()
}

// fetchCompanion 单资产有限重试：总预算 companionFetchBudget、至多
// companionFetchAttempts 次；仅瞬时故障（传输错误/5xx/429）重试，404 等确定性
// 失败、预算耗尽与外层取消立即收手。失败原因附尝试次数与预算耗尽注记，
// 便于区分「一次就确定失败」「反复抖动」「链路慢到超预算」
func (s *GitHubSource) fetchCompanion(ctx context.Context, url string) (string, error) {
	bctx, cancel := context.WithTimeout(ctx, companionFetchBudget)
	defer cancel()
	attempt := 0
	var lastErr error
	for {
		attempt++
		data, err := s.fetchSmall(bctx, url)
		if err == nil && data == "" {
			err = errEmptyCompanion
		}
		if err == nil {
			return data, nil
		}
		lastErr = err
		if attempt >= companionFetchAttempts || !retryableCompanionErr(err) ||
			!sleepCtx(bctx, companionRetryBackoff(attempt)) {
			break
		}
	}
	note := "after 1 attempt"
	if attempt > 1 {
		note = fmt.Sprintf("after %d attempts", attempt)
	}
	if errors.Is(bctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		note += fmt.Sprintf(", %s budget exhausted", companionFetchBudget)
	}
	return "", fmt.Errorf("%w (%s)", lastErr, note)
}

// retryableCompanionErr 瞬时故障判定：HTTP 5xx/429 与传输层错误（连接重置/
// DNS/握手超时）可重试；其余状态码（404/403 等）与空内容是确定性结果
func retryableCompanionErr(err error) bool {
	if errors.Is(err, errEmptyCompanion) {
		return false
	}
	var se *companionStatusError
	if errors.As(err, &se) {
		return se.status >= 500 || se.status == http.StatusTooManyRequests
	}
	return true
}

// sleepCtx 可取消的等待：等满返回 true，ctx 先结束返回 false
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// redactURLError 剥掉 *url.Error 里请求地址的查询串：GitHub 资产经 302 跳到
// 预签名 CDN 地址，签名参数数百字符，原样进面板/错误条不可读——host+path
// 足以定位是哪一跳失败
func redactURLError(err error) error {
	var ue *url.Error
	if !errors.As(err, &ue) {
		return err
	}
	u, perr := url.Parse(ue.URL)
	if perr != nil || u.RawQuery == "" {
		return err
	}
	u.RawQuery = ""
	return &url.Error{Op: ue.Op, URL: u.String(), Err: ue.Err}
}

// fetchLatestIncludingPrerelease 列表端点取首个含本平台产物的 release
// （/releases 倒序即最新创建；列表上限 30 条/页，足够覆盖近况）
func (s *GitHubSource) fetchLatestIncludingPrerelease(ctx context.Context, platform, arch string) (*githubRelease, error) {
	for _, rel := range []struct {
		url  string
		mult bool
	}{{s.RepoURL + "/releases?per_page=30", true}} {
		data, err := s.fetchJSON(ctx, rel.url)
		if err != nil {
			return nil, err
		}
		var releases []githubRelease
		if err := json.Unmarshal(data, &releases); err != nil {
			return nil, fmt.Errorf("decode releases failed: %w", err)
		}
		for i := range releases {
			if releaseHasPlatformAsset(&releases[i], platform, arch) {
				return &releases[i], nil
			}
		}
	}
	return nil, fmt.Errorf("no release with asset for %s/%s", platform, arch)
}

// releaseHasPlatformAsset 判断 release 是否携带本平台产物（双名模板任一命中）
func releaseHasPlatformAsset(r *githubRelease, platform, arch string) bool {
	for _, candidate := range assetNameCandidates(platform, arch) {
		for _, asset := range r.Assets {
			if asset.Name == candidate {
				return true
			}
		}
	}
	return false
}

// fetchRelease 拉取单个 release 端点并解码
func (s *GitHubSource) fetchRelease(ctx context.Context, url string) (*githubRelease, error) {
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
		if resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("github api returned 404: %w", ErrReleaseNotFound)
		}
		return nil, fmt.Errorf("github api returned %d: %s", resp.StatusCode, string(body))
	}
	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode release failed: %w", err)
	}
	return &release, nil
}

// fetchJSON GET 端点返回原始 JSON 字节
func (s *GitHubSource) fetchJSON(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request failed: %w", err)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s failed: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		if resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("github api returned 404: %w", ErrReleaseNotFound)
		}
		return nil, fmt.Errorf("github api returned %d: %s", resp.StatusCode, string(body))
	}
	return io.ReadAll(io.LimitReader(resp.Body, 512<<10))
}

// fetchSmall 拉取小文本资产（checksum / 签名文件），上限 64KB。单次尝试——
// 重试与预算由调用方 fetchCompanion 负责
func (s *GitHubSource) fetchSmall(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", redactURLError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &companionStatusError{url: url, status: resp.StatusCode}
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
