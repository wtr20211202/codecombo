package system

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/diagnostics"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"
)

// 浏览器侧诊断报告上传（P-20261126-2 P-2b，诊断包的浏览器面收口）：
//
//	POST /api/system/diagnostics/client-report
//	  「导出浏览器诊断」本地 Blob 下载保底后，前端异步附带上传的 server 作用域
//	  裁剪版（entries 最新 50 / 无 resource / 无 UA / 无 protocol）——导出诊断包
//	  时经 ?clientReport=1 条件携带，把它作为 state/browser.json 派生条目入 zip，
//	  一个包同时带走服务端取证与浏览器侧证据。
//
// 鉴权：继承 /api 组四件套（router.go：LockCSRF + LockMiddleware + TokenAuth +
// AgentGuard），另挂 per-route RateLimit（每 IP 每分钟 30 次，clip 先例）。
//
// 安全收口（2026-11-24/26 评审 A1-A4 + B1-B5 落点）：
//   - 两层防线都要：前端 server 作用域裁剪（非白名单数据不出浏览器）+
//     端点 typed 白名单兜底（DisallowUnknownFields 逐字段拒收，客户端字节
//     绝不原样入包）；
//   - entries/ws 超上限**截最新 50 不拒收**（A2：故障复盘时环最满，拒收=功能
//     必失效；unshift 序即最新优先，取前 50 就是最新 50）；
//   - 不接 host/UA/protocol/path 顶层字段：page.serverObservedHost 由本端用
//     c.Request.Host 回填（浏览器自报 host 不可信也不需要）；
//   - 先截断后逐值脱敏（B2 次序写死）：入站只截断到字段界 + 枚举校验，逐值
//     Redactor/mask 在**导出时**按包的 mask 开关执行（mask=0 取证对账档语义
//     与其余条目一致），绝不对整段 JSON 文本跑 mask；
//   - cookie 最小暴露（A4）：Path=/api/system/diagnostics 只覆盖诊断族端点；
//     经 /proxy 的远程实例因 Path 不匹配天然带不上 cookie → 关联退化为
//     absent（fail-closed），导出照常 200；
//   - 报告纯内存（不落盘、不进日志），TTL 5min、单 session ≤4 份、全局 ≤8 份
//     （防多标签×反复点击放大），重启即清。

const (
	// DiagSessionCookieName 浏览器报告会话 cookie（与 sc_lock_token 同属性族：
	// HttpOnly + SameSite=Strict + Secure 按 requestIsHTTPS；由服务端签发/过期，
	// 无 JS 副本——前端 utils/lockCookie 清扫链不受影响）
	DiagSessionCookieName = "sc_diag_session"
	// diagClientReportMaxBytes 请求体硬上限（http.MaxBytesReader）
	diagClientReportMaxBytes = 256 << 10
	// diagClientReportTTL 会话窗：cookie Max-Age 与内存 TTL 同值（5 分钟）
	diagClientReportTTL = 5 * time.Minute
	// diagClientReportMaxPerSession 单 session 报告份数（滚动淘汰最旧）
	diagClientReportMaxPerSession = 4
	// diagClientReportMaxTotal 全局报告份数上限（多标签×反复点击的放大防线；
	// 8×256KB 解码后仍在个位数 MB 量级，无界内存反模式零容忍）
	diagClientReportMaxTotal = 8
	// diagClientReportListLimit entries/ws 端点侧兜底上限（客户端本地环 200 条
	// / ws 环 50 条；端点统一 ≤50——「截最新 50 不拒收」A2）
	diagClientReportListLimit = 50
	// diagClientReportSchemaVersion 与前端 DIAG_SCHEMA_VERSION 同一增量契约
	diagClientReportSchemaVersion = 1
)

// ── typed 白名单（A1 端点兜底层）───────────────────────────────────────────
// 形状与 web/src/utils/browserDiagnostics.ts 的捕获白名单逐字段对齐（entry 级
// path/route 保留：已捕获点模板化+脱敏，是「哪条请求失败」的核心证据；顶层
// page 只收 timezone/tzOffsetMinutes/visibility）。可选数值用指针区分
// 「缺省」与「零值」，re-marshal 不给读者编造字段。

