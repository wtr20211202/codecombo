package system

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// CSP 报告端点单测（P-20261007-6）：解析两代上报形态、聚合入审计、
// 敏感原文不入账、有界防线（请求体/条数/ distinct 键）。

func setupCSPReportStore(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	resetCSPReportsForTest()
	t.Cleanup(func() {
		resetCSPReportsForTest()
		store.SetDefault(nil)
	})
}

func performCSPReport(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	// 走真实 gin 引擎而非直调 handler：204/413 是纯 Status 响应，直调时
	// responseWriter 不落 header 到 recorder（需引擎收尾 WriteHeaderNow）
	r := gin.New()
	r.POST("/api/csp-report", CollectCSPReport)
	req := httptest.NewRequest(http.MethodPost, "/api/csp-report", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/csp-report")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func cspAuditEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	var out []store.AuditEvent
	for _, e := range auditEventsForTesting(t) {
		if e.Action == store.AuditCSPViolation {
			out = append(out, e)
		}
	}
	return out
}

// TestCSPReport_LegacyReportAudited application/csp-report 形态：首个批次立即
// 落一条 security.csp_violation；blocked URL 只留 origin，document-uri/
// original-policy/script-sample 结构上不入账。
func TestCSPReport_LegacyReportAudited(t *testing.T) {
	setupCSPReportStore(t)

	body := `{"csp-report":{` +
		`"document-uri":"https://app.example/project/secret?token=DOCSECRET",` +
		`"violated-directive":"script-src 'self'",` +
		`"effective-directive":"script-src-elem",` +
		`"blocked-uri":"https://User:pass@Evil.Example.com:8443/x?q=BLOCKSECRET",` +
		`"original-policy":"default-src 'self'; script-src 'self'",` +
		`"script-sample":"alert('SAMPLESECRET')"}}`
	w := performCSPReport(t, body)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", w.Code, w.Body.String())
	}

	events := cspAuditEvents(t)
	if len(events) != 1 {
		t.Fatalf("csp audit events = %d, want 1: %+v", len(events), events)
	}
	e := events[0]
	if e.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want success", e.Result)
	}
	wantTop := "script-src-elem|https://evil.example.com:8443:1"
	if !strings.Contains(e.Detail, wantTop) {
		t.Errorf("detail = %q; want top entry %q", e.Detail, wantTop)
	}
	if !strings.Contains(e.Detail, "reports=1 distinct=1 dropped=0") {
		t.Errorf("detail = %q; want aggregate counters", e.Detail)
	}
	// 敏感/原文面绝不入账：document-uri 的 token、阻塞 URL 的 path/query/userinfo、
	// 策略原文与 script-sample 都不得出现在 Detail
	for _, leak := range []string{"DOCSECRET", "BLOCKSECRET", "User:pass", "/x?", "alert(", "original-policy", "document-uri"} {
		if strings.Contains(e.Detail, leak) {
			t.Errorf("detail leaked %q: %q", leak, e.Detail)
		}
	}
}

// TestCSPReport_ReportingAPIBatched Reporting API 数组形态：多条同批聚合成
// 一条；非 csp-violation 类型忽略；data: 内容主体只留 scheme 标记。
func TestCSPReport_ReportingAPIBatched(t *testing.T) {
	setupCSPReportStore(t)

	body := `[` +
		`{"type":"csp-violation","url":"https://app.example/","body":{` +
		`"documentURL":"https://app.example/?token=DOCSECRET",` +
		`"blockedURL":"inline","effectiveDirective":"script-src",` +
		`"sample":"alert('SAMPLESECRET')","originalPolicy":"script-src 'self'"}},` +
		`{"type":"csp-violation","body":{` +
		`"blockedURL":"data:image/png;base64,U0VDUkVU","effectiveDirective":"img-src"}},` +
		`{"type":"deprecation","body":{}}` +
		`]`
	if w := performCSPReport(t, body); w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}

	events := cspAuditEvents(t)
	if len(events) != 1 {
		t.Fatalf("csp audit events = %d, want 1: %+v", len(events), events)
	}
	d := events[0].Detail
	if !strings.Contains(d, "reports=2 distinct=2 dropped=0") {
		t.Errorf("detail = %q; want two reports / two distinct sources", d)
	}
	if !strings.Contains(d, "script-src|inline:1") || !strings.Contains(d, "img-src|data::1") {
		t.Errorf("detail = %q; want both normalized sources", d)
	}
	for _, leak := range []string{"DOCSECRET", "SAMPLESECRET", "U0VDUkVU", "base64"} {
		if strings.Contains(d, leak) {
			t.Errorf("detail leaked %q: %q", leak, d)
		}
	}
}

// TestCSPReport_WindowAggregation 窗口内聚合：首个报告即时落账，同窗口后续
// 报告只累计，flush 时落一条汇总（计数合并、不逐条刷台账）。
func TestCSPReport_WindowAggregation(t *testing.T) {
	setupCSPReportStore(t)

	legacy := `{"csp-report":{"effective-directive":"script-src","blocked-uri":"inline"}}`
	for i := 0; i < 3; i++ {
		if w := performCSPReport(t, legacy); w.Code != http.StatusNoContent {
			t.Fatalf("post %d status = %d, want 204", i, w.Code)
		}
	}
	cspReports.flush()

	events := cspAuditEvents(t)
	if len(events) != 2 {
		t.Fatalf("csp audit events = %d, want 2 (immediate + window flush): %+v", len(events), events)
	}
	var aggregated string
	for _, e := range events {
		if strings.Contains(e.Detail, "reports=2") {
			aggregated = e.Detail
		}
	}
	if aggregated == "" {
		t.Fatalf("window aggregate (reports=2) missing: %+v", events)
	}
	if !strings.Contains(aggregated, "script-src|inline:2") {
		t.Errorf("aggregate detail = %q; want count 2 for script-src|inline", aggregated)
	}
}

