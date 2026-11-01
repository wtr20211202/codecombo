package system

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// CSP Report-Only 违规报告收集（P-20261007-6，P-20261002-42 的后续观察期件）。
//
// 主应用中间件（server/middleware/securityheaders.go）给全部响应挂
// Content-Security-Policy-Report-Only；浏览器按 CSP 规范自动 POST 违规报告到
// /api/csp-report。端点三条设计约束：
//
//  1. **公开无凭据**：报告由浏览器发出，不携带 X-Lock-Token，锁屏页同样会产生
//     报告——与 /api/quickdrop 同级的「无凭据入站面」，故注册在 api 组之外；
//     路由层按客户端 IP 限流（120 次/分钟）防报告风暴。
//  2. **不落原文**：报告里的 document-uri 可能含项目路径/临时 token，original-policy
//     与 script-sample 是任意页面文本——审计只留 directive + blocked 源（URL 仅
//     origin，剥掉 path/query/userinfo）+ 计数，结构上不给底账引入不可控内容。
//  3. **聚合而非逐条**：CSP 违规可能成百上千（样式属性/内联脚本风暴），逐条入账
//     会刷爆审计台账。按 (directive, blocked 源) 聚合计数，首个批次立即落一条
//     （观察期要即时可见），随后 60s 窗口内只累计，由定时器统一落账；distinct
//     键上限 200、单请求 50 条、请求体 64 KiB——全部有界，恶意 POST 最多制造
//     有限条「安全观测」记录，无法撑爆内存/磁盘。
//
// 聚合事件动作 security.csp_violation 只读不拦截（Report-Only 阶段零白屏风险）；
// agent 经既有 GET /api/audit（或 /api/audit/export?action=security.csp_violation）
// 读取观察期违规面，是安全巡检的可编程原语。

const (
	// cspReportMaxBody 单请求体上限：50 条报告 × 单条约 200B 的余量充足；
	// 浏览器 Reporting API 批量上报不会接近此量级
	cspReportMaxBody = 64 << 10
	// cspReportMaxItems 单请求最多解析的报告条数（Reporting API 数组可能很长）
	cspReportMaxItems = 50
	// cspReportBatchWindow 聚合落账窗口：首个批次即时落账后，窗口内的报告
	// 合并为一条审计，持续报告风暴下最多约每窗口 1~2 条台账
	cspReportBatchWindow = 60 * time.Second
	// cspDetailTopSources 单条审计 Detail 最多列出的违规源条数（按计数降序），
	// 其余仅给 omitted 计数——防 Detail 随 distinct 键膨胀
	cspDetailTopSources = 20
	// cspFieldMaxLen 单个 directive / blocked 源文本上限（rune）
	cspFieldMaxLen = 160
)

// cspMaxDistinctSources 聚合 map 的 distinct 键上限（内存防线）。var 而非 const：
// 单测以小上限注入验证溢出计数（生产路径零差异，同 auditExportRowCap 惯例）。
var cspMaxDistinctSources = 200

// cspSource 归一化后的违规源：CSP 指令名 + 被拦资源的 origin/关键字。
type cspSource struct {
	Directive string
	Blocked   string
}

// cspLegacyReport application/csp-report 报告体（CSP Level 2 形态）。
// 只声明消费字段；original-policy/script-sample/document-uri 等敏感或大字段
// 刻意不落结构体——连解码都不做，避免误入审计。
type cspLegacyReport struct {
	ViolatedDirective  string `json:"violated-directive"`
	EffectiveDirective string `json:"effective-directive"`
	BlockedURI         string `json:"blocked-uri"`
}

// cspReportingReport Reporting API（application/reports+json）的单条报告。
// DocumentURL 同样只声明不消费：报告来源页面不入账。
type cspReportingReport struct {
	Type string `json:"type"`
	Body struct {
		BlockedURL         string `json:"blockedURL"`
		EffectiveDirective string `json:"effectiveDirective"`
	} `json:"body"`
}

// CollectCSPReport POST /api/csp-report —— CSP 违规报告收集端点。
// 永远返回 204（除超限 413）：上报是浏览器 fire-and-forget 行为，语法错误重试
// 无意义，不把解析细节回给报告方。IP 限流由路由层 RateLimitMiddleware 承担。
func CollectCSPReport(c *gin.Context) {
	body := http.MaxBytesReader(c.Writer, c.Request.Body, cspReportMaxBody)
	raw, err := io.ReadAll(body)
	if err != nil {
		c.Status(http.StatusRequestEntityTooLarge)
		return
	}
	sources, dropped := parseCSPReports(raw)
	cspReports.recordAll(sources, dropped)
	c.Status(http.StatusNoContent)
}

