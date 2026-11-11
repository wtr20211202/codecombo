package update

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// P-20261110-1-S1 断点续传协议矩阵：Range 续传 / 漂移丢弃 / 416 与 200 全量回退 /
// 分母口径 / 中心分发缓存路径回归。发布源用 rangeSource 模拟（httptest 真实 HTTP
// 语义，Range/If-Range/ETag/Content-Range 各态可注入）；护栏：全程不触发真实换包
//（校验链以桩短路，ApplyUpdate 级用例的校验桩只读产物后即拒绝）。

// useLocalTestSource 放行本地测试源。生产语义双闸拒回环（validateDownloadURL 的
// https 公网校验 + 直连档拨号期 IP 守卫），续传演练需要 httptest 真实连接——
// 校验口走包级注入口，传输层换裸 Transport（不读代理 env，直连回环）
func useLocalTestSource(t *testing.T) {
	t.Helper()
	oldValidate := validateDownloadURL
	validateDownloadURL = func(string) error { return nil }
	oldClient := downloadClient
	downloadClient = &http.Client{Transport: &http.Transport{}}
	t.Cleanup(func() {
		validateDownloadURL = oldValidate
		downloadClient = oldClient
	})
}

// rangeReq 一次请求的续传相关头快照（断言「发了什么」的依据）
type rangeReq struct {
	rangeHdr string // 空 = 未带 Range（全量请求）
	ifRange  string
}

// rangeSource 可配置发布源：支持 Range（206 + Content-Range + ETag），可注入
// 不支持 Range（200 全量）/ 416 / 资产漂移（换 ETag 换内容）/ 中途断连各态
type rangeSource struct {
	mu      sync.Mutex
	payload []byte
	etag    string

	ignoreRange   bool   // 对 Range 请求照常回 200 全量（不支持 Range 的自建源）
	force416      bool   // 对 Range 请求回 416（Range 不可满足）
	driftETag     string // 非空：响应改用此 ETag（发布方重传资产；服务端不辨 If-Range 的形态）
	wildcardTotal bool   // Content-Range 总长回 "*"（服务端不知总长）
	cutSession    int    // >0：第 N 次请求写到半个 body 即断连（模拟停滞/进程死亡）
	cutAll        bool   // 每个请求都写到半个 body 即断连（持续不稳链路：续传重试耗尽仍失败）
	capRange      int    // >0：206 只回起点后至多 N 字节（截短区间，Content-Range 止于总长之前）

	seen []rangeReq
}

func (s *rangeSource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	idx := len(s.seen)
	s.seen = append(s.seen, rangeReq{rangeHdr: r.Header.Get("Range"), ifRange: r.Header.Get("If-Range")})
	ignoreRange, force416, drift, wildcard, cut, cutAll, capN := s.ignoreRange, s.force416, s.driftETag, s.wildcardTotal, s.cutSession, s.cutAll, s.capRange
	payload := append([]byte(nil), s.payload...)
	s.mu.Unlock()

	etag := s.etag
	if drift != "" {
		etag = drift
	}

	body := payload
	status := http.StatusOK
	if rng := r.Header.Get("Range"); rng != "" && !ignoreRange {
		if force416 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", len(payload)))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if start, ok := rangeStart(rng); ok && start > 0 && start < int64(len(payload)) {
			status = http.StatusPartialContent
			end := int64(len(payload))
			if capN > 0 && start+int64(capN) < end {
				end = start + int64(capN)
			}
			body = payload[start:end]
			total := strconv.Itoa(len(payload))
			if wildcard {
				total = "*"
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%s", start, end-1, total))
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(status)
	if cutAll || (cut > 0 && idx+1 == cut) {
		_, _ = w.Write(body[:len(body)/2])
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler) // 强拆连接：客户端读到 unexpected EOF
	}
	_, _ = w.Write(body)
}

func (s *rangeSource) requestCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}

func (s *rangeSource) requestAt(i int) rangeReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seen[i]
}

// rangeStart 解析本客户端只会发出的单段 Range 头形态（bytes=N-）
func rangeStart(h string) (int64, bool) {
	h = strings.TrimSpace(h)
	h = strings.TrimPrefix(h, "bytes=")
	h = strings.TrimSuffix(h, "-")
	n, err := strconv.ParseInt(strings.TrimSpace(h), 10, 64)
	return n, err == nil
}