type serverClientReportPage struct {
	Timezone        string `json:"timezone"`
	TzOffsetMinutes *int   `json:"tzOffsetMinutes"`
	Visibility      string `json:"visibility"`
	// ServerObservedHost 只由服务端回填（c.Request.Host）；入站结构体刻意
	// 没有该字段的解码位——客户端多送这个字段会被 DisallowUnknownFields 拒收
	ServerObservedHost string `json:"serverObservedHost,omitempty"`
}

type serverClientReportEntry struct {
	Kind         string `json:"kind"`
	Source       string `json:"source"`
	Ts           string `json:"ts"`
	StartedAt    string `json:"startedAt,omitempty"`
	DurationMs   *int64 `json:"durationMs,omitempty"`
	ErrorClass   string `json:"errorClass"`
	Method       string `json:"method,omitempty"`
	Path         string `json:"path,omitempty"`
	Status       *int   `json:"status,omitempty"`
	RequestID    string `json:"requestId,omitempty"`
	TimedOut     bool   `json:"timedOut,omitempty"`
	TimeoutMs    *int64 `json:"clientTimeoutMs,omitempty"`
	Silent       bool   `json:"silent,omitempty"`
	Route        string `json:"route,omitempty"`
	Message      string `json:"message"`
	Repeats      *int   `json:"repeats,omitempty"`
	CrossOrigin  bool   `json:"crossOrigin,omitempty"`
	Canceled     bool   `json:"canceled,omitempty"`
	DurationKind string `json:"durationKind,omitempty"`
	Slow         bool   `json:"slow,omitempty"`
	Line         *int   `json:"line,omitempty"`
	Col          *int   `json:"col,omitempty"`
}

type serverClientReportWs struct {
	Ts          string `json:"ts"`
	Path        string `json:"path"`
	Code        *int   `json:"code"`
	CloseKind   string `json:"closeKind"`
	Reason      string `json:"reason"`
	WasClean    bool   `json:"wasClean"`
	OpenMs      *int64 `json:"openMs,omitempty"`
	Attempt     *int   `json:"attempt"`
	Intentional bool   `json:"intentional"`
}

// ServerClientReport 端点入站契约（= browser.json 的服务端权威形状）。
// exported 供测试构造/断言，不建议外部直接使用
type ServerClientReport struct {
	SchemaVersion *int                      `json:"schemaVersion"`
	GeneratedAt   string                    `json:"generatedAt"`
	Page          serverClientReportPage    `json:"page"`
	Entries       []serverClientReportEntry `json:"entries"`
	WS            []serverClientReportWs    `json:"ws"`
}

// 入站字段界（先截断后脱敏的「截断」半程；与前端捕获界同值或更严）
const (
	diagMessageMax    = 500
	diagPathMax       = 300
	diagRouteMax      = 300
	diagMethodMax     = 16
	diagRequestIDMax  = 64
	diagWsReasonMax   = 200
	diagTimezoneMax   = 64
	diagVisibilityMax = 32
)

// 截断辅助：len 按字节切（输入已是捕获点脱敏后的短串，字节切对多字节字符的
// 削边只影响超长病态值的美观，不影响安全界）
func diagTruncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// diagTimestamp 时间戳归一：RFC3339 可解析→规范重排；不可解析→fallback
// （generatedAt 用服务端接收时刻，条目级时间戳用空串=缺省）。诊断包的时间戳
// 是读者对账锚，宁缺毋滥不收自由文本
func diagTimestamp(s, fallback string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return fallback
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Format(time.RFC3339)
	}
	return fallback
}

var diagEntryKinds = map[string]bool{"request": true, "script": true, "promise": true}
var diagEntrySources = map[string]bool{"xhr": true, "fetch": true, "vue": true, "window": true, "promise": true}
var diagErrorClasses = map[string]bool{"timeout": true, "network": true, "offline": true, "http4xx": true, "http5xx": true, "unknown": true}
var diagDurationKinds = map[string]bool{"": true, "ttfb": true}
var diagWsCloseKinds = map[string]bool{"normal": true, "abnormal": true, "locked": true, "message-too-big": true, "internal-error": true, "error": true, "unknown": true}

