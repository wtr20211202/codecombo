package diagnostics

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 单遍日志分析（P-20261124-1 S2）：现有 analyzer「从文件头读到 256MB 预算」
// 在 dsh-web.log 350MB 上既慢又只覆盖文件头——失败证据在尾部。改为与装箱
// 同款的「头 2MiB + 尾 14MiB」窗口（>8MiB 的文件），一次扫描同时收集：
//
//   - 慢请求行（[GIN] 访问日志，>=1s → slow-requests.txt，Top500）
//   - 每小时行数/错误数（logs-summary.txt，看「哪一小时开始变慢/报错」）
//   - WARN/ERROR 签名去重（errors.txt，TLS 3,953 条同类错误只留首末+count）
//   - 日志 gap 候选（stalls.txt 的历史上下文，必须与慢请求区间交叉验证）
//
// 为什么锚定 `msg=[GIN] `：slogWriter 把 gin 行桥接成 slog 记录，slog 文本
// handler 在值含空格时加引号并转义内部引号——直接找行首 `[GIN]` 会漏掉
// 每一行；同时从右解析 rid（行尾唯一稳定锚），路径段的 `|`/引号不会撕裂。

// slowRequestThresholdLog 日志慢请求阈值（与请求环同口径）
const slowRequestThresholdLog = time.Second

// slowRequestsTopN slow-requests.txt 条目上限
const slowRequestsTopN = 500

// slowRequest 一条来自访问日志的慢请求（无 query / 无 body）
type slowRequest struct {
	file        string
	completedAt time.Time
	startedAt   time.Time
	duration    time.Duration
	status      int
	method      string
	route       string
	rid         string
	clientIP    string
}

// hourBucket 每小时计数（行/错误）
type hourBucket struct {
	Lines  int64 `json:"lines"`
	Errors int64 `json:"errors"`
}

// errorSignature 归一错误签名（TLS 重复错误合并依据）
type errorSignature struct {
	Count int64
	First time.Time
	Last  time.Time
	// Sample 首次原文（已脱敏，限长）
	Sample string
}

// gapCandidate 日志 gap 候选（两条访问日志之间的长间隔）
type gapCandidate struct {
	start  time.Time
	end    time.Time
	before []string // gap 前 3 行（脱敏后）
	after  []string // gap 后 3 行（脱敏后）
}

// maxGapContext 每个 gap 保留的上下文行数
const maxGapContext = 3

// gapThreshold 记一个 gap 的最小间隔（低于 60s 的间隔是正常空闲）
const gapThreshold = 60 * time.Second

// signatureSampleMax 签名样例最大长度
const signatureSampleMax = 160

// analyzer 单遍分析器（每文件一次扫描；跨文件累计签名/慢请求/gap）
type analyzer struct {
	red       *Redactor
	budget    int64
	errBuf    *strings.Builder
	errLines  int
	errBytes  int
	errCapped bool

	// 慢请求（跨文件，最后统一 Top500）
	slow         []slowRequest
	slowParsed   int64
	slowUnparsed int64
	ginLines     int64

	// 错误签名
	sigs     map[string]*errorSignature
	sigOrder []string

	// 日志 gap 候选（跨文件按时间排序后合并）
	gaps []gapCandidate
	// gapFill 正在等 after 上下文的候选索引（-1 = 无）
	gapFill int
	// lastTimestamps 各文件最后一条带时间戳的行（gap 按文件独立检测）
	lastLineAt time.Time
	lastLines  []string
}

func newAnalyzer(red *Redactor) *analyzer {
	return &analyzer{
		red:     red,
		budget:  logAnalysisMaxBytes,
		errBuf:  &strings.Builder{},
		sigs:    map[string]*errorSignature{},
		gapFill: -1,
	}
}

// errFull errors.txt 已达行数或字节封顶（双封顶见常量注释）
func (a *analyzer) errFull() bool {
	return a.errLines >= errorsMaxLines || a.errBytes >= errorsMaxBytes
}