// seedPart 预置「上一轮死亡留下的半截现场」
func seedPart(t *testing.T, dest string, half []byte, pm partMeta) {
	t.Helper()
	if err := os.WriteFile(dest+partSuffix, half, 0644); err != nil {
		t.Fatal(err)
	}
	if err := savePartMeta(dest+partMetaSuffix, &pm); err != nil {
		t.Fatal(err)
	}
}

func assertFinalState(t *testing.T, dest string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read final file: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("final file mismatch: got %d bytes, want %d identical", len(got), len(want))
	}
	if _, err := os.Stat(dest + partSuffix); !os.IsNotExist(err) {
		t.Fatal(".part must be gone after the atomic rename")
	}
	if _, err := os.Stat(dest + partMetaSuffix); !os.IsNotExist(err) {
		t.Fatal("side metadata must be removed after the rename")
	}
}

// 全流程两幕：首会话中途断连（全量响应写一半）→ .part + 元数据留存；重试会话
// 带 Range 续传补齐。这是「手动终止/进程死亡保留 .part」与「Range 续传」的主路径
func TestResumeCreatesMetaThenResumesAfterCut(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0xC3}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo.exe")
	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err == nil {
		t.Fatal("session 1 must fail (connection cut mid-body)")
	}
	part, err := os.Stat(dest + partSuffix)
	if err != nil || part.Size() == 0 {
		t.Fatalf(".part must survive the failed session, got %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("final path must not exist while the download is incomplete")
	}
	pm := loadPartMeta(dest + partMetaSuffix)
	if pm == nil || pm.URL != srv.URL || pm.Total != int64(len(payload)) || pm.ETag != `"v1"` {
		t.Fatalf("side metadata must record identity for the next session, got %+v", pm)
	}

	// 幕二：源端恢复（断连旋钮关闭）→ Range 从半截处续传
	src.mu.Lock()
	src.cutSession = 0
	src.mu.Unlock()
	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("session 2 (resume): %v", err)
	}
	req := src.requestAt(1)
	if req.rangeHdr != "bytes=50-" {
		t.Fatalf("resume request Range = %q, want bytes=50-", req.rangeHdr)
	}
	if req.ifRange != `"v1"` {
		t.Fatalf("resume request If-Range = %q, want the recorded etag", req.ifRange)
	}
	assertFinalState(t, dest, payload)
}

// 预置半截现场的单会话续传：Range/If-Range 头 + 单请求补齐
func TestResumeSeededPartCompletesInOneRequest(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x31}, 64)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0x31}, 40), partMeta{URL: srv.URL, ETag: `"v1"`, Total: int64(len(payload))})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if src.requestCount() != 1 {
		t.Fatalf("consistent identity must resume in one request, got %d", src.requestCount())
	}
	req := src.requestAt(0)
	if req.rangeHdr != "bytes=40-" || req.ifRange != `"v1"` {
		t.Fatalf("resume request = %+v, want Range bytes=40- + If-Range", req)
	}
	assertFinalState(t, dest, payload)
}