// normalize 归一 + 截断 + 枚举校验（非法枚举返回错误——枚举是固定契约，前端
// 恒送合法值，异常值=手搓客户端/篡改，fail-closed 拒收）
func (r *ServerClientReport) normalize(receivedAt time.Time) error {
	if r.SchemaVersion == nil || *r.SchemaVersion != diagClientReportSchemaVersion {
		return fmt.Errorf("schemaVersion must be %d", diagClientReportSchemaVersion)
	}
	r.GeneratedAt = diagTimestamp(r.GeneratedAt, receivedAt.Format(time.RFC3339))
	r.Page.Timezone = diagTruncate(strings.TrimSpace(r.Page.Timezone), diagTimezoneMax)
	r.Page.Visibility = diagTruncate(strings.TrimSpace(r.Page.Visibility), diagVisibilityMax)
	if n := len(r.Entries); n > diagClientReportListLimit {
		// A2：客户端 unshift 序=最新优先，截前 50 即最新 50（不拒收）
		r.Entries = r.Entries[:diagClientReportListLimit]
	}
	if n := len(r.WS); n > diagClientReportListLimit {
		r.WS = r.WS[:diagClientReportListLimit]
	}
	for i := range r.Entries {
		e := &r.Entries[i]
		if !diagEntryKinds[e.Kind] {
			return fmt.Errorf("entries[%d].kind invalid", i)
		}
		if !diagEntrySources[e.Source] {
			return fmt.Errorf("entries[%d].source invalid", i)
		}
		if !diagErrorClasses[e.ErrorClass] {
			return fmt.Errorf("entries[%d].errorClass invalid", i)
		}
		if !diagDurationKinds[e.DurationKind] {
			return fmt.Errorf("entries[%d].durationKind invalid", i)
		}
		e.Ts = diagTimestamp(e.Ts, "")
		e.StartedAt = diagTimestamp(e.StartedAt, "")
		e.Message = diagTruncate(e.Message, diagMessageMax)
		e.Path = diagTruncate(e.Path, diagPathMax)
		e.Route = diagTruncate(e.Route, diagRouteMax)
		e.Method = diagTruncate(e.Method, diagMethodMax)
		e.RequestID = diagTruncate(e.RequestID, diagRequestIDMax)
	}
	for i := range r.WS {
		w := &r.WS[i]
		if !diagWsCloseKinds[w.CloseKind] {
			return fmt.Errorf("ws[%d].closeKind invalid", i)
		}
		w.Ts = diagTimestamp(w.Ts, "")
		w.Path = diagTruncate(w.Path, diagPathMax)
		w.Reason = diagTruncate(w.Reason, diagWsReasonMax)
	}
	return nil
}

// ── 内存会话窗（不落盘、重启即清）─────────────────────────────────────────

type diagClientReportRecord struct {
	sessionID  string
	receivedAt time.Time
	report     ServerClientReport
}

// diagClientReportStore 全局单环： newest 追加在最右，超界淘汰最左。单环同时
// 承载全局 ≤8 与单 session ≤4 两条封顶（插入时逐 session 清点），TTL 过期在
// 每次插入/查询时惰性清除——无后台 timer，进程闲时零开销
var diagClientReportStore struct {
	mu   sync.Mutex
	ring []*diagClientReportRecord
}

func diagClientReportSweepLocked(now time.Time) {
	kept := diagClientReportStore.ring[:0]
	for _, rec := range diagClientReportStore.ring {
		if now.Sub(rec.receivedAt) <= diagClientReportTTL {
			kept = append(kept, rec)
		}
	}
	diagClientReportStore.ring = kept
}

