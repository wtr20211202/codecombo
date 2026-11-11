package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testManager 干净的测试管理器（不触全局单例）
func testManager(t *testing.T) *Manager {
	t.Helper()
	return &Manager{
		status:     StatusIdle,
		dataDir:    t.TempDir(),
		binaryPath: filepath.Join(t.TempDir(), "simple-coding.exe"),
	}
}

// fakeSource 返回固定 ReleaseInfo 的假源
type fakeSource struct{ info *ReleaseInfo }

func (f *fakeSource) FetchLatest(_ context.Context, _, _ string) (*ReleaseInfo, error) {
	return f.info, nil
}

// R1 守护：更新失败（校验不过）后必须可重试——历史实现 ApplyUpdate 只接受
// Idle/Checking，失败终态后重试永远 409
func TestApplyUpdateRetryAfterFailure(t *testing.T) {
	m := testManager(t)

	// 无签名/校验和的 release：verifyUpdate 拒绝 → StatusFailed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not a real binary"))
	}))
	t.Cleanup(srv.Close)

	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:     "9.9.9",
		DownloadURL: srv.URL,
	}})
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil); err == nil {
		t.Fatal("expected apply to fail (unverifiable release)")
	}
	if st := m.GetStatus(); st.Status != StatusFailed {
		t.Fatalf("expected failed status, got %s", st.Status)
	}

	// 直接重试：不再被 Failed 终态卡死（应再次进入下载并同样失败，而非 409）
	err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil)
	if err == nil {
		t.Fatal("expected retry to fail on same unverifiable release")
	}
	if st := m.GetStatus(); st.Status != StatusFailed {
		t.Fatalf("retry should end failed again, got %s", st.Status)
	}
}