// 资产漂移（发布方重传：同 URL 新内容新 ETag）：206 身份核对不过 → 丢弃半截
// 全量重下，绝不让「半截 A + 半截 B」拼成假包
func TestResumeDriftDiscardsPartAndRedownloads(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	newPayload := bytes.Repeat([]byte{0xBB}, 80)
	src := &rangeSource{payload: newPayload, etag: `"v1"`, driftETag: `"v2"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 40), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("drift must fall back to a full download, got %v", err)
	}
	if src.requestCount() != 2 {
		t.Fatalf("drift = ranged request then plain re-download, got %d requests", src.requestCount())
	}
	if r := src.requestAt(1).rangeHdr; r != "" {
		t.Fatalf("re-download after drift must be a plain GET, got Range %q", r)
	}
	assertFinalState(t, dest, newPayload) // 旧半截的 0xAA 不得出现在成品里
}

// 源端不支持 Range：对 Range 请求回 200 全量 → .part 截断重写（回退全量语义，
// 自建更新源兼容），一个请求内完成、绝不追加
func TestResumeFallsBackToFullWhenRangeIgnored(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x77}, 50)
	src := &rangeSource{payload: payload, etag: `"v1"`, ignoreRange: true}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 30), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("200-fallback: %v", err)
	}
	if src.requestCount() != 1 {
		t.Fatalf("the 200 body is already the full asset — no second request, got %d", src.requestCount())
	}
	assertFinalState(t, dest, payload) // 追加实现会得到 0xAA 前缀 + 全量，在此拦死
}

// 416（Range 不可满足，.part 越界/源端资产变短）：丢弃半截回退全量
func TestResumeFallsBackToFullOn416(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x4C}, 40)
	src := &rangeSource{payload: payload, etag: `"v1"`, force416: true}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 30), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("416-fallback: %v", err)
	}
	if src.requestCount() != 2 {
		t.Fatalf("416 = discard then plain re-download, got %d requests", src.requestCount())
	}
	if r := src.requestAt(1).rangeHdr; r != "" {
		t.Fatalf("fallback after 416 must be a plain GET, got Range %q", r)
	}
	assertFinalState(t, dest, payload)
}

// 身份不可证（无 ETag 且总长不可知）：拒绝续传丢弃重下——宁全量不赌拼接
func TestResumeDiscardsWhenIdentityUnprovable(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x99}, 40)
	src := &rangeSource{payload: payload, etag: "", wildcardTotal: true}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 30), partMeta{URL: srv.URL})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("unprovable identity must fall back to full, got %v", err)
	}
	if src.requestCount() != 2 {
		t.Fatalf("unprovable identity = ranged then plain re-download, got %d", src.requestCount())
	}
	assertFinalState(t, dest, payload)
}

// 元数据 URL 与本次资产不符（换镜像/换资产指针）：丢弃重下
func TestResumeDiscardsWhenURLChanged(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x61}, 40)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 30), partMeta{URL: "https://example.com/old-asset", ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("url drift must fall back to full, got %v", err)
	}
	if src.requestCount() != 1 || src.requestAt(0).rangeHdr != "" {
		t.Fatalf("url drift must skip the Range attempt entirely, got %+v", src.seen)
	}
	assertFinalState(t, dest, payload)
}

// 分母口径（验收硬点）：续传追加态的分母来自元数据/Content-Range 总长——
// 禁采信 206 Content-Length（那是剩余尾段长度，作分母会把 100% 显示成 250%）
func TestResumeDenominatorFromContentRangeNot206ContentLength(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x44}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0x44}, 60), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 100})

	var cbTotal, cbProgress int64
	if err := m.downloadResumable(context.Background(), srv.URL, dest, func(n, total int64) {
		cbProgress, cbTotal = n, total
	}); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if m.GetStatus().Total != 100 {
		t.Fatalf("denominator = %d, want 100 from Content-Range/metadata (206 Content-Length is 40)", m.GetStatus().Total)
	}
	if st := m.GetStatus(); st.Progress != 100 {
		t.Fatalf("progress = %d, want cumulative 100 (60 resumed + 40 appended)", st.Progress)
	}
	if cbTotal != 100 || cbProgress != 100 {
		t.Fatalf("progress callback = %d/%d, want 100/100", cbProgress, cbTotal)
	}
	assertFinalState(t, dest, payload)
}

// 完整性闸：源端截短 206 区间（Content-Range 止于总长之前，body 按自身长度读完
// 即 EOF）——不得当成下载完成 rename 出半截成品；.part 保留增长后的字节，下一
// 会话从截断处续传补齐
func TestResumeTruncatedRangeKeepsPartUntilComplete(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x2E}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`, capRange: 20}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0x2E}, 40), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 100})

	err := m.downloadResumable(context.Background(), srv.URL, dest, nil)
	if err == nil || !strings.Contains(err.Error(), "download incomplete") {
		t.Fatalf("a truncated 206 must not count as complete, got %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("final path must not exist while the asset is incomplete")
	}
	if part, err := os.Stat(dest + partSuffix); err != nil || part.Size() != 60 {
		t.Fatalf(".part must keep the appended bytes (40+20), got %v", err)
	}
	if st := m.GetStatus(); st.Progress != 60 {
		t.Fatalf("progress = %d, want the true cumulative 60", st.Progress)
	}

	src.mu.Lock()
	src.capRange = 0
	src.mu.Unlock()
	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("follow-up session: %v", err)
	}
	if r := src.requestAt(1).rangeHdr; r != "bytes=60-" {
		t.Fatalf("follow-up must resume from the truncation point, got Range %q", r)
	}
	assertFinalState(t, dest, payload)
}