// storeClientReport 落一份报告（并发安全）：返回 (entries, bytes) 供审计记账
func storeClientReport(sessionID string, rep ServerClientReport, receivedAt time.Time) (int, int) {
	entries := len(rep.Entries)
	raw, _ := json.Marshal(rep)
	diagClientReportStore.mu.Lock()
	defer diagClientReportStore.mu.Unlock()
	diagClientReportSweepLocked(receivedAt)
	// 单 session ≤4：同 session 报告超界淘汰该 session 最旧（不是整环最旧——
	// 防一个高频标签把其他标签的报告挤出局）
	sessionCount := 0
	for _, rec := range diagClientReportStore.ring {
		if rec.sessionID == sessionID {
			sessionCount++
		}
	}
	if sessionCount >= diagClientReportMaxPerSession {
		for i, rec := range diagClientReportStore.ring {
			if rec.sessionID == sessionID {
				diagClientReportStore.ring = append(diagClientReportStore.ring[:i], diagClientReportStore.ring[i+1:]...)
				break
			}
		}
	}
	diagClientReportStore.ring = append(diagClientReportStore.ring, &diagClientReportRecord{
		sessionID:  sessionID,
		receivedAt: receivedAt,
		report:     rep,
	})
	// 全局 ≤8：整体超界淘汰最旧（含已过期未 sweep 的残留）
	for len(diagClientReportStore.ring) > diagClientReportMaxTotal {
		diagClientReportStore.ring = diagClientReportStore.ring[1:]
	}
	return entries, len(raw)
}

// lookupClientReport 该 session 窗口内最近一份（无/过期 → nil）
func lookupClientReport(sessionID string, now time.Time) *ServerClientReport {
	diagClientReportStore.mu.Lock()
	defer diagClientReportStore.mu.Unlock()
	diagClientReportSweepLocked(now)
	for i := len(diagClientReportStore.ring) - 1; i >= 0; i-- {
		rec := diagClientReportStore.ring[i]
		if rec.sessionID == sessionID {
			rep := rec.report
			return &rep
		}
	}
	return nil
}

// resetClientReportStore 测试复位（进程级全局态，用例间隔离）
func resetClientReportStore() {
	diagClientReportStore.mu.Lock()
	diagClientReportStore.ring = nil
	diagClientReportStore.mu.Unlock()
}

// ── cookie helper（B3：新写，不改 SetLockTokenCookie）─────────────────────

// newDiagSessionID crypto/rand 128-bit 会话 id（hex 32 字符）——不可预测是
// 「持 cookie=持关联权」的唯一凭据，无账号语义、过期即废
func newDiagSessionID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// setDiagSessionCookie 报告会话 cookie（最小暴露 A4）：Path 只覆盖诊断族
// 端点（POST 上传 + GET export 回读），其余 API 请求不携带；SameSite=Strict
// + HttpOnly 与 sc_lock_token 同族；Secure 按 HTTPS 形态（明文部署带 Secure
// 会被浏览器拒写）。Max-Age=TTL：cookie 与内存窗同寿命，过期关联自然退化
func setDiagSessionCookie(c *gin.Context, id string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     DiagSessionCookieName,
		Value:    id,
		Path:     "/api/system/diagnostics",
		MaxAge:   int(diagClientReportTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   middleware.RequestIsHTTPS(c.Request),
	})
}

// ── POST handler ──────────────────────────────────────────────────────────

// PostDiagnosticsClientReport POST /api/system/diagnostics/client-report
func PostDiagnosticsClientReport(c *gin.Context) {
	// Content-Type 必须 JSON（axios 恒 application/json；手搓客户端也必须声明）
	if ct := c.GetHeader("Content-Type"); !strings.HasPrefix(strings.ToLower(strings.TrimSpace(ct)), "application/json") {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"err": "unsupportedMediaType", "msg": "Content-Type must be application/json"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, diagClientReportMaxBytes)
	dec := json.NewDecoder(c.Request.Body)
	// typed 白名单兜底（A1）：未知字段整单拒收——客户端字节不经清洗不得入包
	dec.DisallowUnknownFields()
	var rep ServerClientReport
	if err := dec.Decode(&rep); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"err": "payloadTooLarge", "msg": fmt.Sprintf("client report exceeds %d bytes", diagClientReportMaxBytes)})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": err.Error()})
		return
	}
	if dec.More() {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "unexpected trailing data after JSON document"})
		return
	}
	receivedAt := time.Now()
	if err := rep.normalize(receivedAt); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": err.Error()})
		return
	}
	// serverObservedHost 只由服务端回填（浏览器自报 host 不收不信）
	rep.Page.ServerObservedHost = c.Request.Host
	sid, err := newDiagSessionID()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": "session id unavailable"})
		return
	}
	entries, bytes := storeClientReport(sid, rep, receivedAt)
	setDiagSessionCookie(c, sid)
	// 审计只记 size/entries/result（报告内容绝不入账——不落盘不进日志的
	// 内存态红线）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditDiagnosticsClientReport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("bytes=%d entries=%d window=5m", bytes, entries),
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── 导出关联（S2，?clientReport=1 条件携带）────────────────────────────────