// S1（P-20261110-1）守护：下载失败保留 .part 与旁元数据（断点续传的本体），
// 最终名处绝不出现半截文件（原子 rename 语义）。历史行为「失败即整目录
// RemoveAll 从零重来」随续传语义退役；R1 的「失败终态可重试」不受影响——
// 下方第二段流水线即从失败态直接重试并完成续传。S2 收编后同一受理内已有续传
// 重试：源端持续断连（每个请求都只写半个 body）才会耗尽重试落 failed，期间
// 第 2、3 次尝试各带 Range 续上一截
func TestApplyUpdateDownloadFailureKeepsPartForResume(t *testing.T) {
	m := testManager(t)
	payload := bytes.Repeat([]byte{0x5A}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`, cutAll: true}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)
	retryEnv(t)

	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:     "9.9.9",
		DownloadURL: srv.URL,
	}})
	_, _ = m.CheckUpdate(context.Background(), "0.0.1")
	if err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil); err == nil {
		t.Fatal("expected apply to fail (connection cut mid-body on every attempt)")
	}
	if st := m.GetStatus(); st.Status != StatusFailed || !strings.HasPrefix(st.ErrMsg, "download failed") ||
		!strings.Contains(st.ErrMsg, "after 3 attempts") {
		t.Fatalf("status = %s/%q, want failed at download stage after exhausted retries", st.Status, st.ErrMsg)
	}
	if n := src.requestCount(); n != downloadRetryAttempts {
		t.Fatalf("one admission should spend %d attempts, got %d requests", downloadRetryAttempts, n)
	}
	for i := 1; i < downloadRetryAttempts; i++ {
		if r := src.requestAt(i); r.rangeHdr == "" {
			t.Fatalf("retry attempt %d must resume with a Range request, got %+v", i+1, r)
		}
	}

	newBinary := filepath.Join(m.dataDir, "tmp", "update-9.9.9", filepath.Base(m.binaryPath))
	if _, err := os.Stat(newBinary); !os.IsNotExist(err) {
		t.Fatal("final path must never hold a partial file (atomic rename semantics)")
	}
	part, err := os.Stat(newBinary + partSuffix)
	if err != nil || part.Size() == 0 {
		t.Fatalf(".part must survive the failed session for resume, got %v", err)
	}
	if pm := loadPartMeta(newBinary + partMetaSuffix); pm == nil || pm.URL != srv.URL || pm.Total != int64(len(payload)) {
		t.Fatalf("side metadata must survive with identity, got %+v", pm)
	}

	// 重试（failed 终态仍可受理）：Range 续传补齐尾段，校验桩拿到完整产物
	//（校验失败避免真实拉起换包子进程——护栏：测试不执行真实换包）
	src.mu.Lock()
	src.cutAll = false
	src.mu.Unlock()
	var resumed []byte
	orig := verifyUpdateFn
	verifyUpdateFn = func(path string, _ *ReleaseInfo) error {
		resumed, err = os.ReadFile(path)
		if err != nil {
			t.Fatalf("read verified binary: %v", err)
		}
		return errors.New("stop before replace")
	}
	t.Cleanup(func() { verifyUpdateFn = orig })
	_ = m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil)

	if len(resumed) != len(payload) || !bytes.Equal(resumed, payload) {
		t.Fatalf("retry must resume into the full payload, got %d bytes", len(resumed))
	}
	if n := src.requestCount(); n < 2 || src.requestAt(n-1).rangeHdr == "" {
		t.Fatalf("retry session must send a Range request, requests=%d last=%+v", n, src.requestAt(n-1))
	}
}

// R1 守护：下载停滞检测——服务端只发响应头不发 body，60s 内应有进展失败而非挂死
// （这里用短停滞参数不可行——常量固定；退化为验证 ctx 取消路径快速返回）。两条
// 下载路径同守：自更新续传重试层（外层取消不重试：一拨号即收手——重试层只吸收
// 瞬时故障，不逆用户/停机指令）与中心分发缓存的单拨号路径
func TestDownloadContextCancel(t *testing.T) {
	paths := []struct {
		name string
		run  func(m *Manager, ctx context.Context, url, dest string) error
	}{
		{"self-update resumable retry", func(m *Manager, ctx context.Context, url, dest string) error {
			return m.downloadResumableWithRetry(ctx, url, dest, nil)
		}},
		{"central cache", func(m *Manager, ctx context.Context, url, dest string) error {
			return m.download(ctx, url, dest, nil, false)
		}},
	}
	for _, p := range paths {
		t.Run(p.name, func(t *testing.T) {
			m := testManager(t)
			block := make(chan struct{})
			var attempts atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				attempts.Add(1)
				w.Header().Set("Content-Length", "1000")
				_, _ = w.Write([]byte("partial"))
				w.(http.Flusher).Flush()
				<-block // 挂住连接：模拟死链
			}))
			t.Cleanup(func() { close(block); srv.Close() })
			retryEnv(t) // 放行回环源：取消路径须走过真实 HTTP 读（原版被 URL 校验提前挡下）

			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			t.Cleanup(cancel)
			dest := filepath.Join(t.TempDir(), "dl.bin")
			start := time.Now()
			err := p.run(m, ctx, srv.URL, dest)
			if err == nil {
				t.Fatal("expected cancellation error")
			}
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Fatalf("cancel should return promptly, took %s", elapsed)
			}
			if n := attempts.Load(); n != 1 {
				t.Fatalf("cancellation must not be retried, attempts = %d", n)
			}
			// 取消如实透出（不冒充「重试耗尽」：无尝试注记，判型仍是 context 错误）
			if !errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "attempt") {
				t.Fatalf("cancellation must surface as-is, not as an exhausted retry, got %v", err)
			}
		})
	}
}

// ─── 下载自动退避重试（P-20261110-1-S2，收编进 S1 续传路径）─────────────────

// retryEnv 压缩重试退避 + 放行 httptest 回环源：重试/超限各路径须在真实 HTTP
// 语义（状态码/传输错误/断连续传）下驱动，而生产链两道闸都把回环源挡在拨号
// 之前——validateDownloadURL 拒 http/内网、downloadClient 直连档拨号期复查拒绝
// 回环 IP。放行沿用 S1 的 useLocalTestSource（validateDownloadURL 唯一校验注入口
// + 直连裸 Transport），退避压到 1ms 免得用例空等 500ms/1s
func retryEnv(t *testing.T) {
	t.Helper()
	useLocalTestSource(t)
	oldBackoff := downloadRetryBackoff
	downloadRetryBackoff = func(int) time.Duration { return time.Millisecond }
	t.Cleanup(func() { downloadRetryBackoff = oldBackoff })
}

// 续传重试（S1×S2 收编验收硬点）：首个尝试中途断连 → 同一次下载内的第 2 次尝试
// 带 Range 从 .part 偏移续上（If-Range 带记录的强 ETag），产物 sha256 与源一致、
// .part/旁元数据随原子 rename 消费；进度单调不回零——重试拨号到达时状态机进度
// 仍停在首个尝试已传的字节（全量重试形态的「重试前进度归零」已删），回调序列
// 全程非降且终值 = 全量
func TestDownloadRetryResumesFromPartOffset(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i*31 + i/251) // 非均匀内容：续传偏移错位即 sha 失配
	}
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	var mu sync.Mutex
	progressAtRetry := int64(-1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if src.requestCount() == 1 { // 第 2 个请求 = 重试拨号：记下此刻状态机进度
			p := m.GetStatus().Progress
			mu.Lock()
			progressAtRetry = p
			mu.Unlock()
		}
		src.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo.exe")
	var seen []int64
	err := m.downloadResumableWithRetry(context.Background(), srv.URL, dest, func(n, _ int64) {
		mu.Lock()
		seen = append(seen, n)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("resume retry should recover within one download: %v", err)
	}
	if n := src.requestCount(); n != 2 {
		t.Fatalf("expected the cut attempt + one resume retry, got %d requests", n)
	}
	if r := src.requestAt(0).rangeHdr; r != "" {
		t.Fatalf("first attempt must be a plain GET, got Range %q", r)
	}
	retry := src.requestAt(1)
	if want := fmt.Sprintf("bytes=%d-", len(payload)/2); retry.rangeHdr != want || retry.ifRange != `"v1"` {
		t.Fatalf("retry = %+v, want Range %s + If-Range of the recorded etag", retry, want)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(got) != sha256.Sum256(payload) {
		t.Fatalf("resumed artifact sha256 mismatch (%d bytes)", len(got))
	}
	assertFinalState(t, dest, payload)

	mu.Lock()
	defer mu.Unlock()
	if progressAtRetry <= 0 {
		t.Fatalf("progress at the retry dial = %d, want the kept offset (no reset to zero)", progressAtRetry)
	}
	if len(seen) == 0 || seen[len(seen)-1] != int64(len(payload)) {
		t.Fatalf("progress callbacks must end at the full size, got %v", seen)
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] < seen[i-1] {
			t.Fatalf("progress must be monotonic across attempts, got %v", seen)
		}
	}
	if st := m.GetStatus(); st.Progress != int64(len(payload)) || st.Total != int64(len(payload)) {
		t.Fatalf("state machine progress = %d/%d, want %d/%d", st.Progress, st.Total, len(payload), len(payload))
	}
}

// ApplyUpdate 全链续传重试（接线守护：受理流水线走重试层而非裸续传会话）：一次
// 受理内首个尝试断连、重试从偏移续上——校验桩拿到的产物 sha256 与源一致（护栏：
// 桩读产物后即拒绝，测试不执行真实换包），失败只落在校验阶段而非下载阶段
func TestApplyUpdateResumeRetryWithinOneAdmission(t *testing.T) {
	m := testManager(t)
	payload := bytes.Repeat([]byte{0x3C, 0xA7}, 64)
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)
	retryEnv(t)

	var verified [sha256.Size]byte
	verifiedLen := -1
	orig := verifyUpdateFn
	verifyUpdateFn = func(path string, _ *ReleaseInfo) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		verified, verifiedLen = sha256.Sum256(data), len(data)
		return errors.New("stop before replace")
	}
	t.Cleanup(func() { verifyUpdateFn = orig })

	m.SetSource(&fakeSource{info: &ReleaseInfo{Version: "9.9.9", DownloadURL: srv.URL}})
	_, _ = m.CheckUpdate(context.Background(), "0.0.1")
	_ = m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil)

	if st := m.GetStatus(); st.Status != StatusFailed || !strings.HasPrefix(st.ErrMsg, "update verification failed") {
		t.Fatalf("status = %s/%q, want the download recovered and the stub stopping at verification", st.Status, st.ErrMsg)
	}
	if verifiedLen != len(payload) || verified != sha256.Sum256(payload) {
		t.Fatalf("verified artifact must be the resumed full payload (sha256 match), got %d bytes", verifiedLen)
	}
	n := src.requestCount()
	if n != 2 {
		t.Fatalf("one admission = cut attempt + Range resume retry, got %d requests", n)
	}
	if r := src.requestAt(1); r.rangeHdr == "" {
		t.Fatalf("retry within the admission must resume with Range, got %+v", r)
	}
}

// 续传重试 × 完整性闸：源端每次只回 20 字节的截短 206 区间——每次尝试都过不了闸
// （.part 保留增长后的字节），重试层逐次从截断处续上，同一次下载内补齐
func TestDownloadRetryCompletesTruncatedRanges(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	payload := bytes.Repeat([]byte{0x2E}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`, capRange: 20}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0x2E}, 40), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 100})

	if err := m.downloadResumableWithRetry(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("truncated ranges should be stitched across retries: %v", err)
	}
	if n := src.requestCount(); n != 3 {
		t.Fatalf("expected 3 resume attempts (40→60→80→100), got %d", n)
	}
	for i, want := range []string{"bytes=40-", "bytes=60-", "bytes=80-"} {
		if got := src.requestAt(i).rangeHdr; got != want {
			t.Fatalf("attempt %d Range = %q, want %q", i+1, got, want)
		}
	}
	assertFinalState(t, dest, payload)
}

