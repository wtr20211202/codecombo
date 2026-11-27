package system

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// 浏览器侧诊断报告端点（P-20261126-2 P-2b）测试面：
//   - 入站契约：Content-Type 必须 JSON / 256KB 上限（413）/ typed 白名单
//     （未知字段拒收 / 非法枚举拒收）/ 超 50 条截最新 50 不拒收（A2）/
//     字段界截断 / generatedAt 规范化；
//   - 会话窗：cookie 属性族（HttpOnly/Strict/Path 最小暴露/Max-Age=300/
//     128-bit id）、TTL 5min、单 session ≤4 份滚动、全局 ≤8 份、并发竞态；
//   - 导出关联：clientReport 参数不在场 → manifest 无 browser.json 条目
//     （A3 回归）；在场无 cookie → absent+reason（fail-closed，zip 无该文件）；
//     在场有 cookie → derived 条目入 zip 且逐值脱敏（mask+路径归一）；
//   - 审计只记 size/entries 元数据，报告内容不入账。

// clientReportTestRouter 与 diagTestRouter 同款装配 + POST 路由 + 会话窗复位
func clientReportTestRouter(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, dir := diagTestRouter(t)
	r.POST("/api/system/diagnostics/client-report", PostDiagnosticsClientReport)
	resetClientReportStore()
	t.Cleanup(resetClientReportStore)
	return r, dir
}

func postClientReportRaw(t *testing.T, r *gin.Engine, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/system/diagnostics/client-report", strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func postClientReportJSON(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	return postClientReportRaw(t, r, "application/json", body)
}

// diagSessionCookieOf 从响应取 sc_diag_session cookie（无则测试失败）
func diagSessionCookieOf(t *testing.T, w *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, ck := range w.Result().Cookies() {
		if ck.Name == DiagSessionCookieName {
			return ck
		}
	}
	t.Fatalf("response missing %s cookie", DiagSessionCookieName)
	return nil
}

// unzipDiag 诊断 zip → {name: content}（manifest 恒在）
func unzipDiag(t *testing.T, raw []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = string(b)
	}
	return files
}

// diagManifestEntries 解析 manifest.json 的 entries
func diagManifestEntries(t *testing.T, manifestJSON string) []struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Reason string `json:"reason"`
} {
	t.Helper()
	var m struct {
		Entries []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"entries"`
	}
	if err := json.Unmarshal([]byte(manifestJSON), &m); err != nil {
		t.Fatalf("manifest.json: %v", err)
	}
	return m.Entries
}

// releaseDiagGate 测试内多次导出须复位进程级单飞/冷却闸门
func releaseDiagGate() {
	diagExportState.mu.Lock()
	diagExportState.running = false
	diagExportState.lastRun = time.Time{}
	diagExportState.mu.Unlock()
}

func validClientReportJSON(n int) string {
	var b strings.Builder
	b.WriteString(`{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"Asia/Shanghai","tzOffsetMinutes":-480,"visibility":"visible"},"entries":[`)
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"kind":"request","source":"xhr","ts":"2026-11-27T08:59:%02dZ","errorClass":"timeout","method":"GET","path":"/api/projects/:id/status","status":0,"route":"/project","message":"request timeout (#%d)"}`, i%60, i)
	}
	b.WriteString(`],"ws":[{"ts":"2026-11-27T08:58:00Z","path":"/ws/terminal/:id","code":1006,"closeKind":"abnormal","reason":"abnormal closure","wasClean":false,"attempt":2,"intentional":false}]}`)
	return b.String()
}

// 1. Content-Type 必须 JSON：非 JSON → 415；缺头 → 415
func TestClientReportContentTypeEnforced(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	if w := postClientReportRaw(t, r, "text/plain", validClientReportJSON(1)); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain = %d, want 415", w.Code)
	}
	if w := postClientReportRaw(t, r, "", validClientReportJSON(1)); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("missing content-type = %d, want 415", w.Code)
	}
	// JSON + charset 后缀合法
	if w := postClientReportRaw(t, r, "application/json; charset=utf-8", validClientReportJSON(1)); w.Code != http.StatusOK {
		t.Fatalf("json+charset = %d body=%s", w.Code, w.Body.String())
	}
}