// 弱 ETag：不发 If-Range（RFC 9110 弱校验符作 If-Range 条件恒不成立，发了就
// 每次全量）——Range 照发，身份仍由 206 ETag/总长核对兜底
func TestResumeWeakETagSkipsIfRange(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x57}, 64)
	src := &rangeSource{payload: payload, etag: `W/"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0x57}, 24), partMeta{URL: srv.URL, ETag: `W/"v1"`, Total: 64})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("resume: %v", err)
	}
	req := src.requestAt(0)
	if req.rangeHdr != "bytes=24-" || req.ifRange != "" {
		t.Fatalf("weak etag resume = %+v, want Range bytes=24- without If-Range", req)
	}
	if src.requestCount() != 1 {
		t.Fatalf("weak etag must still resume in one request, got %d", src.requestCount())
	}
	assertFinalState(t, dest, payload)
}

// 半截比元数据记录的全量还长：内容已不可信，起步即丢弃全量重下（不发 Range）
func TestResumeOversizedPartDiscardedUpfront(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x6F}, 60)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 70), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("oversized part must fall back to full, got %v", err)
	}
	if src.requestCount() != 1 || src.requestAt(0).rangeHdr != "" {
		t.Fatalf("oversized part must skip the Range attempt, got %+v", src.seen)
	}
	assertFinalState(t, dest, payload)
}

// 续传起点透出（P-20261110-1-S4）：首会话全量写（resumed=0）失败留半截；续传
// 会话的进度状态带实际续传偏移（半截 50），且采样窗内 progress 恒 ≤ total（分母取
// .part 元数据总长而非 206 Content-Length——续传态进度不得超 100%）
func TestResumeSurfacesResumedBytesWithCappedProgress(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x8B}, 100)
	src := &rangeSource{payload: payload, etag: `"v1"`, cutSession: 1}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")

	// 幕一：全新下载（全量响应写一半断连）——续传起点保持 0
	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err == nil {
		t.Fatal("session 1 must fail (connection cut mid-body)")
	}
	if st := m.GetStatus(); st.ResumedBytes != 0 {
		t.Fatalf("a full-write attempt must report resumedBytes 0, got %d", st.ResumedBytes)
	}

	// 幕二：Range 续传——回调采样窗内 resumedBytes 恒等于续传起点 40，
	// 且 progress 恒 ≤ total（分母口径 = 元数据总长 100）
	type sample struct{ progress, total, resumed int64 }
	var samples []sample
	if err := m.downloadResumable(context.Background(), srv.URL, dest, func(n, total int64) {
		st := m.GetStatus()
		samples = append(samples, sample{progress: st.Progress, total: st.Total, resumed: st.ResumedBytes})
		if n > total {
			t.Errorf("resumed-state sample %d exceeds denominator %d (>100%%)", n, total)
		}
	}); err != nil {
		t.Fatalf("session 2 (resume): %v", err)
	}
	if src.requestAt(1).rangeHdr != "bytes=50-" {
		t.Fatalf("session 2 must resume from 50, got Range %q", src.requestAt(1).rangeHdr)
	}
	if len(samples) == 0 {
		t.Fatal("progress callback must fire during the resumed session")
	}
	for i, s := range samples {
		if s.resumed != 50 {
			t.Fatalf("sample %d resumedBytes = %d, want the actual resume offset 50", i, s.resumed)
		}
		if s.total != 100 {
			t.Fatalf("sample %d denominator = %d, want metadata total 100 (not the 206 tail 50)", i, s.total)
		}
		if s.progress < 50 || s.progress > 100 {
			t.Fatalf("sample %d progress = %d, want cumulative in [50,100]", i, s.progress)
		}
	}
	if st := m.GetStatus(); st.ResumedBytes != 50 || st.Progress != 100 || st.Total != 100 {
		t.Fatalf("final state = resumed %d progress %d/%d, want resumed 50 at exactly 100/100",
			st.ResumedBytes, st.Progress, st.Total)
	}
	assertFinalState(t, dest, payload)
}

// 全量回退（身份核对不过丢弃半截）把续传起点归 0：回退会话是全量重下，
// 「已续传」提示不得残留上一会话的偏移
func TestResumeFullFallbackResetsResumedBytes(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	newPayload := bytes.Repeat([]byte{0xCC}, 80)
	src := &rangeSource{payload: newPayload, etag: `"v1"`, driftETag: `"v2"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "codecombo")
	seedPart(t, dest, bytes.Repeat([]byte{0xAA}, 40), partMeta{URL: srv.URL, ETag: `"v1"`, Total: 60})

	if err := m.downloadResumable(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("drift fallback full download: %v", err)
	}
	if st := m.GetStatus(); st.ResumedBytes != 0 {
		t.Fatalf("full fallback must report resumedBytes 0, got %d", st.ResumedBytes)
	}
	if st := m.GetStatus(); st.Progress != int64(len(newPayload)) {
		t.Fatalf("progress = %d, want the full re-download %d", st.Progress, len(newPayload))
	}
	assertFinalState(t, dest, newPayload)
}