// 瞬时故障（5xx）自动重试恢复：前两次 503、第三次成功——三拨号后拿到完整产物
// （从未拿到 200 即无半截可续，三次都是全量请求）
func TestDownloadRetriesTransientStatus(t *testing.T) {
	m := testManager(t)
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("binary-bytes"))
	}))
	t.Cleanup(srv.Close)
	retryEnv(t)

	dest := filepath.Join(t.TempDir(), "dl.bin")
	if err := m.downloadResumableWithRetry(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("download should recover after transient 503s: %v", err)
	}
	if n := attempts.Load(); n != 3 {
		t.Fatalf("expected 3 attempts, got %d", n)
	}
	data, err := os.ReadFile(dest)
	if err != nil || string(data) != "binary-bytes" {
		t.Fatalf("recovered attempt must leave the full payload: %q (%v)", data, err)
	}
}

// 确定性失败（403/404）不重试：一拨号即收手，原因注记如实区分「一次就确定失败」。
// 续传请求同样分流（已有半截时 Range 请求撞 404 走续传会话的非预期状态分支）——
// 半截现场照 S1 语义保留，留给下一次受理
func TestDownloadNoRetryOnDeterministicStatus(t *testing.T) {
	cases := []struct {
		name   string
		status int
		seed   bool // 预置半截现场：首个请求即 Range 续传请求
	}{
		{"403", http.StatusForbidden, false},
		{"404", http.StatusNotFound, false},
		{"404 on resume", http.StatusNotFound, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := testManager(t)
			var attempts atomic.Int32
			var mu sync.Mutex
			var lastRange string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				mu.Lock()
				lastRange = r.Header.Get("Range")
				mu.Unlock()
				w.WriteHeader(c.status)
			}))
			t.Cleanup(srv.Close)
			retryEnv(t)

			dest := filepath.Join(t.TempDir(), "dl.bin")
			if c.seed {
				seedPart(t, dest, []byte("half"), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 8})
			}
			err := m.downloadResumableWithRetry(context.Background(), srv.URL, dest, nil)
			want := fmt.Sprintf("download returned %d", c.status)
			if err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "after 1 attempt") {
				t.Fatalf("deterministic failure must surface once with its note, got %v", err)
			}
			if n := attempts.Load(); n != 1 {
				t.Fatalf("%d must not be retried, attempts = %d", c.status, n)
			}
			if c.seed {
				mu.Lock()
				r := lastRange
				mu.Unlock()
				if r != "bytes=4-" {
					t.Fatalf("seeded part must be resumed with Range, got %q", r)
				}
				if part, err := os.Stat(dest + partSuffix); err != nil || part.Size() != 4 {
					t.Fatalf(".part must be kept for the next admission, got %v", err)
				}
			}
		})
	}
}

