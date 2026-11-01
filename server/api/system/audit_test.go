package system

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 解锁审计入账（P-20261002-13） ──
// 覆盖：成功/失败两态都入账、限流命中入账（denied）、密码明文绝不入账、
// 连发失败 ≥3 触发 warning 通知（只发一次）

// auditEventsForTesting 读回当前审计全量
func auditEventsForTesting(t *testing.T) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	return events
}

func TestUnlockAudit_SuccessRecorded(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	body, _ := json.Marshal(map[string]string{"password": testPwdAdmin})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "9.9.9.9:1234"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	events := auditEventsForTesting(t)
	if len(events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(events))
	}
	e := events[0]
	if e.Action != store.AuditUnlock || e.Result != store.AuditResultSuccess {
		t.Errorf("unexpected event: %+v", e)
	}
	if e.IP != "9.9.9.9" {
		t.Errorf("expected ip 9.9.9.9, got %q", e.IP)
	}
	// 内容不入账：明文密码与响应 token 都不得出现在条目里
	raw := fmt.Sprintf("%+v", e)
	if strings.Contains(raw, testPwdAdmin) {
		t.Error("password leaked into audit entry")
	}
}

func TestUnlockAudit_FailureRecorded(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 独特的错密码值（区别于 Detail 固定文案「wrong password」，泄漏断言才可信）
	badPwd := "gu" + "ess999x"
	body, _ := json.Marshal(map[string]string{"password": badPwd})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "9.9.9.9:1234"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatalf("expected 401, got %d", w.Code)
	}

	events := auditEventsForTesting(t)
	if len(events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(events))
	}
	if events[0].Result != store.AuditResultFailure {
		t.Errorf("expected failure, got %q", events[0].Result)
	}
	if strings.Contains(fmt.Sprintf("%+v", events[0]), badPwd) {
		t.Error("wrong password value leaked into audit entry")
	}
}

func TestUnlockAudit_RateLimitedRecordedAsDenied(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 打满限流窗口（10 次失败），第 11 次命中限流
	for i := 0; i < 10; i++ {
		body, _ := json.Marshal(map[string]string{"password": testPwdWrong})
		req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, w.Code)
		}
	}
	body, _ := json.Marshal(map[string]string{"password": testPwdAdmin})
	req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 429 {
		t.Fatalf("expected 429, got %d", w.Code)
	}

	events, total, _ := store.Get().Audit.List(0, 0)
	if total != 11 {
		t.Fatalf("expected 11 events (10 failure + 1 denied), got %d", total)
	}
	denied := events[0] // 倒序，最新在前
	if denied.Result != store.AuditResultDenied {
		t.Errorf("expected denied, got %q", denied.Result)
	}
}

func TestUnlockAudit_BurstTriggersSingleWarningNotification(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 连错 5 次：第 3 次触发一条 warning 通知，后续只进审计不再重复通知
	for i := 0; i < 5; i++ {
		body, _ := json.Marshal(map[string]string{"password": testPwdWrong})
		req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, w.Code)
		}
	}

	notifs := store.Get().Notification.List(0)
	warnings := 0
	for _, n := range notifs {
		if n.TitleKey == "audit.notify.unlockFails.title" {
			warnings++
			if n.Type != "warning" {
				t.Errorf("expected warning type, got %q", n.Type)
			}
			if n.MsgParams["ip"] == "" {
				t.Errorf("expected ip msg param, got %+v", n.MsgParams)
			}
		}
	}
	if warnings != 1 {
		t.Fatalf("expected exactly 1 warning notification, got %d", warnings)
	}
}