// 2. body 上限 256KB：超限 413（payloadTooLarge）；边界内正常
func TestClientReportBodyCap(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	// 300KB 文本（合法 JSON 之外先直接测体量闸——非 JSON 会先 415，所以这里
	// 用合法 JSON 撑大：大消息字段）
	big := `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":"visible"},"entries":[{"kind":"request","source":"xhr","ts":"2026-11-27T08:59:00Z","errorClass":"network","message":"` + strings.Repeat("x", 300*1024) + `"}],"ws":[]}`
	if w := postClientReportJSON(t, r, big); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("300KB payload = %d, want 413 body=%s", w.Code, w.Body.String())
	}
	// 边界内（远小于 256KB）通过
	if w := postClientReportJSON(t, r, validClientReportJSON(3)); w.Code != http.StatusOK {
		t.Fatalf("small payload = %d body=%s", w.Code, w.Body.String())
	}
}

// 3. typed 白名单：未知字段拒收（400 带字段名）；非法枚举拒收；schemaVersion 错误拒收
func TestClientReportWhitelistRejects(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	cases := []struct {
		name string
		body string
		want string // 400 msg 必含片段
	}{
		{"unknown top field", `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[],"ws":[],"resource":[]}`, "resource"},
		{"client-supplied host", `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":"","userAgent":"evil"},"entries":[],"ws":[]}`, "userAgent"},
		{"bad kind", `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[{"kind":"haxx","source":"xhr","ts":"2026-11-27T08:59:00Z","errorClass":"network","message":"m"}],"ws":[]}`, "kind invalid"},
		{"bad errorClass", `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[{"kind":"request","source":"xhr","ts":"2026-11-27T08:59:00Z","errorClass":"cert","message":"m"}],"ws":[]}`, "errorClass invalid"},
		{"bad closeKind", `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[],"ws":[{"ts":"2026-11-27T08:58:00Z","path":"/ws/x","code":1006,"closeKind":"mystery","reason":"","wasClean":false,"attempt":0,"intentional":false}]}`, "closeKind invalid"},
		{"wrong schemaVersion", `{"schemaVersion":99,"generatedAt":"","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[],"ws":[]}`, "schemaVersion"},
	}
	for _, tc := range cases {
		w := postClientReportJSON(t, r, tc.body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400 body=%s", tc.name, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("%s: body %s must mention %q", tc.name, w.Body.String(), tc.want)
		}
	}
}

// 4. entries>50 截最新 50 不拒收（A2）；字段界截断；canceled/silent 形状保真
func TestClientReportCapsToLatest50(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	w := postClientReportJSON(t, r, validClientReportJSON(60))
	if w.Code != http.StatusOK {
		t.Fatalf("60 entries = %d body=%s", w.Code, w.Body.String())
	}
	ck := diagSessionCookieOf(t, w)
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(ck.Value) {
		t.Fatalf("session id must be 128-bit hex, got %q", ck.Value)
	}

	// 关联导出：browser.json 恰 50 条且为最新 50（客户端序=最新优先，#59 是最新）
	releaseDiagGate()
	req := httptest.NewRequest("GET", "/api/system/diagnostics/export?days=1&clientReport=1", nil)
	req.AddCookie(ck)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	if w2.Code != http.StatusOK {
		t.Fatalf("export = %d body=%s", w2.Code, w2.Body.String())
	}
	files := unzipDiag(t, w2.Body.Bytes())
	raw, ok := files["state/browser.json"]
	if !ok {
		t.Fatalf("state/browser.json missing from zip (have %v)", keysOf(files))
	}
	var got struct {
		SchemaVersion int    `json:"schemaVersion"`
		GeneratedAt   string `json:"generatedAt"`
		Page          struct {
			Timezone           string `json:"timezone"`
			TzOffsetMinutes    int    `json:"tzOffsetMinutes"`
			Visibility         string `json:"visibility"`
			UserAgent          string `json:"userAgent"`
			Protocol           string `json:"protocol"`
			ServerObservedHost string `json:"serverObservedHost"`
		} `json:"page"`
		Entries []struct {
			Kind    string `json:"kind"`
			Message string `json:"message"`
			Path    string `json:"path"`
			Route   string `json:"route"`
		} `json:"entries"`
		WS       []map[string]any `json:"ws"`
		Resource []map[string]any `json:"resource"`
	}
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("browser.json: %v (%s)", err, raw)
	}
	if len(got.Entries) != 50 {
		t.Fatalf("entries = %d, want 50 (server cap)", len(got.Entries))
	}
	// 客户端 unshift 序=数组头即最新（夹具 #0..#59 顺序生成，#0 即最新）
	if !strings.Contains(got.Entries[0].Message, "(#0)") {
		t.Fatalf("first entry must be the LATEST (array head), got %q", got.Entries[0].Message)
	}
	if len(got.Entries) > 0 && !strings.Contains(got.Entries[49].Message, "(#49)") {
		t.Fatalf("50th entry must be the tail of the kept window, got %q", got.Entries[49].Message)
	}
	// 白名单负向：resource/UA/protocol 不出现；host 只由服务端回填
	if len(got.Resource) != 0 || got.Page.UserAgent != "" || got.Page.Protocol != "" {
		t.Fatalf("server-scope trim leaked resource/UA/protocol: %+v", got.Page)
	}
	if got.Page.ServerObservedHost == "" {
		t.Fatal("serverObservedHost must be backfilled from the request Host")
	}
	if len(got.WS) != 1 {
		t.Fatalf("ws entries = %d, want 1", len(got.WS))
	}
	// entry 级 path/route 保留（「哪条请求失败」的核心证据；评审 A1 界定）
	if got.Entries[0].Path != "/api/projects/:id/status" || got.Entries[0].Route != "/project" {
		t.Fatalf("entry path/route must survive: %+v", got.Entries[0])
	}

	// manifest 条目：derived + reason
	found := false
	for _, e := range diagManifestEntries(t, files["manifest.json"]) {
		if e.Name == "state/browser.json" {
			found = true
			if e.Status != "derived" || e.Reason == "" {
				t.Fatalf("browser.json manifest entry = %+v", e)
			}
		}
	}
	if !found {
		t.Fatal("manifest must list state/browser.json when correlated")
	}
}