// 传输层错误（连接拒绝）按瞬时故障重试，超限透真实原因（附尝试注记）；原因剥
// 预签名查询串（host+path 保留可定位，签名参数不进 errMsg/日志）
func TestDownloadRetriesTransportErrors(t *testing.T) {
	m := testManager(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL + "/asset.bin?X-Amz-Signature=sekrit"
	srv.Close() // 立即下线：后续拨号全部连接拒绝
	retryEnv(t)

	dest := filepath.Join(t.TempDir(), "dl.bin")
	err := m.downloadResumableWithRetry(context.Background(), deadURL, dest, nil)
	if err == nil || !strings.Contains(err.Error(), "after 3 attempts") {
		t.Fatalf("transport errors should retry to exhaustion with the note, got %v", err)
	}
	if msg := err.Error(); strings.Contains(msg, "sekrit") || !strings.Contains(msg, "/asset.bin") {
		t.Fatalf("transport error must keep host+path but drop the presigned query, got %q", msg)
	}
}

// 超时类传输错误必须可重试：Go 的拨号超时（"i/o timeout"）与响应头超时都满足
// errors.Is(err, context.DeadlineExceeded)——按 context 错误排除重试会把 CDN
// 连接超时这类最常见的瞬时故障误判成确定性失败。外层放弃由重试层先行
// ctx.Err() 判定，判定函数本身不看 context 错误
func TestRetryableDownloadErrClassification(t *testing.T) {
	// 截止时刻已过的拨号：不发包即得真实的 "i/o timeout" 错误（三平台确定性）
	_, dialErr := (&net.Dialer{Deadline: time.Now().Add(-time.Second)}).DialContext(context.Background(), "tcp", "127.0.0.1:1")
	if dialErr == nil || !errors.Is(dialErr, context.DeadlineExceeded) {
		t.Fatalf("precondition: expected a dial timeout matching DeadlineExceeded, got %v", dialErr)
	}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"dial timeout", &url.Error{Op: "Get", URL: "https://example.com/a", Err: dialErr}, true},
		{"503", &downloadStatusError{status: http.StatusServiceUnavailable}, true},
		{"429", &downloadStatusError{status: http.StatusTooManyRequests}, true},
		{"403", &downloadStatusError{status: http.StatusForbidden}, false},
		{"404", &downloadStatusError{status: http.StatusNotFound}, false},
		{"stall", fmt.Errorf("download stalled: no data for %s", downloadStallTimeout), true},
		// S1 完整性闸未过（源端截短 206 区间）：.part 已保留，下一尝试从截断处续上
		{"incomplete", fmt.Errorf("download incomplete: got %d of %d bytes", 60, 100), true},
	}
	for _, c := range cases {
		if got := retryableDownloadErr(c.err); got != c.want {
			t.Errorf("%s: retryable = %v, want %v (err %v)", c.name, got, c.want, c.err)
		}
	}
}

// 端到端：首拨响应头超时（真实 http.Transport 超时形态）后自动重试恢复
func TestDownloadRetriesResponseHeaderTimeout(t *testing.T) {
	m := testManager(t)
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			// 首拨迟迟不回响应头：客户端超时断开即随请求 ctx 退出，不拖住 srv.Close
			select {
			case <-time.After(5 * time.Second):
			case <-r.Context().Done():
			}
			return
		}
		_, _ = w.Write([]byte("binary-bytes"))
	}))
	t.Cleanup(srv.Close)
	retryEnv(t)
	downloadClient = &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 100 * time.Millisecond}}

	dest := filepath.Join(t.TempDir(), "dl.bin")
	if err := m.downloadResumableWithRetry(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("response header timeout must be retried and recover: %v", err)
	}
	if n := attempts.Load(); n != 2 {
		t.Fatalf("expected 2 attempts (timeout then success), got %d", n)
	}
	if data, err := os.ReadFile(dest); err != nil || string(data) != "binary-bytes" {
		t.Fatalf("recovered attempt must leave the full payload: %q (%v)", data, err)
	}
}

// 作用域收窄回归（S1 定案）：中心分发缓存路径（DownloadToFile → download）不经
// 续传重试层——瞬时 503 也是单拨号即败、原文无尝试注记（失败即弃，缓存由下一次
// 分发请求重拉）
func TestDownloadToFileDoesNotRetry(t *testing.T) {
	m := testManager(t)
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	retryEnv(t)

	err := m.DownloadToFile(context.Background(), srv.URL, filepath.Join(t.TempDir(), "serve.bin"))
	if err == nil || err.Error() != "download returned 503" {
		t.Fatalf("central cache path must fail once with the bare status, got %v", err)
	}
	if n := attempts.Load(); n != 1 {
		t.Fatalf("central cache path must not retry, attempts = %d", n)
	}
}

// 地址校验拒绝是确定性结果：重试层先行校验即收手——不拨号、不退避空转、不附
// 尝试注记（校验口唯一：S1 的 validateDownloadURL，续传会话内的复核不再被走到）
func TestDownloadRetrySkipsURLValidationFailure(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	var calls atomic.Int32
	validateDownloadURL = func(string) error {
		calls.Add(1)
		return errors.New("update url must use https")
	}

	err := m.downloadResumableWithRetry(context.Background(), "http://example.com/x", filepath.Join(t.TempDir(), "dl.bin"), nil)
	if err == nil || err.Error() != "update url must use https" {
		t.Fatalf("validation rejection must surface verbatim without an attempts note, got %v", err)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("validation must run once and never be retried, calls = %d", n)
	}
}

// 验收「超限转失败态透真实原因」：ApplyUpdate 全链——反复 5xx 耗尽重试后落
// failed 终态，errMsg 带真实原因与尝试注记；失败现场照 S1 语义保留（不再整目录
// RemoveAll）——从未拿到 200 即无半截可续、最终名处绝不出现半截文件；终态仍可重试
func TestApplyUpdateDownloadRetryExhaustedLandsFailed(t *testing.T) {
	m := testManager(t)
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	retryEnv(t)

	m.SetSource(&fakeSource{info: &ReleaseInfo{Version: "9.9.9", DownloadURL: srv.URL}})
	_, _ = m.CheckUpdate(context.Background(), "0.0.1")
	if err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil); err == nil {
		t.Fatal("expected apply to fail (always 502)")
	}
	if n := attempts.Load(); n != 3 {
		t.Fatalf("download should exhaust %d attempts, got %d", downloadRetryAttempts, n)
	}
	st := m.GetStatus()
	if st.Status != StatusFailed {
		t.Fatalf("expected failed status, got %s", st.Status)
	}
	if !strings.Contains(st.ErrMsg, "download failed: download returned 502") ||
		!strings.Contains(st.ErrMsg, "after 3 attempts") {
		t.Fatalf("failure state must carry the real reason + attempts note, got %q", st.ErrMsg)
	}
	newBinary := filepath.Join(m.dataDir, "tmp", "update-9.9.9", filepath.Base(m.binaryPath))
	if _, err := os.Stat(newBinary); !os.IsNotExist(err) {
		t.Fatal("final path must never hold a partial file")
	}
	if _, err := os.Stat(newBinary + partSuffix); !os.IsNotExist(err) {
		t.Fatal("no 200 ever arrived — there is nothing to resume, no .part may be fabricated")
	}
	// 失败终态可重试：再次受理不再 409（重走同链再次失败）
	if err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil); err == nil ||
		strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("failed state must stay retryable, got %v", err)
	}
}