func TestListAudit_PaginationParams(t *testing.T) {
	r, _ := setupLockHandlerRouter(t)

	// 造 3 条
	for i := 0; i < 3; i++ {
		body, _ := json.Marshal(map[string]string{"password": testPwdWrong})
		req := httptest.NewRequest("POST", "/api/lock/unlock", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
	}

	rr := gin.New()
	rr.GET("/api/audit", ListAudit)

	req := httptest.NewRequest("GET", "/api/audit?limit=2&offset=0", nil)
	w := httptest.NewRecorder()
	rr.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data  []store.AuditEvent `json:"data"`
		Total int                `json:"total"`
		// 审计写失败计数（P-20261003-205）：顶面随列表同源返回，真实落盘
		// 成功的用例恒 0/空串
		AuditWriteFails    int64  `json:"auditWriteFails"`
		AuditLastWriteFail string `json:"auditLastWriteFail"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Data) != 2 || resp.Total != 3 {
		t.Fatalf("expected page of 2 / total 3, got len=%d total=%d", len(resp.Data), resp.Total)
	}
	if resp.AuditWriteFails != 0 || resp.AuditLastWriteFail != "" {
		t.Errorf("successful writes must report zero failures, got count=%d last=%q",
			resp.AuditWriteFails, resp.AuditLastWriteFail)
	}
	// 倒序：首页首条是最新失败
	if resp.Data[0].Time.Before(resp.Data[1].Time) {
		t.Error("expected descending order")
	}
}

func TestParseAuditPage_Clamps(t *testing.T) {
	limit, offset := parseAuditPage("100000", "-5")
	if limit != auditMaxLimit {
		t.Errorf("expected limit clamp to %d, got %d", auditMaxLimit, limit)
	}
	if offset != 0 {
		t.Errorf("expected negative offset fallback 0, got %d", offset)
	}
	limit, offset = parseAuditPage("junk", "junk")
	if limit != auditDefaultLimit || offset != 0 {
		t.Errorf("expected defaults (100,0), got (%d,%d)", limit, offset)
	}
}

// ── 键集游标分页（P-20261003-223） ──
// 覆盖：offset 旧形态响应不变（无 nextCursor 键）、满页附 nextCursor、
// cursor 续翻与 offset 全序一致（不重不漏）、非法 cursor 400、cursor 模式
// limit 钳制照常生效、页未满无 nextCursor

type auditListResponse struct {
	Data  []store.AuditEvent `json:"data"`
	Total int                `json:"total"`
	// nextCursor 只在满页出现（增量扩展，旧客户端忽略）
	NextCursor string `json:"nextCursor"`
}

func TestListAudit_CursorPagination(t *testing.T) {
	r := setupAuditExportRouter(t)

	now := time.Now()
	for i := 0; i < 5; i++ {
		store.Get().Audit.Append(store.AuditEvent{
			Time:   now.Add(-time.Duration(i) * time.Minute),
			Action: store.AuditUnlock, Result: store.AuditResultSuccess,
		})
	}

	get := func(t *testing.T, query string) auditListResponse {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/audit"+query, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("GET %s: expected 200, got %d body=%s", query, w.Code, w.Body.String())
		}
		var resp auditListResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return resp
	}

	// 首页走旧 offset 参数：数据形状不变，满页附 nextCursor（增量扩展）
	page1 := get(t, "?limit=2&offset=0")
	if len(page1.Data) != 2 || page1.Total != 5 {
		t.Fatalf("page1: len=%d total=%d, want 2/5", len(page1.Data), page1.Total)
	}
	if page1.NextCursor == "" {
		t.Fatal("full page must carry nextCursor")
	}

	// 短页（offset 越界空页）不带 nextCursor 键
	empty := get(t, "?limit=2&offset=999")
	if len(empty.Data) != 0 {
		t.Fatalf("offset overflow: len=%d", len(empty.Data))
	}
	if empty.NextCursor != "" {
		t.Fatalf("non-full page must not carry nextCursor, got %q", empty.NextCursor)
	}

	// 键集续翻：从 nextCursor 走到末页，跨页拼接与 offset 全序完全一致
	var walked []store.AuditEvent
	cursor := page1.NextCursor
	walked = append(walked, page1.Data...)
	pages := 1
	for cursor != "" {
		resp := get(t, "?limit=2&cursor="+cursor)
		walked = append(walked, resp.Data...)
		cursor = resp.NextCursor
		pages++
		if pages > 10 {
			t.Fatal("cursor walk did not terminate")
		}
	}
	all, total, _ := store.Get().Audit.List(0, 0)
	if len(walked) != total {
		t.Fatalf("walked %d events, total=%d (missed or duplicated)", len(walked), total)
	}
	seen := map[string]bool{}
	for i, e := range walked {
		if seen[e.ID] {
			t.Errorf("duplicate id %q at position %d", e.ID, i)
		}
		seen[e.ID] = true
		if e.ID != all[i].ID {
			t.Errorf("position %d: got %q, want %q (cursor order must match List)", i, e.ID, all[i].ID)
		}
	}

	// cursor 模式 limit 钳制照常生效（500 封顶不破）
	limited := get(t, "?limit=100000&cursor="+page1.NextCursor)
	if len(limited.Data) > auditMaxLimit {
		t.Errorf("cursor mode limit clamp broken: %d rows", len(limited.Data))
	}
}

func TestListAudit_InvalidCursorRejected(t *testing.T) {
	r := setupAuditExportRouter(t)

	for _, bad := range []string{"garbage", "###", "aGVsbG8"} /* 合法 base64 但无分隔符 */ {
		req := httptest.NewRequest("GET", "/api/audit?limit=2&cursor="+bad, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Errorf("cursor %q: expected 400, got %d body=%s", bad, w.Code, w.Body.String())
		}
	}

	// 游标编解码回环：encodeAuditCursor 的产物必可解码回同一锚点
	e := store.AuditEvent{ID: "test-id-1234", Time: time.Date(2026, 10, 7, 12, 30, 5, 123456789, time.UTC)}
	ts, id, err := decodeAuditCursor(encodeAuditCursor(e))
	if err != nil || id != e.ID || !ts.Equal(e.Time) {
		t.Errorf("cursor round-trip broken: ts=%v id=%q err=%v", ts, id, err)
	}
}

// ── 审计 CSV 导出（P-20261003-66） ──
// 覆盖：CSV 转义（逗号/引号字段按 RFC 4180 加引号）、公式注入防护
//（=+/-@ 前缀单引号）、窗口裁剪（days 之外不出现）、分页循环拉全量
//（>500 条跨过单页钳制）、days 参数收敛、导出动作同路入账

// setupAuditExportRouter 装配独立临时目录 store + 审计路由（不依赖 lock 用例装配）
func setupAuditExportRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/audit", ListAudit)
	r.GET("/api/audit/export", ExportAudit)
	return r
}

// readExportCSV 请求导出并按 RFC 4180 解析（剥 BOM），返回数据行
func readExportCSV(t *testing.T, r *gin.Engine, query string) [][]string {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/audit/export"+query, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("export %q: expected 200, got %d body=%s", query, w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("expected text/csv content type, got %q", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Errorf("expected attachment disposition, got %q", cd)
	}
	body := strings.TrimPrefix(w.Body.String(), "\xEF\xBB\xBF")
	records, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("csv parse: %v", err)
	}
	return records
}

func TestExportAudit_CSVEscapingAndInjectionGuard(t *testing.T) {
	r := setupAuditExportRouter(t)

	now := time.Now()
	seed := []struct {
		action string
		detail string
	}{
		{store.AuditUnlock, "plain detail"},
		{store.AuditCredSave, `user, "quoted"`},
		{store.AuditHostCreate, `=HYPERLINK("http://evil","pwn")`},
		{store.AuditShareCreate, "-1+cmd|'/C calc'!A0"},
	}
	for _, s := range seed {
		store.Get().Audit.Append(store.AuditEvent{
			Time: now, Action: s.action, Result: store.AuditResultSuccess, IP: "9.9.9.9", Detail: s.detail,
		})
	}

	records := readExportCSV(t, r, "")
	if len(records) != len(seed)+1 { // 数据行 + 表头
		t.Fatalf("expected %d records, got %d: %q", len(seed)+1, len(records), records)
	}
	if strings.Join(records[0], ",") != "time,action,result,ip,detail" {
		t.Errorf("unexpected header: %v", records[0])
	}
	details := map[string]bool{}
	for _, rec := range records[1:] {
		if len(rec) != 5 {
			t.Fatalf("expected 5 fields, got %v", rec)
		}
		details[rec[4]] = true
	}
	if !details["plain detail"] {
		t.Errorf("plain detail lost: %v", details)
	}
	if !details[`user, "quoted"`] {
		t.Errorf("comma/quote detail failed RFC 4180 round-trip: %v", details)
	}
	if !details[`'=HYPERLINK("http://evil","pwn")`] {
		t.Errorf("formula-prefix detail missing single-quote guard: %v", details)
	}
	if !details[`'-1+cmd|'/C calc'!A0`] {
		t.Errorf("hyphen-prefix detail missing single-quote guard: %v", details)
	}
}