// 5. cookie 属性族：HttpOnly + SameSite=Strict + Path 最小暴露 + Max-Age=300
func TestClientReportCookieAttrs(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	w := postClientReportJSON(t, r, validClientReportJSON(1))
	ck := diagSessionCookieOf(t, w)
	if !ck.HttpOnly {
		t.Fatal("cookie must be HttpOnly")
	}
	if ck.SameSite != http.SameSiteStrictMode {
		t.Fatalf("SameSite = %v, want Strict", ck.SameSite)
	}
	if ck.Path != "/api/system/diagnostics" {
		t.Fatalf("Path = %q, want /api/system/diagnostics (minimal exposure, A4)", ck.Path)
	}
	if ck.MaxAge != 300 {
		t.Fatalf("Max-Age = %d, want 300", ck.MaxAge)
	}
	if ck.Secure {
		t.Fatal("plain-HTTP test request must NOT set Secure (browser would drop it)")
	}
}

// 6. generatedAt 映射：合法 RFC3339 保留；不可解析回退服务端接收时刻
func TestClientReportGeneratedAtMapping(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	body := `{"schemaVersion":1,"generatedAt":"not-a-timestamp","page":{"timezone":"","tzOffsetMinutes":0,"visibility":""},"entries":[{"kind":"script","source":"window","ts":"garbage","errorClass":"unknown","message":"boom"}],"ws":[]}`
	w := postClientReportJSON(t, r, body)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	ck := diagSessionCookieOf(t, w)
	releaseDiagGate()
	req := httptest.NewRequest("GET", "/api/system/diagnostics/export?days=1&clientReport=1", nil)
	req.AddCookie(ck)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	files := unzipDiag(t, w2.Body.Bytes())
	var got struct {
		GeneratedAt string `json:"generatedAt"`
		Entries     []struct {
			Ts string `json:"ts"`
		} `json:"entries"`
	}
	if err := json.Unmarshal([]byte(files["state/browser.json"]), &got); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339, got.GeneratedAt); err != nil {
		t.Fatalf("generatedAt must be canonical RFC3339 (server fallback), got %q", got.GeneratedAt)
	}
	if got.Entries[0].Ts != "" {
		t.Fatalf("unparsable entry ts must fall back to empty, got %q", got.Entries[0].Ts)
	}
}