// S7（P-20261110-1）验收硬点「升级链续传成功」全链集成：StartUpdate 受理（HTTP
// 入口的受理形态）→ 首个下载尝试中途断连 → 重试层自动 Range 续传 → 下载完成
// 原子 rename → **真实校验链**（不注桩：verifyUpdate 原生 sha256 比对——续传拼
// 接错一字节即在此拒绝，是恢复正确性的独立证据；既有受理全链用例全部在校验桩
// 处截停，真校验无人走过）→ 换包子进程拉起（取值口测试桩，绝不真实 spawn）→
// 流水线走完到 restarting。三面断言：
//   - 产物面：最终名 = 完整产物、.part/旁元数据已随原子 rename 消费；
//   - 状态机面：重试拨号时刻进度仍停在首尝试的采样现场（不回零）、resumedBytes =
//     续传起点经受理链透出到快照（S4）、终态 restarting 且 progress/total 收满；
//   - 受理面：受理同步返回 nil、开始通知单一发射（本链成功不落失败通知）、
//     下发换包子进程的参数原样（旧二进制路径/新产物路径/数据目录/版本）。
//
// 「中断恢复」的另一半（断连耗尽落 failed → 失败态再受理、跨受理续传补齐）由
// 下方 TestApplyUpdateInterruptedThenReadmittedResumesToRestarting 以同款受理
// 全链背书（同步入口 + 校验桩形态另见 TestApplyUpdateDownloadFailureKeepsPartForResume）。
// 选型注记：本链只能落在 Manager 层集成、不真实换包——生产链把更新源指到本地
// mock 在三道闸（settings https-only / 源与下载 URL 的公网 https 校验 + 拨号期
// IP 守卫）前不可行，真实换包另被护栏禁止——子进程拉起即安全的终止边界
func TestApplyUpdateResumeChainAdmittedToRestarting(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i*31 + i/251) // 非均匀内容：续传偏移错位即真 sha256 失配
	}
	half := int64(len(payload) / 2)
	sum := sha256.Sum256(payload)
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	var mu sync.Mutex
	progressAtRetry := int64(-1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if src.requestCount() == 1 { // 第 2 个请求 = 重试拨号：状态机此刻仍是首尝试现场
			p := m.GetStatus().Progress
			mu.Lock()
			progressAtRetry = p
			mu.Unlock()
		}
		src.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	// 换包子进程拉起桩：截停在实际换包的最后一道边界（重启申请之前），核对下发参数
	var launched struct {
		current, new, dd, version, prev string
		port, pid                       int
	}
	origLaunch := launchUpdateSubprocessFn
	launchUpdateSubprocessFn = func(currentBinary, newBinary string, port, pid int, dataDir, version, prevVersion string) error {
		mu.Lock()
		launched = struct {
			current, new, dd, version, prev string
			port, pid                       int
		}{currentBinary, newBinary, dataDir, version, prevVersion, port, pid}
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { launchUpdateSubprocessFn = origLaunch })

	notes := captureNotifications(t)
	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:        "9.9.9",
		DownloadURL:    srv.URL,
		FileSize:       int64(len(payload)),
		ChecksumSHA256: hex.EncodeToString(sum[:]),
	}})
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatalf("check: %v", err)
	}

	// 受理（异步链）：同步返回 nil = 已受理，断连/续传/校验/替换在后台跑完
	if err := m.StartUpdate(m.cachedInfo, "0.0.1", 0); err != nil {
		t.Fatalf("admission must succeed, got %v", err)
	}
	waitFor(t, "pipeline reaching restarting", func() bool { return m.GetStatus().Status == StatusRestarting })

	// 产物面：续传产物经真校验后原子 rename 至最终名，旁产物已消费
	newBinary := filepath.Join(m.dataDir, "tmp", "update-9.9.9", filepath.Base(m.binaryPath))
	assertFinalState(t, newBinary, payload)

	// 状态机面：重试拨号时进度停在首尝试现场（不回零）；终态 resumedBytes =
	// 续传起点（S4 经受理链透出）、progress/total 收满、无 errMsg。重试拨号时刻
	// 的进度取值刻意不断言精确相等：pumpResponseBody 的进度采样按 200ms 窗节流、
	// 失败路径无终值回写——该值是首尝试的末次采样（首读必采样，故恒 ∈ (0, half]）。
	// 可断言的是语义面：未归零、不越过首尝试实际到手的字节
	mu.Lock()
	atRetry := progressAtRetry
	got := launched
	mu.Unlock()
	if atRetry <= 0 || atRetry > half {
		t.Fatalf("state-machine progress at the retry dial = %d, want a kept first-attempt sample in (0, %d] (no reset to zero)", atRetry, half)
	}
	if st := m.GetStatus(); st.Status != StatusRestarting || st.Progress != int64(len(payload)) ||
		st.Total != int64(len(payload)) || st.ResumedBytes != half || st.ErrMsg != "" {
		t.Fatalf("final status = %+v, want restarting %d/%d resumed=%d errMsg empty",
			st, len(payload), len(payload), half)
	}

	// 受理面：换包子进程参数原样（旧二进制路径原位替换、版本与数据目录如实下发）
	if got.current != m.binaryPath || got.new != newBinary || got.dd != m.dataDir ||
		got.version != "9.9.9" || got.prev != "0.0.1" || got.pid != os.Getpid() {
		t.Fatalf("subprocess args = %+v, want current=%s new=%s dd=%s v=9.9.9 prev=0.0.1 pid=%d",
			got, m.binaryPath, newBinary, m.dataDir, os.Getpid())
	}
	got1 := notes()
	if len(got1) != 1 || got1[0].Type != "info" || got1[0].TitleKey != notifyStartedTitleKey ||
		got1[0].MsgParams["version"] != "9.9.9" {
		t.Fatalf("a successful in-process chain must emit exactly one started notification, got %+v", got1)
	}
}