// parseCSPReports 兼容三种上报形态：
//   - application/csp-report legacy 对象 {"csp-report":{...}}
//   - Reporting API 数组 [{"type":"csp-violation","body":{...}}]
//   - 单条 Reporting API 对象（部分客户端/代理的形态）
//
// 同时接受裸 legacy 对象。解析失败/空体返回零值（调用方仍回 204）。
// dropped 为超出单请求条数上限的报告数（聚合计入台账，防静默丢失观测量）。
func parseCSPReports(raw []byte) (sources []cspSource, dropped int) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, 0
	}

	if raw[0] == '[' {
		var reports []cspReportingReport
		if json.Unmarshal(raw, &reports) != nil {
			return nil, 0
		}
		for _, r := range reports {
			// Reporting API 可能携带其他 type（deprecation 等）；只收 CSP。
			if r.Type != "" && r.Type != "csp-violation" {
				continue
			}
			if len(sources) >= cspReportMaxItems {
				dropped++
				continue
			}
			sources = append(sources, cspSource{
				Directive: normalizeCSPDirective(r.Body.EffectiveDirective),
				Blocked:   normalizeCSPBlocked(r.Body.BlockedURL),
			})
		}
		return sources, dropped
	}

	// legacy 包装对象优先；csp-report 字段缺失时字段为零值，由 present 判定回落。
	var wrapped struct {
		Report cspLegacyReport `json:"csp-report"`
	}
	if json.Unmarshal(raw, &wrapped) == nil && legacyReportPresent(wrapped.Report) {
		return []cspSource{legacySource(wrapped.Report)}, 0
	}

	// 单条 Reporting API 对象（type 显式声明才认，避免把 legacy 字段误读成它）。
	var single cspReportingReport
	if json.Unmarshal(raw, &single) == nil && single.Type == "csp-violation" {
		return []cspSource{{
			Directive: normalizeCSPDirective(single.Body.EffectiveDirective),
			Blocked:   normalizeCSPBlocked(single.Body.BlockedURL),
		}}, 0
	}

	var legacy cspLegacyReport
	if json.Unmarshal(raw, &legacy) == nil && legacyReportPresent(legacy) {
		return []cspSource{legacySource(legacy)}, 0
	}
	return nil, 0
}

func legacyReportPresent(r cspLegacyReport) bool {
	return strings.TrimSpace(r.EffectiveDirective) != "" ||
		strings.TrimSpace(r.ViolatedDirective) != "" ||
		strings.TrimSpace(r.BlockedURI) != ""
}

func legacySource(r cspLegacyReport) cspSource {
	directive := r.EffectiveDirective
	if strings.TrimSpace(directive) == "" {
		directive = r.ViolatedDirective
	}
	return cspSource{
		Directive: normalizeCSPDirective(directive),
		Blocked:   normalizeCSPBlocked(r.BlockedURI),
	}
}

// normalizeCSPDirective 把 effective-directive（优先）或 violated-directive
// （legacy 的完整指令串，如 "script-src 'self'"）收敛为指令名。非法字符剔除、
// 小写化、截断，保证 Detail 是稳定可解析的 token。
func normalizeCSPDirective(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return "unknown"
	}
	// violated-directive 带策略源列表：只取首个空白前的指令名
	if i := strings.IndexAny(raw, " \t"); i >= 0 {
		raw = raw[:i]
	}
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return truncateRunes(b.String(), 64)
}

// normalizeCSPBlocked 把 blocked-uri 收敛为「可聚合的违规源」：
//   - CSP 关键字（inline/eval/data/blob/...）原样保留；
//   - http(s)/ws(s) URL 只留 scheme://host[:port]（小写 host，剥 path/query/
//     userinfo——document 路径与报告里的临时 token 不外泄）；
//   - data:/blob:/filesystem: 只留 scheme 标记（内容本体绝不入账）；
//   - 其他形态走字符白名单清洗后截断。
//
// 之所以聚合到 origin 而非完整 URL：CSP 的源约束粒度就是 origin，同源不同
// path 的违规应收在同一条观察项里；同时天然限制 distinct 键的数量。
func normalizeCSPBlocked(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "unknown"
	}
	lower := strings.ToLower(raw)
	switch lower {
	case "inline", "eval", "data", "blob", "filesystem", "wasm-eval", "self", "same-origin":
		return lower
	}
	scheme, _, hasScheme := strings.Cut(lower, ":")
	if hasScheme {
		switch scheme {
		case "data", "blob", "filesystem":
			// blob:https://host/uuid 的 origin 即文档自身，UUID 是噪音，只留标记
			return scheme + ":"
		case "http", "https", "ws", "wss":
			if u, err := url.Parse(raw); err == nil && u.Host != "" {
				host := strings.ToLower(u.Hostname())
				if host != "" {
					if port := u.Port(); port != "" {
						host = net.JoinHostPort(host, port)
					}
					return scheme + "://" + host
				}
			}
		}
	}
	return truncateRunes(sanitizeCSPField(raw), cspFieldMaxLen)
}