func TestExportAudit_PaginationLoopPullsFullWindow(t *testing.T) {
	r := setupAuditExportRouter(t)

	now := time.Now()
	// 45 天前：任何窗口都取不到（保留策略迟早清账，未清前导出也不出现）
	store.Get().Audit.Append(store.AuditEvent{
		Time: now.Add(-45 * 24 * time.Hour), Action: store.AuditUnlock, Result: store.AuditResultFailure,
	})
	// 10 天前：30 天窗口命中
	store.Get().Audit.Append(store.AuditEvent{
		Time: now.Add(-10 * 24 * time.Hour), Action: store.AuditHostCreate, Result: store.AuditResultSuccess,
	})
	// 501 条新鲜事件：跨过单页 500 的钳制，验证分页循环拉全量（单次 List(0)
	// 只回默认 100 条——提案修正注记的回归点）。只导出一次：导出自身入账
	//（Time=now 落在窗口内）会让后续导出的行数随之漂移
	for i := 0; i < 501; i++ {
		store.Get().Audit.Append(store.AuditEvent{
			Time: now, Action: store.AuditTokenCreate, Result: store.AuditResultSuccess,
		})
	}

	if n := len(readExportCSV(t, r, "?days=30")) - 1; n != 502 {
		t.Errorf("expected 502 rows (501 fresh + 1 mid-window, 45d-old clipped), got %d", n)
	}
}