// 7. 导出关联正道：POST → cookie → export clientReport=1 → browser.json 过 Redactor
// （token 遮蔽 + 路径归一）；审计只记元数据不含内容
func TestClientReportExportCorrelationRedacts(t *testing.T) {
	r, dir := clientReportTestRouter(t)
	payload := `{"schemaVersion":1,"generatedAt":"2026-11-27T09:00:00Z","page":{"timezone":"X","tzOffsetMinutes":0,"visibility":"visible"},"entries":[{"kind":"request","source":"xhr","ts":"2026-11-27T08:59:00Z","errorClass":"network","path":"/api/share/abcdefghij123456/status","route":"/share","message":"failed ` + filepath.ToSlash(dir) + `/logs/token=s3cret_value leaks /s/abcdefghij123456"}],"ws":[]}`
	w := postClientReportJSON(t, r, payload)
	if w.Code != http.StatusOK {
		t.Fatalf("POST = %d body=%s", w.Code, w.Body.String())
	}
	ck := diagSessionCookieOf(t, w)

	releaseDiagGate()
	req := httptest.NewRequest("GET", "/api/system/diagnostics/export?days=1&clientReport=1", nil)
	req.AddCookie(ck)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	files := unzipDiag(t, w2.Body.Bytes())
	browser := files["state/browser.json"]
	if browser == "" {
		t.Fatal("browser.json empty")
	}
	// 逐值脱敏：token 形态遮蔽 / share token 摘要化 / 路径归一
	if strings.Contains(browser, "s3cret_value") {
		t.Fatalf("raw token leaked into browser.json: %s", browser)
	}
	if !strings.Contains(browser, "$DATA_DIR") {
		t.Fatalf("data dir must be normalized to $DATA_DIR: %s", browser)
	}
	if strings.Contains(browser, "/s/abcdefghij123456") {
		t.Fatalf("share token must be summarised: %s", browser)
	}
	// JSON 结构未被整段文本 mask 糊掉（仍是合法对象）
	var probe map[string]any
	if err := json.Unmarshal([]byte(browser), &probe); err != nil {
		t.Fatalf("browser.json is not valid JSON after masking: %v", err)
	}

	// 审计：diagnostics.export 的 browser 标记 + client_report 只记 size/entries
	events := auditEventsForTesting(t)
	sawExport := false
	sawPost := false
	for _, e := range events {
		if e.Action == store.AuditDiagnosticsExport {
			sawExport = true
			if !strings.Contains(e.Detail, "browser=attached") {
				t.Fatalf("export audit detail must mark browser=attached: %q", e.Detail)
			}
		}
		if e.Action == store.AuditDiagnosticsClientReport {
			sawPost = true
			if !strings.Contains(e.Detail, "bytes=") || !strings.Contains(e.Detail, "entries=") {
				t.Fatalf("client-report audit must record size/entries: %q", e.Detail)
			}
			if strings.Contains(e.Detail, "s3cret_value") || strings.Contains(e.Detail, "leaks") {
				t.Fatalf("client-report audit must never carry report content: %q", e.Detail)
			}
		}
	}
	if !sawExport || !sawPost {
		t.Fatalf("missing audits: export=%t post=%t", sawExport, sawPost)
	}
}

// 8. A3 回归：clientReport 参数不在场 → manifest 完全没有 browser.json 条目
func TestClientReportParamAbsentNoManifestEntry(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	w := postClientReportJSON(t, r, validClientReportJSON(1))
	ck := diagSessionCookieOf(t, w)
	releaseDiagGate()
	req := httptest.NewRequest("GET", "/api/system/diagnostics/export?days=1", nil)
	req.AddCookie(ck) // cookie 在场但参数不在场：仍不得产生条目
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	files := unzipDiag(t, w2.Body.Bytes())
	for _, e := range diagManifestEntries(t, files["manifest.json"]) {
		if e.Name == "state/browser.json" {
			t.Fatalf("param absent must NOT produce a browser.json manifest entry (A3), got %+v", e)
		}
	}
	if _, ok := files["state/browser.json"]; ok {
		t.Fatal("zip must not contain browser.json when param absent")
	}
}

