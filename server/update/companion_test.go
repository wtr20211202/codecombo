package update

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 伴随校验资产三态 + 有限重试（P-20261109-9）：旧实现 err==nil 才填充、拉取
// 错误静默留空，拉取失败与「release 真没提供」同形，verify 误报后者（beta.3
// 用户实锚：资产在位）。httptest 直构 GitHubSource（同包私有字段绕公网校验，
// 同 TestFetchLatestChannel 先例）

const testBinary = "codecombo-linux-amd64"

// companionRelease 起一个 release 端点 + 资产下载端点：列表含本平台二进制与
// companions 键名的伴随资产（键不在 map 里 = 真缺失），各资产行为由 handler 定
func companionRelease(t *testing.T, companions map[string]http.HandlerFunc) *GitHubSource {
	t.Helper()
	mux := http.NewServeMux()
	var ts *httptest.Server
	mux.HandleFunc("/owner/repo/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		type asset struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		}
		assets := []asset{{Name: testBinary, URL: ts.URL + "/dl/" + testBinary, Size: 1}}
		for name := range companions {
			assets = append(assets, asset{Name: name, URL: ts.URL + "/dl/" + name, Size: 1})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v0.0.2", "assets": assets})
	})
	for name, h := range companions {
		mux.HandleFunc("/dl/"+name, h)
	}
	ts = httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &GitHubSource{RepoURL: ts.URL + "/owner/repo", client: ts.Client()}
}

// shrinkCompanionTiming 压缩预算与退避（包级变量，测试后恢复）
func shrinkCompanionTiming(t *testing.T, budget time.Duration) {
	t.Helper()
	oldBudget, oldBackoff := companionFetchBudget, companionRetryBackoff
	companionFetchBudget = budget
	companionRetryBackoff = func(int) time.Duration { return 5 * time.Millisecond }
	t.Cleanup(func() { companionFetchBudget, companionRetryBackoff = oldBudget, oldBackoff })
}

func respondBody(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }
}

func respondStatus(code int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }
}

// counted 包一层到达计数（重试次数断言）
func counted(n *int32, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(n, 1)
		h(w, r)
	}
}

// hang 挂住直到客户端放弃（预算/取消路径）；10s 兜底防 ts.Close 等死
func hang(_ http.ResponseWriter, r *http.Request) {
	select {
	case <-r.Context().Done():
	case <-time.After(10 * time.Second):
	}
}

func fetchInfo(t *testing.T, src *GitHubSource) *ReleaseInfo {
	t.Helper()
	info, err := src.FetchLatest(context.Background(), "linux", "amd64")
	if err != nil {
		t.Fatalf("FetchLatest: %v", err)
	}
	return info
}

func TestFetchLatestCompanionThreeState(t *testing.T) {
	shrinkCompanionTiming(t, 2*time.Second)

	t.Run("已获取：内容填充、无拉取错误", func(t *testing.T) {
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{
			testBinary + ".sha256": respondBody("abc123\n"),
			testBinary + ".sig":    respondBody("c2ln"),
		}))
		if info.ChecksumSHA256 != "abc123" || info.Signature != "c2ln" {
			t.Errorf("content = %q / %q", info.ChecksumSHA256, info.Signature)
		}
		if info.CompanionFetchFailed() {
			t.Errorf("unexpected fetch error: %s", info.CompanionFetchError())
		}
	})

	t.Run("真缺失：不在列表即留空、不算拉取失败", func(t *testing.T) {
		info := fetchInfo(t, companionRelease(t, nil))
		if info.ChecksumSHA256 != "" || info.Signature != "" || info.CompanionFetchFailed() {
			t.Errorf("missing assets must stay empty without fetch error: %+v", info)
		}
	})

	t.Run("拉取失败：在列表但 404 记原因且不重试", func(t *testing.T) {
		var hits int32
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{
			testBinary + ".sha256": counted(&hits, respondStatus(http.StatusNotFound)),
			testBinary + ".sig":    respondBody("c2ln"),
		}))
		if info.ChecksumSHA256 != "" {
			t.Errorf("failed fetch must not fill content, got %q", info.ChecksumSHA256)
		}
		if !strings.Contains(info.ChecksumFetchErr, "status 404") || !strings.Contains(info.ChecksumFetchErr, "after 1 attempt") {
			t.Errorf("ChecksumFetchErr = %q, want status 404 after 1 attempt", info.ChecksumFetchErr)
		}
		if info.SigFetchErr != "" || info.Signature != "c2ln" {
			t.Errorf("sig should be fetched independently: %q / %q", info.Signature, info.SigFetchErr)
		}
		if got := atomic.LoadInt32(&hits); got != 1 {
			t.Errorf("404 is deterministic — want 1 attempt, got %d", got)
		}
	})

	t.Run("空内容按拉取失败计（在列表=release 提供了）", func(t *testing.T) {
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{
			testBinary + ".sha256": respondBody("  \n"),
		}))
		if !strings.Contains(info.ChecksumFetchErr, "empty content") {
			t.Errorf("ChecksumFetchErr = %q, want empty content", info.ChecksumFetchErr)
		}
	})
}