// 中心分发缓存路径回归（作用域收窄定案）：DownloadToFile 直写 dest、无 .part
// 旁产物、不回写状态机进度——api/system/update.go 的 .downloading 模式零改动
func TestDownloadToFileKeepsDirectWriteWithoutPart(t *testing.T) {
	m := testManager(t)
	useLocalTestSource(t)
	payload := bytes.Repeat([]byte{0x53}, 128)
	src := &rangeSource{payload: payload, etag: `"v1"`}
	srv := httptest.NewServer(src)
	t.Cleanup(srv.Close)

	dest := filepath.Join(t.TempDir(), "serve-codecombo-v9.9.9")
	if err := m.DownloadToFile(context.Background(), srv.URL, dest); err != nil {
		t.Fatalf("download: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("direct write mismatch: %v (%d bytes)", err, len(got))
	}
	if _, err := os.Stat(dest + partSuffix); !os.IsNotExist(err) {
		t.Fatal("central cache path must not produce .part artifacts")
	}
	if _, err := os.Stat(dest + partMetaSuffix); !os.IsNotExist(err) {
		t.Fatal("central cache path must not produce side metadata")
	}
	if st := m.GetStatus(); st.Progress != 0 || st.Total != 0 {
		t.Fatalf("serve download must not touch the state machine, got %d/%d", st.Progress, st.Total)
	}
}

// ── 解析与判定纯函数 ─────────────────────────────────────────────────────

func TestParseContentRange(t *testing.T) {
	cases := []struct {
		in     string
		start  int64
		total  int64
		wantOK bool
	}{
		{"bytes 60-99/100", 60, 100, true},
		{"BYTES 0-0/1", 0, 1, true},
		{"bytes 0-499/*", 0, 0, true},                 // 总长未知归一 0
		{"bytes 60-99", 0, 0, false},                  // 缺总长段
		{"items 60-99/100", 0, 0, false},              // 非 bytes 单位
		{"bytes 60/100", 0, 0, false},                 // 缺 end
		{"bytes 60-99/100, 200-299/100", 0, 0, false}, // 多段形态不是单段答案
		{"", 0, 0, false},
	}
	for _, c := range cases {
		cr, ok := parseContentRange(c.in)
		if ok != c.wantOK || (ok && (cr.Start != c.start || cr.Total != c.total)) {
			t.Errorf("parseContentRange(%q) = %+v,%v want start=%d total=%d ok=%v", c.in, cr, ok, c.start, c.total, c.wantOK)
		}
	}
}

func TestResumeIdentityOK(t *testing.T) {
	cases := []struct {
		name     string
		pm       partMeta
		respETag string
		cr       contentRange
		want     bool
	}{
		{"etag match", partMeta{ETag: `"a"`, Total: 100}, `"a"`, contentRange{Start: 40, Total: 100}, true},
		{"etag mismatch = drift", partMeta{ETag: `"a"`, Total: 100}, `"b"`, contentRange{Total: 100}, false},
		{"total mismatch = drift", partMeta{ETag: `"a"`, Total: 100}, `"a"`, contentRange{Total: 120}, false},
		{"total only, match", partMeta{Total: 100}, "", contentRange{Total: 100}, true},
		{"etag only, match", partMeta{ETag: `"a"`}, `"a"`, contentRange{Total: 0}, true},
		{"both absent = unprovable", partMeta{}, "", contentRange{Total: 0}, false},
		{"meta empty resp total only", partMeta{Total: 0}, "", contentRange{Total: 100}, false},
	}
	for _, c := range cases {
		if got := resumeIdentityOK(&c.pm, c.respETag, c.cr); got != c.want {
			t.Errorf("%s: resumeIdentityOK = %v, want %v", c.name, got, c.want)
		}
	}
}

// ── 启动期孤儿目录清理 ───────────────────────────────────────────────────

// CleanupOldUpdateTmp：超 7 天的 update-* 整目录回收；目录 mtime 陈旧但子项
// 活跃（长会话追加 .part 不动目录 mtime）不误杀；serve-* 与非目录项不动
func TestCleanupOldUpdateTmp(t *testing.T) {
	dd := t.TempDir()
	tmp := filepath.Join(dd, "tmp")
	stale := filepath.Join(tmp, "update-1.0.0")
	active := filepath.Join(tmp, "update-2.0.0")
	fresh := filepath.Join(tmp, "update-3.0.0")
	serve := filepath.Join(tmp, "serve-win-x64")
	for _, d := range []string{stale, active, fresh, serve} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	staleTime := time.Now().Add(-8 * 24 * time.Hour)
	touch := func(path string, at time.Time) {
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	seed := func(dir string, at time.Time) {
		if err := os.WriteFile(filepath.Join(dir, "codecombo.exe.part"), []byte("partial"), 0644); err != nil {
			t.Fatal(err)
		}
		touch(filepath.Join(dir, "codecombo.exe.part"), at)
		touch(dir, at)
	}
	seed(stale, staleTime)
	// 目录 mtime 陈旧但 .part 活跃（8 天前建目录、刚追加过续传字节）
	seed(active, staleTime)
	touch(filepath.Join(active, "codecombo.exe.part"), time.Now())

	CleanupOldUpdateTmp(dd)

	for _, p := range []string{active, fresh, serve} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s must survive the cleanup: %v", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale update-* dir must be removed")
	}
}

