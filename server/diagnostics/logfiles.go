package diagnostics

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 日志文件选择/截断/摘要（P-20261122-10 必改A/必改E）。
//
// 命名口径与写侧严格对齐（三处字面量同步维护，改任一处都要来这里核对）：
//   - server/app/app.go dailyHandler.getFile：codecombo-YYYY-MM-DD.log
//   - server/app/app.go legacyLogPrefix：简单标识切换前的 simple-coding-*
//   - server/api/system/servicelogs.go logFilePrefix/legacyLogPrefix（读取侧）
//
// app↔api 是单向依赖、api↔diagnostics 亦然（api → diagnostics 调用收集器），
// 常量没有合法的共同上游包，只能三处同步——漂移面=诊断包里当天日志缺席而
// manifest 记 ABSENT，排障时一眼可见，不至于静默。
const (
	dailyLogPrefix       = "codecombo"
	legacyDailyLogPrefix = "simple-coding"
	dailyLogDateLayout   = "2006-01-02"

	// fullLogMaxBytes ≤8MiB 全带（绝大多数按日日志在此之下）
	fullLogMaxBytes = 8 << 20
	// logHeadBytes 超阈值后的头部配额（启动期证据：版本行/迁移/装配锚点）
	logHeadBytes = 2 << 20
	// logTailBytes 尾部配额（失败证据在尾——tail 偏置 7:1 是本包的核心取向）
	logTailBytes = 14 << 20

	// logAnalysisMaxBytes logs-summary/errors 的分析总读预算（分析要扫全文，
	// 与装箱预算分账：装箱是 96MiB，分析给 256MiB——再往上耗时不可控）
	logAnalysisMaxBytes = 256 << 20
	// errorsMaxLines errors.txt 行数封顶（WARN+ERROR 原文）
	errorsMaxLines = 20000
	// errorsMaxBytes errors.txt 字节封顶：行数封顶挡不住病态长行（单行可达
	// scanBufMax），双封顶保证缓冲有界
	errorsMaxBytes = 8 << 20
	// summaryModuleTopN logs-summary 每文件模块前缀榜单长度
	summaryModuleTopN = 15

	// scanBufMax 单行上限：超过即视为病态行（二进制混入/无换行转储），
	// 停止该文件分析并标 partial——不用无界 ReadString 吃爆内存
	scanBufMax = 1 << 20
)

// sourceFile 候选日志文件（stat 结果，不读内容）
type sourceFile struct {
	abs  string
	base string
	size int64
	mod  time.Time
}

// legacyTailFiles 按 S1 轮转口径产出的历史文件（显式列举：它们是判别证据，
// 不能靠通配——通配只收 *.log，`.1` 后缀漏收）
var legacyTailFiles = []string{"crash.log.1", "update-subprocess.log.1"}

// fixedChainLogs 更新链/崩溃链固定清单（顺序即重要性：新→旧装包顺序里
// 排在天级日志之后、通配日志之前）。四个更新链日志的缺席本身就是判别证据
// ——manifest 记 ABSENT（同 saveResult 先例），绝不造空文件。
var fixedChainLogs = []string{"update.log", "update-subprocess.log", "update-restart.log", "crash.log"}

// expectedRootFiles DataDir 根下的固定期望文件（dsh-web.log 在根不在 logs/，
// config.go:390 写死 stdout 重定向——通配 logs/ 漏它，必须显式列举）
const dshWebLogName = "dsh-web.log"