// 9. 参数在场无 cookie → absent+reason（fail-closed，导出照常 200）
func TestClientReportParamPresentNoCookieAbsentEntry(t *testing.T) {
	r, _ := clientReportTestRouter(t)
	releaseDiagGate()
	w := doDiag(t, r, "?days=1&clientReport=1")
	if w.Code != http.StatusOK {
		t.Fatalf("export without cookie must still be 200, got %d", w.Code)
	}
	files := unzipDiag(t, w.Body.Bytes())
	hit := false
	for _, e := range diagManifestEntries(t, files["manifest.json"]) {
		if e.Name == "state/browser.json" {
			hit = true
			if e.Status != "absent" || e.Reason == "" {
				t.Fatalf("browser.json entry = %+v, want absent with reason", e)
			}
		}
	}
	if !hit {
		t.Fatal("param present requires an absent manifest entry")
	}
	if _, ok := files["state/browser.json"]; ok {
		t.Fatal("absent entry must not be packed into the zip")
	}
}

// 10. TTL 5 分钟过期：窗口外报告关联退化为 absent（时间注入直测 store）
func TestClientReportSessionTTL(t *testing.T) {
	resetClientReportStore()
	var rep ServerClientReport
	if err := json.Unmarshal([]byte(validClientReportJSON(1)), &rep); err != nil {
		t.Fatal(err)
	}
	if err := rep.normalize(time.Now()); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-diagClientReportTTL - time.Minute)
	storeClientReport("sid-expired", rep, old)
	if got := lookupClientReport("sid-expired", time.Now()); got != nil {
		t.Fatal("expired session must not be returned")
	}
	if got := lookupClientReport("sid-fresh", time.Now().Add(diagClientReportTTL)); got != nil {
		t.Fatal("fresh lookup must only match its own session")
	}
}

// 11. 封顶：单 session ≤4 份滚动 + 全局 ≤8 份（B3 边界）
func TestClientReportStoreCaps(t *testing.T) {
	resetClientReportStore()
	now := time.Now()
	mk := func(i int) *ServerClientReport {
		var rep ServerClientReport
		if err := json.Unmarshal([]byte(validClientReportJSON(1)), &rep); err != nil {
			t.Fatal(err)
		}
		rep.Entries[0].Message = fmt.Sprintf("m-%d", i)
		if err := rep.normalize(now); err != nil {
			t.Fatal(err)
		}
		return &rep
	}
	// 同 session 6 份 → 留最新 4 份
	for i := 0; i < 6; i++ {
		storeClientReport("s1", *mk(i), now.Add(time.Duration(i)*time.Second))
	}
	got := lookupClientReport("s1", now.Add(time.Minute))
	if got == nil || got.Entries[0].Message != "m-5" {
		t.Fatalf("per-session rolling must keep the latest, got %+v", got)
	}
	// 换 session 再压 6 份 → 全局 8 份封顶（6+4=10 → 淘汰最旧 2 份，全部是 s1 的）
	for i := 10; i < 16; i++ {
		storeClientReport("s2", *mk(i), now.Add(time.Duration(i)*time.Second))
	}
	diagClientReportStore.mu.Lock()
	total := len(diagClientReportStore.ring)
	s1 := 0
	s2 := 0
	for _, rec := range diagClientReportStore.ring {
		switch rec.sessionID {
		case "s1":
			s1++
		case "s2":
			s2++
		}
	}
	diagClientReportStore.mu.Unlock()
	if total != diagClientReportMaxTotal {
		t.Fatalf("global ring = %d, want %d", total, diagClientReportMaxTotal)
	}
	// s2 的第 5 份起触发单 session 封顶（滚动淘汰自己最旧的），故 s2 停在 4；
	// 全局环 8 = s1(4)+s2(4)，全局淘汰在本形态下未被触达
	if s2 != diagClientReportMaxPerSession {
		t.Fatalf("s2 = %d, want %d (per-session cap rolls its own oldest)", s2, diagClientReportMaxPerSession)
	}
	if s1 != diagClientReportMaxPerSession {
		t.Fatalf("s1 survivors = %d, want %d", s1, diagClientReportMaxPerSession)
	}
}