// diagClientReportSection 导出时解析浏览器报告关联。返回 (section, marker)：
//   - marker "off"     参数不在场 → section=nil（**不产生 manifest 条目**，
//     A3：防恒注 absent 稀释「absent=该链未走到」的证据语义）
//   - marker "absent"  参数在场但无关联报告（cookie 缺失/过期/重启清空/
//     /proxy 远程形态 Path 不匹配 fail-closed）→ absent 条目 + reason
//   - marker "attached" 参数在场且有报告 → derived 条目（导出时逐值脱敏）
func diagClientReportSection(c *gin.Context, dataDir string, maskOn bool) (*diagnostics.ClientReportSection, string) {
	if !diagFlagEnabled(c.Query("clientReport")) {
		return nil, "off"
	}
	const absentBase = "clientReport requested but no browser report correlated: "
	sid, err := c.Cookie(DiagSessionCookieName)
	if err != nil || strings.TrimSpace(sid) == "" {
		return &diagnostics.ClientReportSection{
			Reason: absentBase + "no sc_diag_session cookie on this request (report never POSTed on this origin within the window, or the instance is reached via /proxy — the cookie Path only matches same-origin direct connections; fail-closed)",
		}, "absent"
	}
	rec := lookupClientReport(sid, time.Now())
	if rec == nil {
		return &diagnostics.ClientReportSection{
			Reason: absentBase + "window expired (5 minutes) or process restarted (reports are memory-only, never persisted)",
		}, "absent"
	}
	return &diagnostics.ClientReportSection{
		Report: renderClientReportJSON(rec, dataDir, maskOn),
		Reason: "browser-side diagnostic report POSTed within the 5-minute session window (capture-point sanitised, server typed allowlist, latest 50 entries, value-masked at export)",
	}, "attached"
}

// renderClientReportJSON 导出时渲染 browser.json：深拷贝后逐字符串值过
// Redactor（mask+路径归一）+ share.RedactLogLine（纵深防御，多半 no-op），
// 再 MarshalIndent——「先截断后逐值脱敏」的后半程在此执行，绝不对整段
// JSON 文本跑 mask（会把键名/结构一起糊掉）。脱敏放导出侧（而非入站侧），
// browser.json 与包内其余文本遵循同一 mask 开关语义
func renderClientReportJSON(rec *ServerClientReport, dataDir string, maskOn bool) []byte {
	out := *rec
	out.Page.Timezone = redactDiagValue(out.Page.Timezone, dataDir, maskOn)
	out.Page.Visibility = redactDiagValue(out.Page.Visibility, dataDir, maskOn)
	out.Page.ServerObservedHost = redactDiagValue(out.Page.ServerObservedHost, dataDir, maskOn)
	for i := range out.Entries {
		e := &out.Entries[i]
		e.Message = redactDiagValue(e.Message, dataDir, maskOn)
		e.Path = redactDiagValue(e.Path, dataDir, maskOn)
		e.Route = redactDiagValue(e.Route, dataDir, maskOn)
		e.Method = redactDiagValue(e.Method, dataDir, maskOn)
		e.RequestID = redactDiagValue(e.RequestID, dataDir, maskOn)
	}
	for i := range out.WS {
		w := &out.WS[i]
		w.Path = redactDiagValue(w.Path, dataDir, maskOn)
		w.Reason = redactDiagValue(w.Reason, dataDir, maskOn)
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		// typed 结构 marshal 不会失败；兜底空对象不吞条目
		return []byte("{}\n")
	}
	return append(raw, '\n')
}

// redactDiagValue 单值脱敏：Redactor.Line（mask 开关 + $DATA_DIR/~ 路径归一）
// 再叠 share.RedactLogLine（share/hook token 与 device_code 的摘要化，纵深防御）
func redactDiagValue(s, dataDir string, maskOn bool) string {
	if s == "" {
		return s
	}
	out := diagnostics.NewRedactor(dataDir, maskOn).Line(s)
	return share.RedactLogLine(out)
}