// analyze 流式扫一个日志文件（>8MiB 只扫头+尾窗口），单遍收集全部派生面。
// budget 耗尽或遇病态长行 → partial=true 如实回告，不静默缩水。
func (a *analyzer) analyze(entryName, path string, size int64) logStats {
	st := logStats{
		file:    entryName,
		bytes:   size,
		levels:  map[string]int64{},
		modules: map[string]int64{},
		hours:   map[string]*hourBucket{},
	}
	f, err := os.Open(path)
	if err != nil {
		st.partial = true
		return st
	}
	defer f.Close()
	if a.budget <= 0 {
		st.partial = true
		return st
	}
	inc := planInclusion(path, size)
	if !inc.full {
		st.windowed = true
	}
	// 窗口分段：[0,head) + [tailAt,size)；full 形态一段
	segs := [][2]int64{{0, size}}
	if !inc.full {
		segs = [][2]int64{{0, inc.head}, {inc.tailAt, size}}
	}
	for _, seg := range segs {
		if seg[1] <= seg[0] {
			continue
		}
		if a.budget <= 0 {
			st.partial = true
			break
		}
		if err := a.scanSegment(f, entryName, seg[0], seg[1], &st); err != nil {
			st.partial = true
		}
	}
	return st
}

// scanSegment 扫描一个字节窗口（bufio.Scanner 跨窗口复用行语义：只从窗口
// 起点读，半行由装箱层的换行对齐保证不会出现）
func (a *analyzer) scanSegment(f *os.File, entryName string, from, to int64, st *logStats) error {
	sec := io.NewSectionReader(f, from, to-from)
	sc := bufio.NewScanner(sec)
	sc.Buffer(make([]byte, 64<<10), scanBufMax)
	sectionOpen := false
	// 窗口/文件边界重置 gap 状态：头窗口末尾与尾窗口开头之间隔着被省略的中段，
	// 若沿用上一条时间戳会造出一个「伪 gap」（中间根本没有连续日志，不能当
	// 停顿证据）；跨文件的最后时间戳同理（各文件时间轴可能交叉）。
	a.lastLineAt = time.Time{}
	a.lastLines = nil
	a.gapFill = -1
	for sc.Scan() {
		line := sc.Text()
		read := int64(len(line)) + 1
		a.budget -= read
		st.lines++
		st.analyzed += read

		tsRaw := timestampOf(line)
		var ts time.Time
		if tsRaw != "" {
			ts = parseLogTimestamp(tsRaw)
			if st.firstTS == "" {
				st.firstTS = tsRaw
			}
			st.lastTS = tsRaw
		}
		lv := levelOf(line)
		if lv == "" {
			st.levels["other"]++
		} else {
			st.levels[lv]++
		}
		if m := moduleOf(line); m != "" {
			st.modules[m]++
		}
		if lv == "WARN" || lv == "ERROR" {
			st.errors++
			// errors.txt：按签名去重——首个签名留原文，重复只计数（TLS 3,953
			// 条 unknown certificate 不再挤占 2 万行配额）
			sig := errorSignatureOf(line)
			es := a.sigs[sig]
			if es == nil {
				es = &errorSignature{First: ts, Last: ts, Sample: a.red.Line(truncate(line, signatureSampleMax))}
				a.sigs[sig] = es
				a.sigOrder = append(a.sigOrder, sig)
				if !sectionOpen && !a.errFull() {
					if a.errBuf.Len() > 0 {
						a.errBuf.WriteString("\n")
					}
					a.errBuf.WriteString("## " + entryName + "\n")
					sectionOpen = true
				}
				if !a.errFull() {
					masked := a.red.Line(line)
					a.errBuf.WriteString(masked)
					a.errBuf.WriteString("\n")
					a.errLines++
					a.errBytes += len(masked) + 1
				} else {
					a.errCapped = true
				}
			}
			es.Count++
			if !ts.IsZero() {
				if es.First.IsZero() {
					es.First = ts
				}
				es.Last = ts
			}
		}
		// 每小时行数/错误数（时间戳可解析时；slog 行首 time=）
		if !ts.IsZero() {
			key := ts.Format("2006-01-02T15")
			hb := st.hours[key]
			if hb == nil {
				hb = &hourBucket{}
				st.hours[key] = hb
			}
			hb.Lines++
			if lv == "WARN" || lv == "ERROR" {
				hb.Errors++
			}
		}
		// gap 检测（仅 GIN 访问日志；其它模块行没有完成时刻语义）
		if sr, ok := a.parseGinLine(line, entryName); ok {
			a.ginLines++
			if sr.duration >= slowRequestThresholdLog {
				a.slowParsed++
				a.slow = append(a.slow, sr)
			}
			a.observeGap(sr.completedAt, a.red.Line(truncate(line, 400)))
		} else if strings.Contains(line, "[GIN]") {
			a.slowUnparsed++
		}
		if a.budget <= 0 {
			st.partial = true
			return nil
		}
	}
	return sc.Err()
}