// TestExportAudit_WindowClipAndDaysParams 窗口裁剪与 days 参数收敛。每个查询
// 用独立 store：导出自身入账会让「行数=种子窗口数」随导出次数漂移，独立装配
// 让每次断言都从零起算
func TestExportAudit_WindowClipAndDaysParams(t *testing.T) {
	now := time.Now()
	seed := []time.Duration{0, -10 * 24 * time.Hour, -45 * 24 * time.Hour}
	cases := []struct {
		name  string
		query string
		want  int // now + 10 天前命中 30 天窗；1 天窗只剩 now；45 天前恒被裁
	}{
		{name: "default window", query: "", want: 2},
		{name: "days=30", query: "?days=30", want: 2},
		{name: "days=1 clips mid", query: "?days=1", want: 1},
		{name: "days=junk falls back", query: "?days=junk", want: 2},
		{name: "days=0 falls back", query: "?days=0", want: 2},
		{name: "days=9999 clamps", query: "?days=9999", want: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := setupAuditExportRouter(t)
			for _, d := range seed {
				store.Get().Audit.Append(store.AuditEvent{
					Time: now.Add(d), Action: store.AuditUnlock, Result: store.AuditResultFailure,
				})
			}
			if n := len(readExportCSV(t, r, tc.query)) - 1; n != tc.want {
				t.Errorf("%s: expected %d rows, got %d", tc.query, tc.want, n)
			}
		})
	}
}

