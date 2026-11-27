package diagnostics

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// P-20261124-1 契约：请求环阈值/时间线解析/签名去重/大文件红线/注入面缺席语义

func TestRequestRingOnlyKeepsSlowErrorPanic(t *testing.T) {
	ResetTimelineForTesting()
	t.Cleanup(ResetTimelineForTesting)
	// 快请求被丢弃
	RecordRequest(RequestRecord{Route: "/api/fast", DurationMS: 10, Status: 200})
	if got := RequestsSnapshot(); len(got) != 0 {
		t.Fatalf("fast request must not enter the ring: %+v", got)
	}
	// 慢 / 5xx / panic 三种都入环
	RecordRequest(RequestRecord{Route: "/api/slow", DurationMS: 1500, Status: 200})
	RecordRequest(RequestRecord{Route: "/api/err", DurationMS: 5, Status: 503})
	RecordRequest(RequestRecord{Route: "/api/panic", DurationMS: 5, Status: 500, Panic: true})
	if got := RequestsSnapshot(); len(got) != 3 {
		t.Fatalf("ring size = %d, want 3", len(got))
	}
	// 容量覆盖式：超过 200 只留最新
	for i := 0; i < requestRingCapacity+5; i++ {
		RecordRequest(RequestRecord{Route: "/api/x", DurationMS: 1001, Status: 200})
	}
	got := RequestsSnapshot()
	if len(got) != requestRingCapacity {
		t.Fatalf("ring size = %d, want %d", len(got), requestRingCapacity)
	}
	if doc := renderRequestsJSON(time.Now(), nil); strings.Contains(doc, "query=") || strings.Contains(doc, "body=") {
		t.Fatal("requests.json must never carry query/body fields")
	}
}

func TestParseGinLineQuotedSlog(t *testing.T) {
	line := `time=2026-11-24T21:37:01Z level=INFO msg="[GIN] 2026/11/24 - 21:37:01 | 200 |   2m33s |    192.168.1.5 | GET      \"/api/share?token=SECRET\" rid=abc123def456"`
	a := newAnalyzer(NewRedactor(t.TempDir(), true))
	sr, ok := a.parseGinLine(line, "logs/x.log")
	if !ok {
		t.Fatal("quoted slog gin line must parse")
	}
	if sr.duration != 2*time.Minute+33*time.Second {
		t.Fatalf("duration = %v", sr.duration)
	}
	if sr.rid != "abc123def456" {
		t.Fatalf("rid = %q", sr.rid)
	}
	if sr.clientIP != "192.168.1.5" {
		t.Fatalf("clientIp = %q", sr.clientIP)
	}
	if strings.Contains(sr.route, "token") || strings.Contains(sr.route, "?") {
		t.Fatalf("query must be dropped from route, got %q", sr.route)
	}
	if sr.route != "/api/share" {
		t.Fatalf("route = %q", sr.route)
	}
	if !sr.startedAt.Equal(sr.completedAt.Add(-sr.duration)) {
		t.Fatal("startedAt must be completedAt - latency")
	}
	// 非 GIN 行不解析
	if _, ok := a.parseGinLine("plain log line", "logs/x.log"); ok {
		t.Fatal("non-GIN line must not parse")
	}
}