// observeGap 记录访问日志之间的长间隔（约 60s 以上），并捕获前后上下文
func (a *analyzer) observeGap(at time.Time, line string) {
	if at.IsZero() {
		return
	}
	if a.gapFill >= 0 && a.gapFill < len(a.gaps) {
		g := &a.gaps[a.gapFill]
		if len(g.after) < maxGapContext {
			g.after = append(g.after, line)
			if len(g.after) >= maxGapContext {
				a.gapFill = -1
			}
		}
	}
	if !a.lastLineAt.IsZero() && at.Sub(a.lastLineAt) >= gapThreshold {
		before := make([]string, len(a.lastLines))
		copy(before, a.lastLines)
		a.gaps = append(a.gaps, gapCandidate{
			start:  a.lastLineAt,
			end:    at,
			before: before,
		})
		a.gapFill = len(a.gaps) - 1
	}
	a.lastLineAt = at
	a.lastLines = append(a.lastLines, line)
	if len(a.lastLines) > maxGapContext {
		a.lastLines = a.lastLines[len(a.lastLines)-maxGapContext:]
	}
}

// parseLogTimestamp 解析 timestampOf 的两种形态（slog RFC3339 与裸本地时间）
func parseLogTimestamp(raw string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t
		}
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", raw, time.Local); err == nil {
		return t
	}
	if t, err := time.ParseInLocation("2006-01-02T15:04:05", raw, time.Local); err == nil {
		return t
	}
	return time.Time{}
}

// ginLineTSLayout gin 访问日志时间戳布局（ginLogFormatter）
const ginLineTSLayout = "2006/01/02 - 15:04:05"

// parseGinLine 解析一行 gin 访问日志（ok=false 表示不是/解析不了）。
// 锚定 `[GIN] `（slog 桥接后的 msg 值内），从右取 rid，路径按 %#v 引号形态
// 反引号，query 在解析末尾直接丢弃（绝不入包）。
func (a *analyzer) parseGinLine(line, entryName string) (slowRequest, bool) {
	text := line
	if i := strings.Index(line, "msg="); i >= 0 {
		if v, ok := slogMsgValue(line[i+4:]); ok {
			text = v
		}
	}
	j := strings.Index(text, "[GIN] ")
	if j < 0 {
		return slowRequest{}, false
	}
	body := text[j+len("[GIN] "):]
	if len(body) < len(ginLineTSLayout) {
		return slowRequest{}, false
	}
	completed, err := time.ParseInLocation(ginLineTSLayout, body[:len(ginLineTSLayout)], time.Local)
	if err != nil {
		return slowRequest{}, false
	}
	body = strings.TrimPrefix(body[len(ginLineTSLayout):], " | ")

	// status
	i := strings.Index(body, " | ")
	if i < 0 {
		return slowRequest{}, false
	}
	status, err := strconv.Atoi(strings.TrimSpace(body[:i]))
	if err != nil {
		return slowRequest{}, false
	}
	body = body[i+3:]

	// latency（time.ParseDuration：µs/ms/s/m/h；gin 对 >1min 已截成整秒）
	i = strings.Index(body, " | ")
	if i < 0 {
		return slowRequest{}, false
	}
	dur, err := time.ParseDuration(strings.TrimSpace(body[:i]))
	if err != nil {
		return slowRequest{}, false
	}
	body = body[i+3:]

	// client IP
	i = strings.Index(body, " | ")
	if i < 0 {
		return slowRequest{}, false
	}
	clientIP := strings.TrimSpace(body[:i])
	body = strings.TrimSpace(body[i+3:])

	// rid 从右取（行尾唯一稳定锚；路径里的 rid= 字面量不会命中，因为取最后一个）
	rid := ""
	if k := strings.LastIndex(body, " rid="); k >= 0 {
		rid = strings.TrimSpace(body[k+len(" rid="):])
		if sp := strings.IndexAny(rid, " \t\n"); sp >= 0 {
			rid = rid[:sp]
		}
		body = strings.TrimSpace(body[:k])
	}
	// method + path（path 是 %#v 的 Go 引号字符串；先取第一个空格后的剩余）
	method := body
	path := ""
	if sp := strings.IndexByte(body, ' '); sp >= 0 {
		method = body[:sp]
		path = strings.TrimSpace(body[sp+1:])
	}
	path = unquoteGinPath(path)
	// 直接丢弃 query（? 之后全部；无例外）
	if q := strings.IndexByte(path, '?'); q >= 0 {
		path = path[:q]
	}
	route := templateRoute(path)
	return slowRequest{
		file: entryName, completedAt: completed, startedAt: completed.Add(-dur),
		duration: dur, status: status, method: method, route: route,
		rid: rid, clientIP: clientIP,
	}, true
}