func TestExportAudit_AppendsAuditEntry(t *testing.T) {
	r := setupAuditExportRouter(t)
	store.Get().Audit.Append(store.AuditEvent{Action: store.AuditUnlock, Result: store.AuditResultSuccess})

	req := httptest.NewRequest("GET", "/api/audit/export", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	events, total, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 2 {
		t.Fatalf("expected 2 events (1 seeded + 1 export), got %d", total)
	}
	e := events[0] // 倒序，导出事件最新
	if e.Action != store.AuditLogExport || e.Result != store.AuditResultSuccess {
		t.Errorf("unexpected export event: %+v", e)
	}
	if !strings.Contains(e.Detail, "days=30") || !strings.Contains(e.Detail, "rows=1") {
		t.Errorf("expected days/rows metadata in detail, got %q", e.Detail)
	}
}

// ── 导出过滤联动（P-20261007-2） ──
// 覆盖：action=/result= 单值/多值/组合 AND 过滤、零参数全量同现状、未知值
// 空结果不报错、空白容忍、行数上限对「过滤后导出行数」仍生效、自审计 Detail
// 零过滤逐字节不变/带过滤时含 filters 段（多值排序 | 连接）

// setupFilteredExportSeeds 播种 2×2 混合事件（Time=now 落窗口内）：
// unlock 失败×2、unlock 成功×1、凭据保存成功×2、主机创建成功×1
func setupFilteredExportSeeds(t *testing.T) {
	t.Helper()
	now := time.Now()
	seed := []struct {
		action string
		result string
		times  int
	}{
		{store.AuditUnlock, store.AuditResultFailure, 2},
		{store.AuditUnlock, store.AuditResultSuccess, 1},
		{store.AuditCredSave, store.AuditResultSuccess, 2},
		{store.AuditHostCreate, store.AuditResultSuccess, 1},
	}
	for _, s := range seed {
		for i := 0; i < s.times; i++ {
			store.Get().Audit.Append(store.AuditEvent{
				Time: now, Action: s.action, Result: s.result,
			})
		}
	}
}

// exportCSVRows 请求导出并返回数据行的 action 列与 result 列
func exportCSVRows(t *testing.T, r *gin.Engine, query string) (actions, results []string) {
	t.Helper()
	for _, rec := range readExportCSV(t, r, query)[1:] {
		actions = append(actions, rec[1])
		results = append(results, rec[2])
	}
	return actions, results
}

func TestExportAudit_FilterActionAndResult(t *testing.T) {
	cases := []struct {
		name      string
		query     string
		wantActs  []string // 期望 action 序列（倒序输出，按播种量折叠验证用集合比较）
		wantResN  map[string]int
		wantTotal int
	}{
		{name: "zero params = full window", query: "", wantTotal: 6},
		{name: "single action", query: "?action=" + store.AuditUnlock,
			wantTotal: 3, wantActs: []string{store.AuditUnlock, store.AuditUnlock, store.AuditUnlock},
			wantResN: map[string]int{store.AuditResultFailure: 2, store.AuditResultSuccess: 1}},
		{name: "multi action union", query: "?action=" + store.AuditUnlock + "," + store.AuditCredSave,
			wantTotal: 5, wantActs: []string{store.AuditUnlock, store.AuditUnlock, store.AuditUnlock, store.AuditCredSave, store.AuditCredSave}},
		{name: "multi action with spaces", query: "?action=" + store.AuditUnlock + ",%20" + store.AuditCredSave + "%20",
			wantTotal: 5, wantActs: []string{store.AuditUnlock, store.AuditUnlock, store.AuditUnlock, store.AuditCredSave, store.AuditCredSave}},
		{name: "result failure", query: "?result=" + store.AuditResultFailure,
			wantTotal: 2, wantActs: []string{store.AuditUnlock, store.AuditUnlock},
			wantResN: map[string]int{store.AuditResultFailure: 2}},
		{name: "combined AND", query: "?action=" + store.AuditCredSave + "&result=" + store.AuditResultSuccess,
			wantTotal: 2, wantActs: []string{store.AuditCredSave, store.AuditCredSave}},
		{name: "combined AND empty hit", query: "?action=" + store.AuditUnlock + "&result=" + store.AuditResultDenied,
			wantTotal: 0},
		{name: "unknown value = empty not error", query: "?action=no.such.action", wantTotal: 0},
		{name: "only separators = no filter", query: "?action=,&result=,", wantTotal: 6},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := setupAuditExportRouter(t) // 每例独立 store：导出自身入账不污染计数
			setupFilteredExportSeeds(t)
			actions, results := exportCSVRows(t, r, tc.query)
			if len(actions) != tc.wantTotal {
				t.Fatalf("query %s: expected %d rows, got %d (%v)", tc.query, tc.wantTotal, len(actions), actions)
			}
			for _, a := range actions {
				if len(tc.wantActs) > 0 && !sliceContains(tc.wantActs, a) {
					t.Errorf("query %s: unexpected action %q", tc.query, a)
				}
			}
			counts := map[string]int{}
			for _, res := range results {
				counts[res]++
			}
			for res, n := range tc.wantResN {
				if counts[res] != n {
					t.Errorf("query %s: result %q count=%d, want %d", tc.query, res, counts[res], n)
				}
			}
		})
	}
}