// S7（P-20261110-1）停滞看门狗 × 续传重试（S2 提案点名「停滞看门狗 60s 保留；
// 自动退避重试 3 次每次续传」的合体形态——判定时长是 60s 常量，此前无人可测，
// 既有用例全走断连（ErrAbortHandler 强拆）而看门狗只对「半截 body 后挂死不发
// 不关」的真死链触发，两条失败面不同代码路径）：源端发出响应头与半截 body 后
// 挂死，看门狗（测试压缩到 300ms，生产取值口恒读 60s 常量）到点 cancel 解开
// 阻塞读 → 当次尝试以 stalled 失败收场、.part 保留；重试层另拨号带 Range 从
// 已有字节续上，产物与源一致。stalled 按瞬时故障可重试的判定由
// TestRetryableDownloadErrClassification 单独背书
func TestDownloadStallWatchdogResumesFromPart(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	// 300ms：远高于回环续传尾段的读间隔（负载下不误杀第 2 次尝试），又远低于下方
	// 外层兜底时限
	const stall = 300 * time.Millisecond
	stallTimeout.Store(stall)
	t.Cleanup(func() { stallTimeout.Store(downloadStallTimeout) })

	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i*31 + i/251) // 非均匀内容：续传偏移错位即 sha256 失配
	}
	half := int64(len(payload) / 2)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	var dials atomic.Int32
	var mu sync.Mutex
	progressAtResume := int64(-1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if dials.Add(1) == 1 { // 首拨：半截 body 后挂死（不发不关，真死链形态）
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			w.Header().Set("ETag", `"v1"`)
			w.Header().Set("Accept-Ranges", "bytes")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload[:half])
			w.(http.Flusher).Flush()
			<-r.Context().Done() // 看门狗 cancel 断开连接即随请求 ctx 退出，不拖住 srv.Close
			return
		}
		// 重试拨号：状态机此刻必须仍停在首尝试现场（不回零）
		p := m.GetStatus().Progress
		mu.Lock()
		progressAtResume = p
		mu.Unlock()
		src.ServeHTTP(w, r) // Range 续传请求由可配置源补齐尾段
	}))
	t.Cleanup(srv.Close)

	// 外层时限只作回归兜底：看门狗失效时挂死的读由它解开，用例以 context 错误
	// 快速失败，而不是吊到 go test 的全局超时
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	dest := filepath.Join(t.TempDir(), "codecombo.exe")
	start := time.Now()
	if err := m.downloadResumableWithRetry(ctx, srv.URL, dest, nil); err != nil {
		t.Fatalf("the stalled attempt must be killed by the watchdog and retried into a resumed completion: %v", err)
	}
	// 因果自证：首拨挂死在请求 ctx 上，只有看门狗到点 cancel 才能终结它——整次
	// 下载不可能早于判定时长完成（早了说明首尝试并非死于看门狗，用例失去意义）
	if elapsed := time.Since(start); elapsed < stall {
		t.Fatalf("download finished in %s, before the %s stall timeout — the first attempt did not die by the watchdog", elapsed, stall)
	}
	if n := dials.Load(); n != 2 {
		t.Fatalf("watchdog death + one resume retry = 2 dials, got %d", n)
	}
	if r := src.requestAt(0); r.rangeHdr != fmt.Sprintf("bytes=%d-", half) || r.ifRange != `"v1"` {
		t.Fatalf("resume request = %+v, want Range bytes=%d- + If-Range of the recorded etag", r, half)
	}
	assertFinalState(t, dest, payload)
	if st := m.GetStatus(); st.Progress != int64(len(payload)) || st.Total != int64(len(payload)) ||
		st.ResumedBytes != half {
		t.Fatalf("final status = %d/%d resumed=%d, want %d/%d resumed=%d",
			st.Progress, st.Total, st.ResumedBytes, len(payload), len(payload), half)
	}
	// 重试拨号时刻的进度取值同「续传成功」用例口径：采样按 200ms 窗节流、失败路径
	// 无终值回写，可断言的是语义面——未归零、不越过首尝试实际到手的字节
	mu.Lock()
	defer mu.Unlock()
	if progressAtResume <= 0 || progressAtResume > half {
		t.Fatalf("progress at the resume dial = %d, want a kept first-attempt sample in (0, %d] (no reset to zero)", progressAtResume, half)
	}
}