// slogMsgValue 从 `msg=` 之后取 slog 文本 handler 的 msg 值：带引号时按
// Go 字符串反转义（slog 用 strconv.AppendQuote），否则取到行尾
func slogMsgValue(rest string) (string, bool) {
	if !strings.HasPrefix(rest, "\"") {
		return rest, true
	}
	// 扫描到未转义的收尾引号
	for i := 1; i < len(rest); i++ {
		if rest[i] == '\\' {
			i++
			continue
		}
		if rest[i] == '"' {
			v, err := strconv.Unquote(rest[:i+1])
			if err != nil {
				return "", false
			}
			return v, true
		}
	}
	return "", false
}

// unquoteGinPath 还原 %#v 形态的路径（失败则手工剥引号，绝不让解析错误
// 把整条慢请求丢掉）
func unquoteGinPath(p string) string {
	if len(p) >= 2 && p[0] == '"' && p[len(p)-1] == '"' {
		if v, err := strconv.Unquote(p); err == nil {
			return v
		}
		return p[1 : len(p)-1]
	}
	return p
}

var (
	uuidSegment   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	hex16Segment  = regexp.MustCompile(`^[0-9a-fA-F]{16}$`)
	tokenSegment  = regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`)
	digitsSegment = regexp.MustCompile(`^[0-9]+$`)
)

// templateRoute 路径段模板化（UUID/16hex/纯数字/长 token → :id）：慢请求表
// 按路由聚合时不被实例值撑散；长 token 段（分享短链/回调凭据）额外收窄，
// 不把凭据值带进派生文件
func templateRoute(p string) string {
	if p == "" {
		return ""
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		switch {
		case uuidSegment.MatchString(s), hex16Segment.MatchString(s), digitsSegment.MatchString(s), tokenSegment.MatchString(s):
			segs[i] = ":id"
		}
	}
	return strings.Join(segs, "/")
}

var (
	reNumericRun = regexp.MustCompile(`\b\d+(\.\d+)?\b`)
	reHexRun     = regexp.MustCompile(`\b[0-9a-fA-F]{12,}\b`)
)

// errorSignatureOf 归一错误签名：取 msg 值 + 数字/长 hex 折叠——同类错误的
// 可变部分（耗时/计数/会话 id）不拆散计数
func errorSignatureOf(line string) string {
	s := line
	if i := strings.Index(s, "msg="); i >= 0 {
		s = s[i+len("msg="):]
	} else if i := strings.Index(s, "["); i >= 0 {
		s = s[i:]
	}
	s = reHexRun.ReplaceAllString(s, "#")
	s = reNumericRun.ReplaceAllString(s, "#")
	return truncate(s, signatureSampleMax)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// renderSlowRequests slow-requests.txt：Top500 按耗时降序；附 parsed/unparsed
// 计数（unparsed>0 说明 formatter/日志格式漂移，读者不会误以为没有慢请求）
func (a *analyzer) renderSlowRequests() string {
	rows := append([]slowRequest(nil), a.slow...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].duration != rows[j].duration {
			return rows[i].duration > rows[j].duration
		}
		return rows[i].completedAt.After(rows[j].completedAt)
	})
	capped := 0
	if len(rows) > slowRequestsTopN {
		capped = len(rows) - slowRequestsTopN
		rows = rows[:slowRequestsTopN]
	}
	var b strings.Builder
	b.WriteString("# slow requests from [GIN] access-log lines (>=1s) — query strings are DROPPED at parse time\n")
	fmt.Fprintf(&b, "# ginLines=%d slowParsed=%d slowUnparsed=%d shown=%d capped=%d\n",
		a.ginLines, a.slowParsed, a.slowUnparsed, len(rows), capped)
	b.WriteString("# startedAt = completedAt - latency (gin's timestamp is taken AFTER the handler returns)\n")
	b.WriteString("# route is templated (UUID/16hex/digits/long tokens -> :id). NOTE: existing logs are NOT uniformly redacted by default; share-token paths are masked by share.RedactLogLine at write time\n")
	b.WriteString("#\n# completedAt | durationMs | status | method | route | rid | clientIp | sourceFile\n")
	if len(rows) == 0 {
		b.WriteString("(no request >=1s in the analysed window)\n")
		return b.String()
	}
	for _, r := range rows {
		fmt.Fprintf(&b, "%s | %d | %d | %s | %s | %s | %s | %s\n",
			r.completedAt.Format("2006-01-02T15:04:05.000"), r.duration.Milliseconds(),
			r.status, r.method, r.route, r.rid, r.clientIP, r.file)
	}
	if capped > 0 {
		fmt.Fprintf(&b, "\n# NOTE: %d more slow requests not shown (top %d kept)\n", capped, slowRequestsTopN)
	}
	return b.String()
}

// mergeGaps 合并重叠/首尾相接的连续 gap（多日志文件时间轴交叉时会为同一段
// 静默各报一次；窗口读取也可能把同一次停顿切成两段）。合并后 start 取最早、
// end 取最晚，上下文保留「前段的前文 + 后段的后文」。
func mergeGaps(gaps []gapCandidate) []gapCandidate {
	if len(gaps) == 0 {
		return nil
	}
	sorted := append([]gapCandidate(nil), gaps...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].start.Before(sorted[j].start) })
	out := make([]gapCandidate, 0, len(sorted))
	for _, g := range sorted {
		if n := len(out); n > 0 && !g.start.After(out[n-1].end.Add(time.Second)) {
			if g.end.After(out[n-1].end) {
				out[n-1].end = g.end
			}
			if len(g.after) > 0 {
				out[n-1].after = g.after
			}
			continue
		}
		out = append(out, g)
	}
	return out
}

// gapEvidence 判断 gap 是否有「请求跨越」证据：慢请求 [startedAt, completedAt]
// 与 gap 区间相交。没有证据的 gap 很可能是真空闲（无请求），不是停顿。
func (a *analyzer) gapEvidence(g gapCandidate) *slowRequest {
	for i := range a.slow {
		r := &a.slow[i]
		if !r.startedAt.After(g.end) && !r.completedAt.Before(g.start) {
			return r
		}
	}
	return nil
}

// renderStallsFile stalls.txt：看门狗为主源（实时、wall/mono 双证），日志 gap
// 只作历史上下文；无跨越证据的 gap 标 likely-idle 移出主表。
func (a *analyzer) renderStallsFile(now time.Time, red *Redactor) string {
	var b strings.Builder
	b.WriteString("# stalls — primary source: in-process watchdog (state/stalls.json); log gaps are historical context only\n\n")
	b.WriteString("## watchdog\n")
	snap := WatchdogSnapshot()
	if !snap.Running {
		b.WriteString("status: skipped (offline CLI collection — no live process to sample)\n")
	} else {
		fmt.Fprintf(&b, "ticks=%d intervalMs=%d maxWallDeltaMs=%d maxMonoDeltaMs=%d stalls=%d goroutineDumps=%d\n",
			snap.Ticks, snap.interval.Milliseconds(), snap.MaxWallDeltaMS, snap.MaxMonoDeltaMS,
			len(snap.Stalls), len(snap.Dumps))
		if len(snap.Stalls) == 0 {
			b.WriteString("(no stall >=2s observed in this process lifetime)\n")
		}
		for _, s := range snap.Stalls {
			fmt.Fprintf(&b, "%s .. %s dur=%dms mono=%dms inflight=%d->%d suspect=%s\n",
				s.StartedAt, s.EndedAt, s.DurationMS, s.MonoDeltaMS, s.InflightAtStart, s.InflightAtEnd, s.Suspect)
		}
	}
	b.WriteString("\n## log gaps (>=60s without a completed request)\n")
	b.WriteString("# A gap is only evidence of a stall when a slow request [completedAt-latency, completedAt] spans it.\n")
	b.WriteString("# Otherwise the semantics are \"no request completed\" — could simply be an idle instance (likely-idle).\n")
	gaps := mergeGaps(a.gaps)
	shown, idle, evidence := 0, 0, 0
	for _, g := range gaps {
		if shown >= 50 {
			break
		}
		ev := a.gapEvidence(g)
		if ev == nil {
			idle++
			continue // 移出主表
		}
		evidence++
		shown++
		fmt.Fprintf(&b, "%s .. %s gapMs=%d verdict=request-spanning spanningRequest=%s %s %dms status=%d rid=%s\n",
			g.start.Format("2006-01-02T15:04:05.000"), g.end.Format("2006-01-02T15:04:05.000"),
			g.end.Sub(g.start).Milliseconds(), ev.method, ev.route, ev.duration.Milliseconds(), ev.status, ev.rid)
		for _, l := range g.before {
			fmt.Fprintf(&b, "  | %s\n", red.Line(truncate(l, 400)))
		}
		for _, l := range g.after {
			fmt.Fprintf(&b, "  | %s\n", red.Line(truncate(l, 400)))
		}
	}
	if evidence == 0 {
		b.WriteString("(no gap with request-spanning evidence)\n")
	}
	fmt.Fprintf(&b, "\n# merged/skipped: likely-idle gaps=%d (no request spanned them), shown request-spanning gaps=%d\n", idle, shown)
	return b.String()
}

// renderSignatures errors.txt 尾部的签名统计（按 count 降序，Top100）
func (a *analyzer) renderSignatures() string {
	type row struct {
		sig string
		es  *errorSignature
	}
	rows := make([]row, 0, len(a.sigOrder))
	for _, sig := range a.sigOrder {
		rows = append(rows, row{sig, a.sigs[sig]})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].es.Count != rows[j].es.Count {
			return rows[i].es.Count > rows[j].es.Count
		}
		return rows[i].sig < rows[j].sig
	})
	if len(rows) > 100 {
		rows = rows[:100]
	}
	var b strings.Builder
	b.WriteString("\n## error signatures (deduplicated; first occurrence is written verbatim above)\n")
	b.WriteString("# count | first | last | signature (masked sample)\n")
	if len(rows) == 0 {
		b.WriteString("(none)\n")
		return b.String()
	}
	for _, r := range rows {
		first, last := "-", "-"
		if !r.es.First.IsZero() {
			first = r.es.First.Format(time.RFC3339)
		}
		if !r.es.Last.IsZero() {
			last = r.es.Last.Format(time.RFC3339)
		}
		fmt.Fprintf(&b, "%d | %s | %s | %s\n", r.es.Count, first, last, strings.ReplaceAll(r.es.Sample, "\n", " "))
	}
	return b.String()
}

// renderHourly logs-summary 的每小时段（每文件，最多 48 个有数据的时段）
func renderHourly(hours map[string]*hourBucket) string {
	if len(hours) == 0 {
		return ""
	}
	keys := make([]string, 0, len(hours))
	for k := range hours {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > 48 {
		keys = keys[len(keys)-48:]
	}
	var b strings.Builder
	b.WriteString("byHour: ")
	for i, k := range keys {
		if i > 0 {
			b.WriteString(" ")
		}
		h := hours[k]
		b.WriteString(k + "=lines:" + strconv.FormatInt(h.Lines, 10) + "/err:" + strconv.FormatInt(h.Errors, 10))
	}
	b.WriteString("\n")
	return b.String()
}