func sliceContains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// 行数上限对过滤后导出行数仍生效：小上限注入（100k 种子对 file-per-doc 存储
// 不可负担），cap 只计匹配行——不匹配行不消耗上限也不出现在文件里
func TestExportAudit_RowCapAppliesAfterFilter(t *testing.T) {
	origCap := auditExportRowCap
	auditExportRowCap = 3
	t.Cleanup(func() { auditExportRowCap = origCap })

	r := setupAuditExportRouter(t)
	now := time.Now()
	for i := 0; i < 5; i++ {
		store.Get().Audit.Append(store.AuditEvent{
			Time: now, Action: store.AuditUnlock, Result: store.AuditResultFailure,
		})
		store.Get().Audit.Append(store.AuditEvent{
			Time: now, Action: store.AuditCredSave, Result: store.AuditResultSuccess,
		})
	}

	actions, _ := exportCSVRows(t, r, "?action="+store.AuditUnlock)
	if len(actions) != 3 {
		t.Fatalf("cap must clip matched rows to 3, got %d", len(actions))
	}

	// 零参数同窗（独立 store 重装配，防上一次导出自身入账挤占余量）：
	// cap 照常生效——循环终止面不因过滤改动而破坏
	r2 := setupAuditExportRouter(t)
	for i := 0; i < 5; i++ {
		store.Get().Audit.Append(store.AuditEvent{
			Time: now, Action: store.AuditUnlock, Result: store.AuditResultFailure,
		})
	}
	all, _ := exportCSVRows(t, r2, "")
	if len(all) != 3 {
		t.Fatalf("zero-param export must still honor cap, got %d", len(all))
	}
}

// 自审计入账 Detail：零过滤 = 「days=N rows=N」逐字节不变（存量消费者零感知）；
// 带过滤 = 追加 filters 段（多值排序 | 连接），切片口径在台账可追溯
func TestExportAudit_FilterDetailInAuditEntry(t *testing.T) {
	r := setupAuditExportRouter(t)
	setupFilteredExportSeeds(t)
	readExportCSV(t, r, "?action="+store.AuditCredSave+","+store.AuditUnlock+"&result="+store.AuditResultSuccess)

	events, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	e := events[0] // 倒序，导出事件最新
	want := " filters=action:" + store.AuditCredSave + "|" + store.AuditUnlock + ",result:" + store.AuditResultSuccess
	if !strings.HasSuffix(e.Detail, want) {
		t.Errorf("detail %q missing filter segment %q", e.Detail, want)
	}
	if !strings.Contains(e.Detail, "rows=3") {
		t.Errorf("detail %q: rows must count matched rows only (unlock success x1 + cred.save x2)", e.Detail)
	}

	// 零过滤导出（独立 store）：Detail 无 filters 段
	r2 := setupAuditExportRouter(t)
	setupFilteredExportSeeds(t)
	readExportCSV(t, r2, "")
	events2, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	e2 := events2[0]
	if !regexpDetailDaysRows.MatchString(e2.Detail) {
		t.Errorf("zero-filter detail must be exactly days/rows, got %q", e2.Detail)
	}
}

var regexpDetailDaysRows = regexp.MustCompile(`^days=\d+ rows=\d+$`)