// S7（P-20261110-1）验收硬点「升级链中断恢复」全链集成（与「续传成功」成对——
// 那条背书 S2 重试层的同受理自动恢复，本条背书「耗尽落 failed 后下一次受理接着
// 续」：前端失败态「重试更新」按钮、CLI 重试、重启后再受理都汇到这同一条受理
// 入口）：StartUpdate 受理 → 源端持续断连（cutAll）耗尽 3 次重试（第 2/3 次已
// 带 Range 逐次续上）→ failed 透因带尝试注记、.part 半截现场保留 → 失败态直接
// 再受理（StartUpdate 同一入口）→ 跨受理 Range 续传从上次 .part 偏移起步（
// resumedBytes 经状态机透出）→ **真实校验链**（不注桩：verifyUpdate 原生 sha256
// 比对——跨受理拼接错一字节即拒）→ 换包子进程拉起桩截停（绝不真实 spawn）→
// restarting。四面断言：
//   - 失败面：终态 failed + errMsg「download failed … (after 3 attempts)」、
//     最终名无半截、.part+旁元数据保留、通知序 = 开始 → 失败（原因原文）；
//   - 恢复面：再受理同步返回 nil、续传请求 Range = 上次 .part 现有大小（受理
//     归零只清状态机不清现场）、终态 resumedBytes = 该偏移（S4 透出）、restarting
//     且 progress/total 收满无错；
//   - 产物面：跨受理拼接产物 = 完整 payload、.part/元数据随原子 rename 消费；
//   - 受理面：换包子进程参数原样、通知序补上第二次开始且无重复失败
func TestApplyUpdateInterruptedThenReadmittedResumesToRestarting(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i*31 + i/251) // 非均匀内容：续传偏移错位即真 sha256 失配
	}
	sum := sha256.Sum256(payload)
	// cutAll 断点取每段 body 的一半：3 次尝试后 .part = half + half/2 + half/4
	// （每次续上的尾段再被拦腰截断），跨受理续传从 7/8 处补齐最后 1/8
	half := int64(len(payload) / 2)
	keptPart := half + half/2 + half/4
	src := &rangeSource{payload: payload, etag: `"v1"`, cutAll: true}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	notes := captureNotifications(t)
	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:        "9.9.9",
		DownloadURL:    srv.URL,
		FileSize:       int64(len(payload)),
		ChecksumSHA256: hex.EncodeToString(sum[:]),
	}})
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatalf("check: %v", err)
	}

	// 第一幕：受理 → 持续断连耗尽重试 → failed 透因，半截现场保留待下次受理
	if err := m.StartUpdate(m.cachedInfo, "0.0.1", 0); err != nil {
		t.Fatalf("first admission must succeed, got %v", err)
	}
	waitFor(t, "failed after exhausted retries", func() bool { return m.GetStatus().Status == StatusFailed })
	if st := m.GetStatus(); !strings.HasPrefix(st.ErrMsg, "download failed") ||
		!strings.Contains(st.ErrMsg, "after 3 attempts") {
		t.Fatalf("errMsg = %q, want download failure with the attempts note", st.ErrMsg)
	}
	if n := src.requestCount(); n != downloadRetryAttempts {
		t.Fatalf("persistent cut must spend %d attempts, got %d requests", downloadRetryAttempts, n)
	}
	for i := 1; i < downloadRetryAttempts; i++ { // 第 2/3 次已带 Range 逐次续上
		if r := src.requestAt(i).rangeHdr; r == "" {
			t.Fatalf("in-admission retry %d must resume with Range, got %+v", i+1, src.requestAt(i))
		}
	}
	newBinary := filepath.Join(m.dataDir, "tmp", "update-9.9.9", filepath.Base(m.binaryPath))
	if _, err := os.Stat(newBinary); !os.IsNotExist(err) {
		t.Fatal("final path must never hold a partial file (atomic rename semantics)")
	}
	part, err := os.Stat(newBinary + partSuffix)
	if err != nil {
		t.Fatalf(".part must survive the failed admission for resume: %v", err)
	}
	if part.Size() != keptPart {
		t.Fatalf(".part = %d bytes, want the stitched progress %d kept across the failed admission", part.Size(), keptPart)
	}
	if pm := loadPartMeta(newBinary + partMetaSuffix); pm == nil || pm.URL != srv.URL ||
		pm.ETag != `"v1"` || pm.Total != int64(len(payload)) {
		t.Fatalf("side metadata must survive with identity, got %+v", pm)
	}
	waitFor(t, "started+failed notifications", func() bool { return len(notes()) == 2 })
	if got := notes(); got[0].Type != "info" || got[0].TitleKey != notifyStartedTitleKey ||
		got[1].Type != "error" || got[1].TitleKey != notifyFailedTitleKey ||
		!strings.Contains(got[1].Body, "after 3 attempts") {
		t.Fatalf("interrupted admission must notify started→failed(with reason), got %+v", got)
	}

	// 第二幕：源端恢复 → 失败态直接再受理（重试按钮/CLI 同一入口）→ 跨受理续传
	// → 真校验 → 换包桩截停 → restarting
	src.mu.Lock()
	src.cutAll = false
	src.mu.Unlock()
	// 换包子进程拉起桩（后台流水线 goroutine 写、测试 goroutine 读，互斥保护）
	var mu sync.Mutex
	var launched struct {
		current, new, dd, version, prev string
		port, pid                       int
	}
	origLaunch := launchUpdateSubprocessFn
	launchUpdateSubprocessFn = func(currentBinary, newBinary string, port, pid int, dataDir, version, prevVersion string) error {
		mu.Lock()
		launched = struct {
			current, new, dd, version, prev string
			port, pid                       int
		}{currentBinary, newBinary, dataDir, version, prevVersion, port, pid}
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { launchUpdateSubprocessFn = origLaunch })

	if err := m.StartUpdate(m.cachedInfo, "0.0.1", 0); err != nil {
		t.Fatalf("re-admission from the failed state must be admitted, got %v", err)
	}
	waitFor(t, "pipeline reaching restarting", func() bool { return m.GetStatus().Status == StatusRestarting })
	mu.Lock()
	got := launched
	mu.Unlock()

	// 产物面：跨受理拼接产物经真校验后原子 rename，旁产物已消费
	assertFinalState(t, newBinary, payload)
	// 恢复面：续传请求从上次 .part 现有大小起（受理不归零半截现场）；终态
	// resumedBytes = 该偏移（S4 经受理链透出）、收满无错
	if r := src.requestAt(downloadRetryAttempts); r.rangeHdr != fmt.Sprintf("bytes=%d-", keptPart) ||
		r.ifRange != `"v1"` {
		t.Fatalf("re-admission resume = %+v, want Range bytes=%d- + If-Range of the recorded etag",
			r, keptPart)
	}
	if st := m.GetStatus(); st.Status != StatusRestarting || st.Progress != int64(len(payload)) ||
		st.Total != int64(len(payload)) || st.ResumedBytes != keptPart || st.ErrMsg != "" {
		t.Fatalf("final status = %+v, want restarting %d/%d resumed=%d errMsg empty",
			st, len(payload), len(payload), keptPart)
	}
	// 受理面：换包子进程参数原样（旧二进制路径原位替换、版本与数据目录如实下发）
	if got.current != m.binaryPath || got.new != newBinary || got.dd != m.dataDir ||
		got.version != "9.9.9" || got.prev != "0.0.1" || got.pid != os.Getpid() {
		t.Fatalf("subprocess args = %+v, want current=%s new=%s dd=%s v=9.9.9 prev=0.0.1 pid=%d",
			got, m.binaryPath, newBinary, m.dataDir, os.Getpid())
	}
	// 通知面：成功恢复链补第二次开始，且不再落失败（本进程内整链成功）
	all := notes()
	if len(all) != 3 || all[2].Type != "info" || all[2].TitleKey != notifyStartedTitleKey ||
		all[2].MsgParams["version"] != "9.9.9" {
		t.Fatalf("notification sequence must be started/failed/started, got %+v", all)
	}
}