// sanitizeCSPField 清洗任意来源文本：控制字符（含换行）剔除，逗号/分号/竖线
// 替换为下划线（这三个字符是 Detail 聚合语法的分隔符），保证 Detail 单行且可解析。
func sanitizeCSPField(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f:
			continue
		case r == ',' || r == ';' || r == '|':
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// cspAggregateKey 聚合键：指令 + 违规源 origin/关键字。
type cspAggregateKey struct {
	Directive string
	Blocked   string
}

// cspBatch 一个聚合窗口的累计量。reports 为观察到的报告总数（含因 distinct
// 上限未单独计数的报告），dropped 为后者，distinct = len(counts)。
type cspBatch struct {
	counts  map[cspAggregateKey]int
	reports int
	dropped int
}

// cspAggregator 报告聚合器：互斥锁保护批状态；timer 保证「首个批次立即落账 +
// 后续窗口按时收口」——没有持续报告时也不会把最后一批困在内存里。
type cspAggregator struct {
	mu    sync.Mutex
	batch *cspBatch
	timer *time.Timer
}

var cspReports = &cspAggregator{}

// recordAll 把一批解析结果计入当前窗口。首个报告（timer 未起）立即落账：
// 观察期需要「发生即可见」；落账后开启 60s 窗口，窗口内的后续报告只累计。
func (a *cspAggregator) recordAll(sources []cspSource, dropped int) {
	if len(sources) == 0 && dropped <= 0 {
		return
	}
	a.mu.Lock()
	if a.batch == nil {
		a.batch = &cspBatch{counts: make(map[cspAggregateKey]int)}
	}
	b := a.batch
	for _, src := range sources {
		if src.Directive == "" && src.Blocked == "" {
			continue
		}
		b.reports++
		key := cspAggregateKey(src)
		if _, ok := b.counts[key]; ok {
			b.counts[key]++
		} else if len(b.counts) < cspMaxDistinctSources {
			b.counts[key] = 1
		} else {
			// distinct 键已满：丢新键但保留总量，观察「有溢出」比静默丢失可审
			b.dropped++
		}
	}
	b.dropped += dropped

	immediate := a.timer == nil
	var snapshot *cspBatch
	if immediate {
		a.timer = time.AfterFunc(cspReportBatchWindow, a.flush)
		snapshot = a.batch
		a.batch = nil
	}
	a.mu.Unlock()

	if snapshot != nil {
		appendCSPAudit(snapshot)
	}
}

// flush 收口当前窗口（timer 回调或测试直调）。无累计时只复位 timer，不写空账。
func (a *cspAggregator) flush() {
	a.mu.Lock()
	snapshot := a.batch
	a.batch = nil
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
	a.mu.Unlock()
	if snapshot != nil {
		appendCSPAudit(snapshot)
	}
}

// appendCSPAudit 把一批聚合写成一条 security.csp_violation 审计。
// 系统聚合事件无请求上下文（可能由 timer goroutine 落账），故走裸 Append、
// 不填 Rid/IP——台账语义是「这段时间观察到哪些违规源」，不是逐报告访问日志。
// store 未装配（裸单测）时静默跳过，与 Append 的尽力而为语义一致。
func appendCSPAudit(b *cspBatch) {
	if b == nil || (b.reports == 0 && b.dropped == 0) {
		return
	}
	st := store.Get()
	if st == nil || st.Audit == nil {
		return
	}

	type sourceCount struct {
		key   cspAggregateKey
		count int
	}
	rows := make([]sourceCount, 0, len(b.counts))
	for k, n := range b.counts {
		rows = append(rows, sourceCount{key: k, count: n})
	}
	// 计数降序 + 键字典序破平：同一输入两次落账 Detail 稳定可比
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].count != rows[j].count {
			return rows[i].count > rows[j].count
		}
		if rows[i].key.Directive != rows[j].key.Directive {
			return rows[i].key.Directive < rows[j].key.Directive
		}
		return rows[i].key.Blocked < rows[j].key.Blocked
	})
	top := rows
	if len(top) > cspDetailTopSources {
		top = top[:cspDetailTopSources]
	}
	parts := make([]string, 0, len(top))
	for _, row := range top {
		parts = append(parts, fmt.Sprintf("%s|%s:%d", row.key.Directive, row.key.Blocked, row.count))
	}
	detail := fmt.Sprintf("reports=%d distinct=%d dropped=%d top=%s",
		b.reports, len(rows), b.dropped, strings.Join(parts, ","))
	if omitted := len(rows) - len(top); omitted > 0 {
		detail += fmt.Sprintf(" omitted=%d", omitted)
	}

	st.Audit.Append(store.AuditEvent{
		Action: store.AuditCSPViolation,
		Result: store.AuditResultSuccess,
		Detail: detail,
	})
}

// resetCSPReportsForTest 清理包级聚合状态（单测隔离用；生产无调用点）。
func resetCSPReportsForTest() {
	cspReports.mu.Lock()
	if cspReports.timer != nil {
		cspReports.timer.Stop()
	}
	cspReports.batch = nil
	cspReports.timer = nil
	cspReports.mu.Unlock()
}