// 12. 并发竞态（-race）：同 session 并发 POST 不丢份、不超封顶
func TestClientReportConcurrentPosts(t *testing.T) {
	resetClientReportStore()
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var rep ServerClientReport
			if err := json.Unmarshal([]byte(validClientReportJSON(1)), &rep); err != nil {
				t.Error(err)
				return
			}
			rep.Entries[0].Message = fmt.Sprintf("c-%d", i)
			if err := rep.normalize(now); err != nil {
				t.Error(err)
				return
			}
			storeClientReport("sid-race", rep, now)
		}(i)
	}
	wg.Wait()
	diagClientReportStore.mu.Lock()
	total := len(diagClientReportStore.ring)
	diagClientReportStore.mu.Unlock()
	if total > diagClientReportMaxPerSession {
		t.Fatalf("concurrent same-session posts left %d reports, cap is %d", total, diagClientReportMaxPerSession)
	}
	if total == 0 {
		t.Fatal("concurrent posts must not lose every report")
	}
}

// ── 鉴权四层（router.go api 组同构装配：LockCSRF → Lock → TokenAuth → AgentGuard）──
// 路由注册在组内的证据由 archguard 路由快照钉住；本表钉「该组四件套对本端点的
// 逐层行为」：锁关闭放行 / 无凭据 423 / 跨源写 403（CSRF）/ 同源+有效锁令牌 200。

// clientReportAuthRouter 四件套同构装配（顺序与 router.go:145 一致）
func clientReportAuthRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.Use(middleware.LockCSRF(), middleware.LockMiddlewareWithCookie(), middleware.TokenAuthMiddleware(), middleware.AgentGuard())
	r.POST("/api/system/diagnostics/client-report", PostDiagnosticsClientReport)
	resetClientReportStore()
	t.Cleanup(resetClientReportStore)
	return r
}

func postAuthed(t *testing.T, r *gin.Engine, origin, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/system/diagnostics/client-report", strings.NewReader(validClientReportJSON(1)))
	req.Host = "127.0.0.1:9999"
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if token != "" {
		req.Header.Set(middleware.LockHeaderName, token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestClientReportAuthFourLayers(t *testing.T) {
	r := clientReportAuthRouter(t)

	// ① 锁未配置：fail-closed 423（initial password setup required——路由保护
	// 统一姿态：锁关闭〔已配置〕全开放、未配置 fail-closed）
	if w := postAuthed(t, r, "http://127.0.0.1:9999", ""); w.Code != http.StatusLocked {
		t.Fatalf("lock unconfigured: status = %d body=%s, want 423", w.Code, w.Body.String())
	}

	// ② 已配置但关闭：同源 POST 放行（锁关闭全开放——CSRF 仍按源校验；
	// SetupPassword 默认即启用，须显式关回再验这条）
	if err := store.Get().Lock.SetupPassword("correct horse"); err != nil {
		t.Fatalf("setup lock: %v", err)
	}
	off := store.Get().Lock.GetConfig()
	off.Enabled = false
	if err := store.Get().Lock.SaveConfig(off); err != nil {
		t.Fatalf("save lock config: %v", err)
	}
	if w := postAuthed(t, r, "http://127.0.0.1:9999", ""); w.Code != http.StatusOK {
		t.Fatalf("lock disabled: status = %d body=%s", w.Code, w.Body.String())
	}

	// ③ 开锁后无凭据 → 423 Locked
	cfg := store.Get().Lock.GetConfig()
	cfg.Enabled = true
	if err := store.Get().Lock.SaveConfig(cfg); err != nil {
		t.Fatalf("save lock config: %v", err)
	}
	if w := postAuthed(t, r, "http://127.0.0.1:9999", ""); w.Code != http.StatusLocked {
		t.Fatalf("no credential: status = %d, want 423", w.Code)
	}

	// ④ 有效锁令牌 + 跨源写 → 403（LockCSRF 拒；同主机异端口 same-site 同拒）
	token, err := store.Get().Lock.IssueToken()
	if err != nil {
		t.Fatal(err)
	}
	if w := postAuthed(t, r, "http://evil.example", token); w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write: status = %d, want 403", w.Code)
	}
	if w := postAuthed(t, r, "http://127.0.0.1:5173", token); w.Code != http.StatusForbidden {
		t.Fatalf("same-host different port: status = %d, want 403", w.Code)
	}

	// ⑤ 同源 + 有效锁令牌 → 200 + 会话 cookie（四层全过）
	w := postAuthed(t, r, "http://127.0.0.1:9999", token)
	if w.Code != http.StatusOK {
		t.Fatalf("same-origin authed: status = %d body=%s", w.Code, w.Body.String())
	}
	diagSessionCookieOf(t, w)
}