// selectDailyLogs 选最近 days 天的按日日志（新→旧），并为窗口内每个日历日
// 产出「预期存在」判定：磁盘上没有对应文件 = ABSENT 证据。legacy 前缀文件
// 按日期并入（标识切换过渡期）。
func selectDailyLogs(dir string, days int, now time.Time) (found []sourceFile, absentDays []string) {
	if days <= 0 {
		days = 1
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		// 目录不存在 = logs/ 从未创建（服务从未跑起来）：窗口内全缺席，
		// 由调用方重判缺席清单
		entries = nil
	}
	byDate := map[string]sourceFile{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		date, ok := parseDailyLogName(name)
		if !ok {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil || info.Mode()&os.ModeSymlink != 0 {
			continue // stat 失败/符号链接：不跟进（防越界读取）
		}
		prev, exists := byDate[date]
		// 新旧前缀同日并存时取新前缀（更可能是当前实例写的）；同前缀取最新
		curNew := strings.HasPrefix(name, dailyLogPrefix+"-")
		prevNew := exists && strings.HasPrefix(prev.base, dailyLogPrefix+"-")
		if !exists || (curNew && !prevNew) || (curNew == prevNew && info.ModTime().After(prev.mod)) {
			byDate[date] = sourceFile{
				abs:  filepath.Join(dir, name),
				base: name,
				size: info.Size(),
				mod:  info.ModTime(),
			}
		}
	}
	// 窗口 = 今天 + 往前 days-1 个日历日
	for i := 0; i < days; i++ {
		day := now.AddDate(0, 0, -i).Format(dailyLogDateLayout)
		if f, ok := byDate[day]; ok {
			found = append(found, f)
		} else {
			absentDays = append(absentDays, dailyLogPrefix+"-"+day+".log")
		}
	}
	return found, absentDays
}

// parseDailyLogName 解析按日日志名 → 日期串（非该命名返回 false）
func parseDailyLogName(name string) (string, bool) {
	if !strings.HasSuffix(name, ".log") {
		return "", false
	}
	var rest string
	switch {
	case strings.HasPrefix(name, dailyLogPrefix+"-"):
		rest = strings.TrimSuffix(strings.TrimPrefix(name, dailyLogPrefix+"-"), ".log")
	case strings.HasPrefix(name, legacyDailyLogPrefix+"-"):
		rest = strings.TrimSuffix(strings.TrimPrefix(name, legacyDailyLogPrefix+"-"), ".log")
	default:
		return "", false
	}
	if _, err := time.Parse(dailyLogDateLayout, rest); err != nil {
		return "", false
	}
	return rest, true
}

// wildcardLogs logs/ 通配：收 *.log、跳符号链接、排除半成品/zip、重名去重取
// 最新（seen 里已有的基名直接跳过——固定清单优先）。按 mtime 新→旧排序：
// 近期写入的文件更可能是本次故障现场
func wildcardLogs(dir string, seen map[string]bool, limit ...int) []sourceFile {
	max := 0
	if len(limit) > 0 {
		max = limit[0]
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []sourceFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".log") {
			continue
		}
		if strings.Contains(lower, ".part") || strings.Contains(lower, ".tmp") ||
			strings.Contains(lower, ".zip") || strings.HasSuffix(lower, ".gzip") {
			continue // 半成品/压缩包：半截内容不是证据，还可能很大
		}
		if seen[lower] {
			continue
		}
		// 按日主日志的窗口由 selectDailyLogs 严格管（默认 3 天/上限 retention）：
		// 窗口外的日文件不得从通配兜回来——否则「默认 3 天」在留存 15 天的实例上
		// 会静默变成全量 15 天，N 天纪律名存实亡
		if _, isDaily := parseDailyLogName(name); isDaily {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		seen[lower] = true
		out = append(out, sourceFile{
			abs:  filepath.Join(dir, name),
			base: name,
			size: info.Size(),
			mod:  info.ModTime(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].mod.After(out[j].mod) })
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return out
}

// inclusion 单文件装箱方式（full 或 head+tail）
type inclusion struct {
	full   bool
	head   int64 // 头部字节（已对齐换行）
	tailAt int64 // 尾部起点偏移（文件尾段 = [tailAt, size)）
}

// includedBytes 实际入包字节
func (inc inclusion) includedBytes(size int64) int64 {
	if inc.full {
		return size
	}
	return inc.head + (size - inc.tailAt)
}

// omittedBytes 被省略的字节
func (inc inclusion) omittedBytes(size int64) int64 {
	if inc.full {
		return 0
	}
	return size - inc.includedBytes(size)
}

// planInclusion 决定装箱方式并做换行对齐。
//   - ≤8MiB 全带；
//   - >8MiB 头 2MiB + 尾 14MiB（尾部证据优先）；
//   - 头+尾已覆盖全文件（8~16MiB 区间的文件）按全带处理——切了也没省字节。
//
// 对齐：头部向后找到首个换行（≤64KiB 内），尾部向前找到行首，避免半行
// 撕裂把错误栈截成两截难读的残句；对齐失败（无换行）保持原偏移。
func planInclusion(path string, size int64) inclusion {
	if size <= fullLogMaxBytes {
		return inclusion{full: true}
	}
	head := int64(logHeadBytes)
	if head+logTailBytes >= size {
		return inclusion{full: true}
	}
	if head > size/8 {
		head = size / 8 // 超大文件也留 7/8 给尾部（尾部偏置语义）
	}
	f, err := os.Open(path)
	if err != nil {
		// 打不开就按纯 stat 决策（读取阶段会如实报错）
		return inclusion{head: head, tailAt: size - logTailBytes}
	}
	defer f.Close()
	head = snapHead(f, head, size)
	tailAt := snapTail(f, size-logTailBytes)
	if tailAt <= head {
		return inclusion{full: true} // 对齐后区间重叠：全带更省事也更完整
	}
	return inclusion{head: head, tailAt: tailAt}
}

// snapHead 头部向后对齐到换行之后（最多再看 64KiB）
func snapHead(f *os.File, head, size int64) int64 {
	const window = 64 << 10
	n := int64(window)
	if head+n > size {
		n = size - head
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, head); err != nil && n > 0 {
		return head
	}
	if i := indexByte(buf, '\n'); i >= 0 {
		return head + int64(i) + 1
	}
	return head
}

// snapTail 尾部起点向前对齐到行首（不整行撕裂）
func snapTail(f *os.File, start int64) int64 {
	if start <= 0 {
		return 0
	}
	const window = 64 << 10
	n := int64(window)
	if start-n < 0 {
		n = start
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, start-n); err != nil && n > 0 {
		return start
	}
	if i := lastIndexByte(buf, '\n'); i >= 0 {
		return start - n + int64(i) + 1
	}
	return start
}

func indexByte(b []byte, c byte) int {
	for i := range b {
		if b[i] == c {
			return i
		}
	}
	return -1
}

func lastIndexByte(b []byte, c byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == c {
			return i
		}
	}
	return -1
}

// logStats 单文件分析结果（logs-summary 的一节）
type logStats struct {
	file     string // zip 内条目名（logs/xxx）
	bytes    int64
	lines    int64
	levels   map[string]int64
	modules  map[string]int64
	firstTS  string
	lastTS   string
	partial  bool
	analyzed int64
}

// analyzer 分析器（跨文件累计 errors.txt 的行数/字节数与分析预算）
type analyzer struct {
	red       *Redactor
	budget    int64
	errBuf    *strings.Builder
	errLines  int
	errBytes  int
	errCapped bool
}

func newAnalyzer(red *Redactor) *analyzer {
	return &analyzer{red: red, budget: logAnalysisMaxBytes, errBuf: &strings.Builder{}}
}

// errFull errors.txt 已达行数或字节封顶（双封顶见常量注释）
func (a *analyzer) errFull() bool {
	return a.errLines >= errorsMaxLines || a.errBytes >= errorsMaxBytes
}

// analyze 流式扫一个日志文件：总行数、级别计数、模块前缀 topN、首末时间戳，
// 顺带把 WARN/ERROR 原文抄进 errors.txt 缓冲（2 万行封顶）。
// budget 耗尽或遇病态长行 → partial=true 如实回告，不静默缩水。
func (a *analyzer) analyze(entryName, path string, size int64) logStats {
	st := logStats{
		file:    entryName,
		bytes:   size,
		levels:  map[string]int64{},
		modules: map[string]int64{},
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
	buffered := bufio.NewReaderSize(f, 256<<10)
	read := int64(0)
	// errors.txt 分节头：只有真的有 WARN/ERROR 才写出（空节不复述）
	sectionOpen := false
	sc := bufio.NewScanner(buffered)
	sc.Buffer(make([]byte, 64<<10), scanBufMax)
	for sc.Scan() {
		line := sc.Text()
		read += int64(len(line)) + 1
		a.budget -= int64(len(line)) + 1
		st.lines++
		if ts := timestampOf(line); ts != "" {
			if st.firstTS == "" {
				st.firstTS = ts
			}
			st.lastTS = ts
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
		if a.budget <= 0 {
			st.partial = true
			break
		}
	}
	if err := sc.Err(); err != nil {
		st.partial = true // 病态长行（>1MiB）：停止该文件，如实标 partial
	}
	st.analyzed = read
	return st
}

// levelOf 行级别：slog 文本 handler `level=INFO` 优先，再认 `[WARN]` 旧形态
func levelOf(line string) string {
	if i := strings.Index(line, "level="); i >= 0 {
		rest := line[i+len("level="):]
		for _, lv := range []string{"DEBUG", "INFO", "WARN", "ERROR"} {
			if hasPrefixFold(rest, lv) {
				return lv
			}
		}
	}
	for _, lv := range []string{"DEBUG", "INFO", "WARN", "ERROR"} {
		if strings.Contains(line, "["+lv+"]") {
			return lv
		}
	}
	return ""
}

func hasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	return strings.EqualFold(s[:len(prefix)], prefix)
}

// moduleOf 模块前缀：取 slog msg 值的首个词（`msg="update: backup ..."` →
// update）。这是零配置的模块归因口径——各包 slog 惯例是「模块名: 动作」
// 起头（update:/share:/watcher:），比按文件名猜更稳
func moduleOf(line string) string {
	i := strings.Index(line, "msg=")
	if i < 0 {
		return ""
	}
	rest := line[i+len("msg="):]
	// 去可选引号（slog 文本 handler 只在值含空格时加引号）：TrimPrefix 无条件
	// 形态即语义本身，不做多余的前缀判定（staticcheck S1017）
	rest = strings.TrimPrefix(rest, "\"")
	end := len(rest)
	for j, r := range rest {
		if r == ' ' || r == ':' || r == '"' {
			end = j
			break
		}
	}
	m := strings.TrimSpace(rest[:end])
	if m == "" || !isModuleWord(m) {
		return ""
	}
	return m
}

func isModuleWord(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// timestampOf 行首时间戳：slog `time=2026-...` 优先，退而认
// `2026-11-22 10:00:00` / `2026-11-22T10:00:00` 前缀
func timestampOf(line string) string {
	if strings.HasPrefix(line, "time=") {
		rest := line[len("time="):]
		if i := strings.IndexByte(rest, ' '); i > 0 {
			return rest[:i]
		}
		return rest
	}
	if len(line) >= 19 && line[4] == '-' && line[7] == '-' &&
		(line[10] == ' ' || line[10] == 'T') && line[13] == ':' {
		return line[:19]
	}
	return ""
}

// topModules 模块前缀 topN（"m=n" 形态，稳定排序：计数降序、同数按名升序）
func topModules(mods map[string]int64, n int) string {
	type kv struct {
		k string
		v int64
	}
	rows := make([]kv, 0, len(mods))
	for k, v := range mods {
		rows = append(rows, kv{k, v})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].v != rows[j].v {
			return rows[i].v > rows[j].v
		}
		return rows[i].k < rows[j].k
	})
	if len(rows) > n {
		rows = rows[:n]
	}
	parts := make([]string, 0, len(rows))
	for _, r := range rows {
		parts = append(parts, r.k+"="+strconv.FormatInt(r.v, 10))
	}
	return strings.Join(parts, " ")
}

// renderLogSummary logs-summary.txt：每文件总行/按级别计数/模块前缀 topN/
// 首末时间戳。替代「第二份全量副本」（体积与脱敏成本翻倍），原文仍全带。
func renderLogSummary(stats []logStats) string {
	var b strings.Builder
	b.WriteString("# logs summary — codecombo diagnostics (P-20261122-10)\n")
	b.WriteString("# 每文件：总行 / 按级别计数 / 模块前缀 top15 / 首末时间戳。原文仍全量在 logs/ 下（超 8MiB 的文件为头 2MiB + 尾 14MiB 截断，见 manifest）。\n")
	var totalLines int64
	totalLevels := map[string]int64{}
	for _, s := range stats {
		totalLines += s.lines
		for k, v := range s.levels {
			totalLevels[k] += v
		}
	}
	b.WriteString("# files=" + strconv.Itoa(len(stats)) + " totalLines=" + strconv.FormatInt(totalLines, 10) + "\n")
	b.WriteString("# levels: " + levelLine(totalLevels) + "\n\n")
	for _, s := range stats {
		b.WriteString("## " + s.file + "\n")
		b.WriteString("bytes=" + strconv.FormatInt(s.bytes, 10) +
			" analyzed=" + strconv.FormatInt(s.analyzed, 10) +
			" lines=" + strconv.FormatInt(s.lines, 10) + "\n")
		b.WriteString("levels: " + levelLine(s.levels) + "\n")
		if s.firstTS != "" || s.lastTS != "" {
			b.WriteString("first=" + s.firstTS + " last=" + s.lastTS + "\n")
		}
		if len(s.modules) > 0 {
			b.WriteString("modules: " + topModules(s.modules, summaryModuleTopN) + "\n")
		}
		if s.partial {
			b.WriteString("partial=true # 分析预算耗尽或遇病态长行：本文件统计不完整\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}

func levelLine(levels map[string]int64) string {
	keys := []string{"DEBUG", "INFO", "WARN", "ERROR", "other"}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+strconv.FormatInt(levels[k], 10))
	}
	return strings.Join(parts, " ")
}