// S7（P-20261110-1）续传 × 校验链 fail-closed（防拼接的最后一道闸）：上方两条
// 受理全链只证明了真实校验链的放行面；S1 的身份核对（ETag/总长）挡得住「发布方
// 重传资产」，挡不住身份信号照旧而内容不同的源（行为失常的镜像/CDN、被篡改的
// 分发面）——partresume.go 头注把这类「半截 A + 半截 B」的兜底交给校验链。本
// 用例钉住这道兜底在受理全链上真的成立：续传尾段换了内容而 ETag 与总长不变 →
// 下载按字节数「完成」并原子 rename → **真实校验链** sha256 失配拒绝 → 下载产物
// 整目录清除、换包子进程绝不拉起、failed 透因、通知序 开始→失败。续传能力不得
// 削弱供应链防线
func TestApplyUpdateResumedSpliceRefusedByRealVerify(t *testing.T) {
	m := testManager(t)
	retryEnv(t)
	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i*31 + i/251)
	}
	sum := sha256.Sum256(payload)
	// 同长异尾：续传拨号到达时源端内容已换，ETag 与总长照旧（身份核对看不出）
	spliced := append([]byte(nil), payload...)
	for i := len(spliced) / 2; i < len(spliced); i++ {
		spliced[i] ^= 0xFF
	}
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if src.requestCount() == 1 { // 第 2 个请求 = 续传拨号：换内容不换身份信号
			src.mu.Lock()
			src.payload = spliced
			src.mu.Unlock()
		}
		src.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	var launches atomic.Int32
	origLaunch := launchUpdateSubprocessFn
	launchUpdateSubprocessFn = func(string, string, int, int, string, string, string) error {
		launches.Add(1)
		return nil
	}
	t.Cleanup(func() { launchUpdateSubprocessFn = origLaunch })

	notes := captureNotifications(t)
	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:        "9.9.9",
		DownloadURL:    srv.URL,
		FileSize:       int64(len(payload)),
		ChecksumSHA256: hex.EncodeToString(sum[:]),
	}})
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := m.StartUpdate(m.cachedInfo, "0.0.1", 0); err != nil {
		t.Fatalf("admission must succeed, got %v", err)
	}
	waitFor(t, "failed at verification", func() bool { return m.GetStatus().Status == StatusFailed })

	if st := m.GetStatus(); !strings.HasPrefix(st.ErrMsg, "update verification failed: checksum mismatch") {
		t.Fatalf("errMsg = %q, want the real sha256 gate refusing the spliced artifact", st.ErrMsg)
	}
	// 前提自证：拼接确实来自 Range 续传且过了身份核对（否则本用例退化成普通
	// 校验失败，钉不住「续传 × 校验」这个组合）——恰两个请求（身份核对不过会
	// 丢弃半截另发第 3 个全量请求），第 2 个带 Range
	if n := src.requestCount(); n != 2 {
		t.Fatalf("the splice must come from one cut attempt + one identity-accepted Range resume, got %d requests", n)
	}
	if r := src.requestAt(1); r.rangeHdr == "" {
		t.Fatalf("the second request must be the Range resume, got %+v", r)
	}
	if n := launches.Load(); n != 0 {
		t.Fatalf("a refused artifact must never reach the swap subprocess, launches = %d", n)
	}
	tmpDir := filepath.Join(m.dataDir, "tmp", "update-9.9.9")
	if _, err := os.Stat(tmpDir); !os.IsNotExist(err) {
		t.Fatalf("the refused artifact must be removed together with its tmp dir, stat err = %v", err)
	}
	waitFor(t, "started+failed notifications", func() bool { return len(notes()) == 2 })
	if got := notes(); got[0].TitleKey != notifyStartedTitleKey || got[1].Type != "error" ||
		got[1].TitleKey != notifyFailedTitleKey || !strings.Contains(got[1].Body, "checksum mismatch") {
		t.Fatalf("refusal must notify started→failed(with the verification reason), got %+v", got)
	}
}