// 清理线车道边界（P-20261110-1-S2 收编并入）：清理线以前缀分车道——CleanupOldUpdateTmp
// 只收 update-* 目录，同样陈旧的 serve-* 归 CleanupServeCache 的 1h 线、非目录条目
// 不归任何清理线；反方向 CleanupServeCache 亦不越界（2 天的 update-* 已过 serve 线
// 1h、未到 update 线 7d，两线前缀互不越界才活）。上方用例的 serve-* 为新建目录、
// 判不出前缀越界；本用例各越界哨兵的年龄都已超过「若越界即会被误清」的那条线
func TestCleanupUpdateTmpLaneBoundaries(t *testing.T) {
	dd := t.TempDir()
	tmp := filepath.Join(dd, "tmp")
	age := func(path string, d time.Duration) {
		t.Helper()
		at := time.Now().Add(-d)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	// 子项与目录 mtime 一并倒拨（新鲜度取目录与直接子项 mtime 最大值，只拨目录会被
	// 新鲜子项判活）；内容先落、时间后改——写文件会顶掉目录 mtime
	mkDir := func(name string, d time.Duration) string {
		t.Helper()
		dir := filepath.Join(tmp, name)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		child := filepath.Join(dir, "codecombo-linux-amd64.part")
		if err := os.WriteFile(child, []byte("half"), 0644); err != nil {
			t.Fatal(err)
		}
		age(child, d)
		age(dir, d)
		return dir
	}
	stale := mkDir("update-1.2.2", 8*24*time.Hour)
	midAge := mkDir("update-1.2.4", 2*24*time.Hour)
	serve := mkDir("serve-linux-amd64", 8*24*time.Hour)
	stray := filepath.Join(tmp, "update-not-a-dir")
	if err := os.WriteFile(stray, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	age(stray, 8*24*time.Hour)

	CleanupOldUpdateTmp(dd)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale update-* dir should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(midAge); err != nil {
		t.Fatalf("update dir within the 7d window must survive: %v", err)
	}
	if _, err := os.Stat(serve); err != nil {
		t.Fatalf("serve-* dirs belong to CleanupServeCache (1h), not the update sweeper: %v", err)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("non-directory entries must be left alone: %v", err)
	}

	// 反方向：serve 线只收 serve-*，2 天的 update 目录不被它按 1h 口径提前清掉
	CleanupServeCache(dd)
	if _, err := os.Stat(serve); !os.IsNotExist(err) {
		t.Fatalf("stale serve-* dir should be removed by CleanupServeCache, stat err = %v", err)
	}
	if _, err := os.Stat(midAge); err != nil {
		t.Fatalf("CleanupServeCache must not touch update-* dirs: %v", err)
	}
}

// tmp 目录不存在（全新实例/空数据目录）：两条启动期清理线静默返回
func TestCleanupUpdateTmpMissingTmpDir(t *testing.T) {
	dd := t.TempDir()
	CleanupOldUpdateTmp(dd) // 不 panic 即通过
	CleanupServeCache(dd)
}