func TestTemplateRoute(t *testing.T) {
	cases := map[string]string{
		"/api/projects/550e8400-e29b-41d4-a716-446655440000/files": "/api/projects/:id/files",
		"/api/terminal/12345":                    "/api/terminal/:id",
		"/api/x/0123456789abcdef":                "/api/x/:id",
		"/api/share/sc_abcdefghijklmnopqrstuvwx": "/api/share/:id",
		"/api/health":                            "/api/health",
	}
	for in, want := range cases {
		if got := templateRoute(in); got != want {
			t.Fatalf("templateRoute(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestErrorSignatureDedupe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "codecombo-2026-11-24.log")
	body := strings.Join([]string{
		`time=2026-11-24T09:00:01Z level=ERROR msg="tls: unknown certificate from 10.0.0.5 attempt 1"`,
		`time=2026-11-24T09:00:02Z level=ERROR msg="tls: unknown certificate from 10.0.0.5 attempt 2"`,
		`time=2026-11-24T09:00:03Z level=ERROR msg="tls: unknown certificate from 10.0.0.5 attempt 3"`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	an := newAnalyzer(NewRedactor(dir, true))
	st := an.analyze("logs/x.log", path, int64(len(body)))
	if st.errors != 3 {
		t.Fatalf("errors = %d", st.errors)
	}
	out := renderErrors(an)
	// 同一签名只写一次原文，签名表给 count=3（TLS 风暴收敛）
	if n := strings.Count(out, "unknown certificate"); n > 3 {
		t.Fatalf("signature dedupe failed, occurrences=%d\n%s", n, out)
	}
	if !strings.Contains(out, "3 | ") {
		t.Fatalf("signature table missing count=3:\n%s", out)
	}
}

func TestRunDeadlineTimeout(t *testing.T) {
	v, timedOut := runDeadline(time.Now().Add(20*time.Millisecond), func() int {
		time.Sleep(300 * time.Millisecond)
		return 7
	})
	if !timedOut || v != 0 {
		t.Fatalf("expected timeout with zero value, got %d timedOut=%t", v, timedOut)
	}
	// 未超时路径
	v, timedOut = runDeadline(time.Now().Add(time.Second), func() int { return 9 })
	if timedOut || v != 9 {
		t.Fatalf("expected 9, got %d timedOut=%t", v, timedOut)
	}
	// 零值 deadline = 不设限
	v, timedOut = runDeadline(time.Time{}, func() int { return 11 })
	if timedOut || v != 11 {
		t.Fatalf("zero deadline must run synchronously, got %d", v)
	}
}

func TestMissingIPs(t *testing.T) {
	got := missingIPs([]string{"10.0.0.5", "10.0.0.6", "192.168.1.9"}, []string{"10.0.0.5", "127.0.0.1"})
	if strings.Join(got, ",") != "10.0.0.6,192.168.1.9" {
		t.Fatalf("missingIPs = %v", got)
	}
	if missingIPs(nil, []string{"1.1.1.1"}) != nil {
		t.Fatal("no SAN -> nil, not a flood of false 'missing' entries")
	}
}

func TestLargeFilesDataDirNamesNeverListed(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "master-key"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logs", "big.log"), []byte(strings.Repeat("x", 4096)), 0o644); err != nil {
		t.Fatal(err)
	}
	_, files := collectStorage(dir, nil, NewRedactor(dir, true), time.Now(), time.Time{})
	if files.DataFiles != 1 {
		t.Fatalf("data files = %d, want 1", files.DataFiles)
	}
	out := renderLargeFilesJSON(files, dir, NewRedactor(dir, true))
	if strings.Contains(out, "master-key") {
		t.Fatalf("data/ file name leaked into large-files.json:\n%s", out)
	}
	if !strings.Contains(out, "big.log") {
		t.Fatalf("normal log must be listed:\n%s", out)
	}
}

func TestInjectedSectionsSkippedWhenAbsent(t *testing.T) {
	ResetTimelineForTesting()
	t.Cleanup(ResetTimelineForTesting)
	if got := renderShareHealthJSON(nil); !strings.Contains(got, `"skipped"`) {
		t.Fatalf("absent share health must be skipped: %s", got)
	}
	if got := renderSelfProbeJSON(nil); !strings.Contains(got, "skipped") {
		t.Fatalf("absent self-probe must be skipped: %s", got)
	}
	doc := renderStallsJSON(time.Now(), nil)
	if !strings.Contains(doc, `"status": "skipped"`) {
		t.Fatalf("watchdog not started must be skipped: %s", doc)
	}
}

func TestSlowRequestsRenderingDropsQuery(t *testing.T) {
	a := newAnalyzer(NewRedactor(t.TempDir(), true))
	a.slow = []slowRequest{{
		file: "logs/x.log", completedAt: time.Date(2026, 11, 24, 21, 37, 1, 0, time.Local),
		startedAt: time.Date(2026, 11, 24, 21, 34, 28, 0, time.Local),
		duration:  2*time.Minute + 33*time.Second, status: 200, method: "GET",
		route: "/api/share", rid: "abc", clientIP: "10.0.0.5",
	}}
	out := a.renderSlowRequests()
	if !strings.Contains(out, "/api/share") || strings.Contains(out, "token=") {
		t.Fatalf("slow-requests output wrong:\n%s", out)
	}
	if !strings.Contains(out, "153000") {
		t.Fatalf("durationMs missing:\n%s", out)
	}
}

// 连续 gap 合并：多文件时间轴交叉/窗口切段会为同一段静默各报一次，
// 合并后只留一条（start 取最早、end 取最晚、上下文取后段）
func TestMergeGaps(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 21, 34, 0, 0, time.Local)
	gaps := []gapCandidate{
		{start: t0.Add(10 * time.Minute), end: t0.Add(12 * time.Minute), after: []string{"b"}},
		{start: t0, end: t0.Add(3 * time.Minute), before: []string{"a"}},
		{start: t0.Add(3 * time.Minute), end: t0.Add(10 * time.Minute)},
	}
	out := mergeGaps(gaps)
	if len(out) != 1 {
		t.Fatalf("merged gaps = %d, want 1: %+v", len(out), out)
	}
	if !out[0].start.Equal(t0) || !out[0].end.Equal(t0.Add(12*time.Minute)) {
		t.Fatalf("merged range = %s..%s", out[0].start, out[0].end)
	}
	if len(out[0].before) != 1 || len(out[0].after) != 1 {
		t.Fatalf("context must keep first-before and last-after: %+v", out[0])
	}
}

// 窗口边界的伪 gap：头窗口末尾与尾窗口开头之间隔着被省略的中段，不能算停顿
func TestWindowedAnalysisDoesNotInventSeamGap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.log")
	var b strings.Builder
	line := func(ts string) string {
		return `time=` + ts + ` level=INFO msg="[GIN] ` + ts[:10] + ` - ` + ts[11:19] + ` | 200 | 5ms | 10.0.0.5 | GET \"/api/x\" rid=r1"` + "\n"
	}
	b.WriteString(line("2026-11-24T09:00:00Z"))
	// 20MiB：超过 head(2MiB)+tail(14MiB) 才真正进入窗口形态（8–16MiB 区间
	// head+tail 已覆盖全文，装箱层按全带处理）
	b.WriteString(strings.Repeat("# filler\n", (20<<20)/9))
	b.WriteString(line("2026-11-24T23:00:00Z"))
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	a := newAnalyzer(NewRedactor(dir, true))
	st := a.analyze("logs/big.log", path, int64(b.Len()))
	if !st.windowed {
		t.Fatal("file must be analysed as a window")
	}
	if len(a.gaps) != 0 {
		t.Fatalf("seam must not produce a gap, got %d", len(a.gaps))
	}
}

// 采集报告契约：Plan 产出的 manifest 带 deep 字段（增量契约），
// collection-report 记录探针五态且带 logWrite 段
func TestPlanDeepManifestAndCollectionReport(t *testing.T) {
	dir, now := fixtureDir(t)
	b, err := Plan(context.Background(), Options{DataDir: dir, Version: "9.9.9", Now: now, Mask: true, Deep: true})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if !b.Manifest.Deep {
		t.Fatal("manifest.deep must be true for deep collection")
	}
	byName := map[string]Entry{}
	for _, e := range b.Manifest.Entries {
		byName[e.Name] = e
	}
	for _, want := range []string{
		"state/requests.json", "state/stalls.json", "state/host.json", "state/host-history.json",
		"state/net.json", "state/tls.json", "state/share-health.json", "state/self-probe.json",
		"state/large-files.json", "state/collection-report.json",
	} {
		if e := byName[want]; e.Status != StatusDerived {
			t.Fatalf("%s status = %q, want derived", want, e.Status)
		}
	}
	var report reportDoc
	for _, e := range b.entries {
		if e.meta.Name != "state/collection-report.json" {
			continue
		}
		if err := json.Unmarshal(e.content, &report); err != nil {
			t.Fatalf("collection-report invalid json: %v", err)
		}
	}
	if !report.Deep || report.BudgetMS <= 0 {
		t.Fatalf("collection-report header off: deep=%t budgetMs=%d", report.Deep, report.BudgetMS)
	}
	if len(report.Probes) == 0 {
		t.Fatal("collection-report must list probes")
	}
	if report.LogWrite == nil {
		t.Fatal("collection-report must carry the logWrite probe")
	}
	if b.Manifest.SchemaVersion != 1 {
		t.Fatalf("schemaVersion = %d, want 1 (incremental contract)", b.Manifest.SchemaVersion)
	}
}