func TestFetchCompanionRetry(t *testing.T) {
	shrinkCompanionTiming(t, 2*time.Second)

	// flaky 前 n 次按 fail 应答，其后 200 + body
	flaky := func(n int32, fail http.HandlerFunc, body string) (http.HandlerFunc, *int32) {
		var hits int32
		return func(w http.ResponseWriter, r *http.Request) {
			if atomic.AddInt32(&hits, 1) <= n {
				fail(w, r)
				return
			}
			_, _ = w.Write([]byte(body))
		}, &hits
	}

	t.Run("5xx 两次后恢复：重试吸收瞬时故障", func(t *testing.T) {
		h, hits := flaky(2, respondStatus(http.StatusServiceUnavailable), "abc123")
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{testBinary + ".sha256": h}))
		if info.ChecksumSHA256 != "abc123" || info.ChecksumFetchErr != "" {
			t.Errorf("want recovered content, got %q / err %q", info.ChecksumSHA256, info.ChecksumFetchErr)
		}
		if got := atomic.LoadInt32(hits); got != 3 {
			t.Errorf("want 3 attempts, got %d", got)
		}
	})

	t.Run("429 可重试", func(t *testing.T) {
		h, hits := flaky(1, respondStatus(http.StatusTooManyRequests), "abc123")
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{testBinary + ".sha256": h}))
		if info.ChecksumSHA256 != "abc123" || atomic.LoadInt32(hits) != 2 {
			t.Errorf("429 should be retried once: content %q hits %d", info.ChecksumSHA256, atomic.LoadInt32(hits))
		}
	})

	t.Run("连接被重置（传输错误）可重试", func(t *testing.T) {
		reset := func(w http.ResponseWriter, _ *http.Request) {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		}
		h, hits := flaky(1, reset, "abc123")
		src := companionRelease(t, map[string]http.HandlerFunc{testBinary + ".sha256": h})
		// 关 keep-alive：复用连接被服务端关掉时 http.Transport 会对幂等 GET 自行
		// 透明重试一次，那样验到的是 Transport 而不是本层的重试
		src.client = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
		info := fetchInfo(t, src)
		if info.ChecksumSHA256 != "abc123" || atomic.LoadInt32(hits) != 2 {
			t.Errorf("transport error should be retried: content %q hits %d err %q",
				info.ChecksumSHA256, atomic.LoadInt32(hits), info.ChecksumFetchErr)
		}
	})

	t.Run("持续 5xx：至多 3 次后带尝试次数失败", func(t *testing.T) {
		var hits int32
		info := fetchInfo(t, companionRelease(t, map[string]http.HandlerFunc{
			testBinary + ".sig": counted(&hits, respondStatus(http.StatusBadGateway)),
		}))
		if !strings.Contains(info.SigFetchErr, "status 502") || !strings.Contains(info.SigFetchErr, "after 3 attempts") {
			t.Errorf("SigFetchErr = %q", info.SigFetchErr)
		}
		if got := atomic.LoadInt32(&hits); got != 3 {
			t.Errorf("want 3 attempts, got %d", got)
		}
	})
}

// 坏链路有界（P-20261109-9：旧口径 client 30s × 两文件串行 = check 最坏 60s）：
// 单资产一份预算、两资产并发——两个都挂死时总耗时 ≈ 一份预算而非两份
func TestFetchCompanionBudgetBoundsCheck(t *testing.T) {
	const budget = 400 * time.Millisecond
	shrinkCompanionTiming(t, budget)
	src := companionRelease(t, map[string]http.HandlerFunc{
		testBinary + ".sha256": hang,
		testBinary + ".sig":    hang,
	})
	start := time.Now()
	info := fetchInfo(t, src)
	elapsed := time.Since(start)

	for name, e := range map[string]string{"checksum": info.ChecksumFetchErr, "signature": info.SigFetchErr} {
		if !strings.Contains(e, "budget exhausted") {
			t.Errorf("%s fetch err = %q, want budget exhausted note", name, e)
		}
	}
	// 串行至少 2×budget；并发应明显低于它（留足调度余量防抖）
	if elapsed >= 2*budget-50*time.Millisecond {
		t.Errorf("companions should be fetched concurrently: took %s for budget %s", elapsed, budget)
	}
}

// 外层取消（客户端断开）：立即收手，不注「预算耗尽」（那是另一种诊断）
func TestFetchCompanionOuterCancel(t *testing.T) {
	shrinkCompanionTiming(t, 5*time.Second)
	src := companionRelease(t, map[string]http.HandlerFunc{testBinary + ".sha256": hang})
	ctx, cancel := context.WithCancel(context.Background())
	var once sync.Once
	go func() {
		time.Sleep(150 * time.Millisecond)
		once.Do(cancel)
	}()
	t.Cleanup(func() { once.Do(cancel) })
	start := time.Now()
	info, err := src.FetchLatest(ctx, "linux", "amd64")
	if err != nil {
		t.Fatalf("release endpoint answered before cancel, FetchLatest err = %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("outer cancel should stop the fetch promptly")
	}
	if info.ChecksumFetchErr == "" || strings.Contains(info.ChecksumFetchErr, "budget exhausted") {
		t.Errorf("ChecksumFetchErr = %q, want cancellation without budget note", info.ChecksumFetchErr)
	}
}

// 预签名 CDN 地址的查询串（签名参数数百字符）不进诊断文案
func TestRedactURLError(t *testing.T) {
	inner := errors.New("connection reset by peer")
	err := redactURLError(&url.Error{Op: "Get", URL: "https://cdn.example.com/a/b?X-Amz-Signature=secret&X-Amz-Credential=x", Err: inner})
	if strings.Contains(err.Error(), "X-Amz") || !strings.Contains(err.Error(), "https://cdn.example.com/a/b") {
		t.Errorf("redacted = %q", err.Error())
	}
	if !errors.Is(err, inner) {
		t.Error("redaction must keep the underlying error chain")
	}
	plain := errors.New("plain")
	if redactURLError(plain) != plain {
		t.Error("non-url errors pass through untouched")
	}
}