// TestCSPReport_MalformedIgnored 语法错误/空体/非 CSP 形态：仍回 204（浏览器
// fire-and-forget），不产生任何台账噪声。
func TestCSPReport_MalformedIgnored(t *testing.T) {
	setupCSPReportStore(t)
	for _, body := range []string{"", "not-json", "{}", "[]", `{"foo":"bar"}`} {
		if w := performCSPReport(t, body); w.Code != http.StatusNoContent {
			t.Errorf("body %q status = %d, want 204", body, w.Code)
		}
	}
	if events := cspAuditEvents(t); len(events) != 0 {
		t.Errorf("malformed reports produced %d audit events: %+v", len(events), events)
	}
}

// TestCSPReport_BodyTooLarge 请求体上限：超限 413，不解析不入账
// （公开端点的报文体量防线）。
func TestCSPReport_BodyTooLarge(t *testing.T) {
	setupCSPReportStore(t)
	body := `{"csp-report":{"blocked-uri":"` + strings.Repeat("a", cspReportMaxBody+1024) + `"}}`
	if w := performCSPReport(t, body); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
	if events := cspAuditEvents(t); len(events) != 0 {
		t.Errorf("oversized report produced %d audit events", len(events))
	}
	if cspReports.timer != nil {
		t.Error("oversized report should not start the aggregation timer")
	}
}

// TestCSPReport_DistinctCapBounded distinct 键上限：超出部分只累计 dropped，
// 内存有界且溢出可见（不静默丢失观测量）。
func TestCSPReport_DistinctCapBounded(t *testing.T) {
	setupCSPReportStore(t)
	old := cspMaxDistinctSources
	cspMaxDistinctSources = 2
	t.Cleanup(func() { cspMaxDistinctSources = old })

	body := `[` +
		`{"type":"csp-violation","body":{"effectiveDirective":"img-src","blockedURL":"https://a.example"}},` +
		`{"type":"csp-violation","body":{"effectiveDirective":"img-src","blockedURL":"https://b.example"}},` +
		`{"type":"csp-violation","body":{"effectiveDirective":"img-src","blockedURL":"https://c.example"}}` +
		`]`
	if w := performCSPReport(t, body); w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
	events := cspAuditEvents(t)
	if len(events) != 1 {
		t.Fatalf("csp audit events = %d, want 1", len(events))
	}
	d := events[0].Detail
	if !strings.Contains(d, "reports=3 distinct=2 dropped=1") {
		t.Errorf("detail = %q; want reports=3 distinct=2 dropped=1", d)
	}
}

// TestCSPReport_ParseItemCap 单请求条数上限：超出的报告计入 dropped
func TestCSPReport_ParseItemCap(t *testing.T) {
	var reports []map[string]any
	for i := 0; i < cspReportMaxItems+2; i++ {
		reports = append(reports, map[string]any{
			"type": "csp-violation",
			"body": map[string]any{
				"effectiveDirective": "img-src",
				"blockedURL":         fmt.Sprintf("https://h%d.example", i),
			},
		})
	}
	raw, err := json.Marshal(reports)
	if err != nil {
		t.Fatalf("marshal reports: %v", err)
	}
	sources, dropped := parseCSPReports(raw)
	if len(sources) != cspReportMaxItems || dropped != 2 {
		t.Fatalf("sources=%d dropped=%d; want %d/%d", len(sources), dropped, cspReportMaxItems, 2)
	}
}

// TestNormalizeCSPBlocked blocked-uri 归一化：origin 粒度、关键字保留、
// 控制字符/聚合分隔符清洗（Detail 单行可解析）。
func TestNormalizeCSPBlocked(t *testing.T) {
	cases := []struct{ in, want string }{
		{"inline", "inline"},
		{"INLINE", "inline"},
		{"eval", "eval"},
		{"https://User:pass@Evil.Example.com:8443/path?q=1#frag", "https://evil.example.com:8443"},
		{"wss://Socket.Example.com/ws", "wss://socket.example.com"},
		{"data:text/html,<script>alert(1)</script>", "data:"},
		{"blob:https://app.example/uuid-1234", "blob:"},
		{"filesystem:https://app.example/temporary/x", "filesystem:"},
		{"about:blank", "about:blank"},
		{"inline\nevil=1", "inlineevil=1"},
	}
	for _, tc := range cases {
		got := normalizeCSPBlocked(tc.in)
		if got != tc.want {
			t.Errorf("normalizeCSPBlocked(%q) = %q; want %q", tc.in, got, tc.want)
		}
		if strings.ContainsAny(got, ",\n\r;|") {
			t.Errorf("normalized value %q contains Detail delimiters/control chars", got)
		}
	}
}

// TestNormalizeCSPDirective 指令名归一化：violated-directive 的策略源列表被
// 截成指令名，大小写/非法字符收敛。
func TestNormalizeCSPDirective(t *testing.T) {
	cases := []struct{ in, want string }{
		{"script-src 'self'", "script-src"},
		{"script-src-elem", "script-src-elem"},
		{"Style-Src-Attr", "style-src-attr"},
		{"", "unknown"},
		{"'self'", "self"}, // 防御性：无指令名时保留可辨识 token
	}
	for _, tc := range cases {
		if got := normalizeCSPDirective(tc.in); got != tc.want {
			t.Errorf("normalizeCSPDirective(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}
