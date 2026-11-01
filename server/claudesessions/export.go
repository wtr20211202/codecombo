// 会话回放导出 Markdown（P-20261003-44）：把单条 transcript 渲染为可带走的
// Markdown 知识文档——user/assistant 分节、工具调用折叠为「工具名+目标」摘要
// 行、思考块以引用块标记。检索（P-19）解决「找到」，导出补上「带走」的出站口。
//
// 解析复用 timeline.go 的既有基建（LocateSession/collectTailLines/isUserLine/
// parseUserLine/summarizeToolInput/truncateRunes，宽松容错与窗口口径全部继承，
// 本文件零重构零分叉）。一处刻意的导出侧扩展：assistant 行的 thinking 块在
// 回放时间线跳过（parseAssistantLine 口径「回放关心动作与答复」），导出按提案
// 口径以引用块保留——知识资产视角思考过程是资产的一部分。为不动共享解析链与
// 前端 TimelineEntry 契约，assistant 行在导出侧自走 content 数组（文档序保留
// thinking 与正文的交错），user 行仍复用 parseUserLine。
//
// 不走 timelineCache：该缓存承载的是回放口径条目（无 thinking），导出条目含
// thinking 不得入内（否则污染回放渲染）；导出是用户显式低频动作，每次实时
// 解析一次的成本与列表扫描同量级，不为此引入第二套缓存。
//
// 护栏（沿用本包扫描上限惯例，超限如实上报 Truncated）：
//   - 源上限 = 时间线尾部窗口（timelineWindowLines/Bytes）：数百 MB 巨型会话
//     只导出最近一段，与回放可回览范围一致
//   - 渲染输出字节上限 exportMaxBytes：病态大窗口的文档体积再封顶
//
// 敏感注记（提案原文）：导出为会话全文明文，P-108 遮蔽不套用——导出是显式
// 的「带走」动作，遮蔽破坏知识资产完整性；与检索/回放展示面「旁人可见」的
// 遮蔽理由不同（默认原样保真，提案交由实现取舍后落定）。原始 JSONL 导出
// （P-20261003-60）同此注记：原文件即全量明文。
//
// 原始 JSONL 导出（P-20261003-60）：md 是人读渲染（工具调用折叠、窗口截断），
// 机读存档/再分析/迁移需要结构无损的本体——ExportRaw 定位原文件路径供 handler
// 流式直传（零解析零渲染，原文件即 timeline 解析的输入本体），标题走头部窗口
// 轻量提取（只为合成下载名，不走全量解析）。P-20261003-113 起例外收口：出域
// 前按会话 cwd 把内嵌的项目根绝对路径逐行相对化改写（relpath.go，仅精确前缀
// 替换——结构/换行/其余字节原样），cwd 未知降级为原样直传。
package claudesessions

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// exportMaxBytes 渲染文档字节上限（护栏二）：源侧已有尾部窗口封顶（4000 行
// /32MB），此值再封顶文档体积——超过即止渲染并补截断注记（如实上报不静默）
const exportMaxBytes = 8 << 20

// exportTitleMaxRunes 下载文件名里标题摘要的 rune 上限（跨平台文件名长度安全：
// 40 rune 中文 = 120 字节，加前后缀远低于各平台 255 上限）
const exportTitleMaxRunes = 40

// thinkingMaxRunes 思考块渲染截断：与条目正文同上限（思考草稿可能巨长，
// 引用块里全量保留会把文档体积放大数倍，截断口径与 user/assistant 对齐）
const thinkingMaxRunes = timelineTextMaxRunes

// ExportResult 导出结果：Markdown 全文 + 元数据（下载文件名摘要与截断如实
// 上报由 handler 消费）
type ExportResult struct {
	Markdown   string
	Title      string // 首条有效用户消息摘要（无则回退会话 id，与列表标题同源）
	EntryCount int    // 实际渲染条目数
	Truncated  bool   // 任一护栏触发（窗口截断/输出上限），文档内已附注记
}

// ExportMode 导出档位（P-20261004-132）：完整过程（full，P-44 现状零变化）与
// 仅问答（qa，只渲染 user/assistant 正文，跳过工具/结果/思考过程噪声——贴文档/
// 发队友读者要的是结论与建议）。qa 过滤在渲染层：parseExportAt 解析链与
// renderExportMarkdown 渲染器零改动（P-44 全复用），仅问答档元数据（标题/会话
// ID/导出时间/窗口注记）与完整档同源同形
type ExportMode string

const (
	ExportModeFull ExportMode = "full"
	ExportModeQA   ExportMode = "qa"
)

// ParseExportMode 查询串 mode 参数解析：空串与 "full" = 完整档（缺省零变化），
// "qa" = 仅问答；其余值 ok=false（handler 400 明确拒绝——与未知 format 同款
// 不静默回落纪律，机读消费方拿错档位比报错更糟）
func ParseExportMode(raw string) (ExportMode, bool) {
	switch strings.TrimSpace(raw) {
	case "", string(ExportModeFull):
		return ExportModeFull, true
	case string(ExportModeQA):
		return ExportModeQA, true
	}
	return "", false
}

// Export 单会话导出：定位 → 尾部窗口回读 → 解析 → 渲染。宽松容错与 Timeline
// 同口径（坏行/未知行静默跳过，绝不因单行坏数据失败）；会话不存在返回
// ErrSessionNotFound（handler 404，不暴露文件系统布局）
func Export(root, sessionID string) (ExportResult, error) {
	return ExportAt(root, sessionID, time.Now())
}

// ExportAt 带导出时刻注入的导出主体（时刻只进文档头与下载文件名，注入供测试
// 断言日期段；生产路径 Export 传 time.Now()）
func ExportAt(root, sessionID string, now time.Time) (ExportResult, error) {
	return ExportAtMode(root, sessionID, now, ExportModeFull)
}

// ExportAtMode 带档位的导出主体：完整档与 ExportAt 逐字节同链（mode 非 qa 时
// 零过滤），仅问答档在渲染前过滤条目（qaVisibleEntries）。批量导出（P-165）
// 与分享快照（P-77）不掺档位——zip 是存档形态、分享是「看完整过程」的现场，
// 档位分化只在单会话出文档这一消费面
func ExportAtMode(root, sessionID string, now time.Time, mode ExportMode) (ExportResult, error) {
	p, err := parseExportAt(root, sessionID)
	if err != nil {
		return ExportResult{}, err
	}
	entries := p.entries
	if mode == ExportModeQA {
		entries = qaVisibleEntries(entries)
	}
	doc, outTrunc := renderExportMarkdown(entries, p.title, sessionID, now, p.windowTrunc, exportMaxBytes)
	return ExportResult{
		Markdown:   doc,
		Title:      p.title,
		EntryCount: len(entries),
		Truncated:  p.windowTrunc || outTrunc,
	}, nil
}

// qaVisibleEntries 仅问答档条目过滤（P-20261004-132，渲染层——解析链零改动）：
// 只保留 user/assistant 正文条目。定夺注记（提案留给实施的选择）：思考块不保留
// ——「仅问答」语义=问与答，思考草稿与工具摘要/结果引用同属动机句所说的过程
// 噪声（读者要的是结论与建议，草稿常与正文结论重复且含未定稿推断）；完整档
// 的思考资产语义不变，两档分工正好覆盖两类读者。原被工具步隔开的相邻
// assistant 条目过滤后续入同一节（renderExportMarkdown 的 kind 变化开新节规
// 则自然收敛），问答文档更连贯
func qaVisibleEntries(entries []TimelineEntry) []TimelineEntry {
	out := make([]TimelineEntry, 0, len(entries))
	for _, e := range entries {
		if e.Kind == "user" || e.Kind == "assistant" {
			out = append(out, e)
		}
	}
	return out
}

// parsedExport 会话解析中间态（导出渲染与分享快照共用）：条目为导出侧口径
// （含 thinking，路径已相对化），title 同下载名/列表口径
type parsedExport struct {
	entries     []TimelineEntry
	title       string
	windowTrunc bool
}

// parseExportAt 定位 → 尾部窗口回读 → 解析 → 路径相对化 → 标题提取。
// 导出渲染与分享快照（P-20261003-77）共用同一条解析链：两处消费同源条目，
// 避免「导出有思考块、分享没有」的口径漂移
func parseExportAt(root, sessionID string) (parsedExport, error) {
	path, ok := LocateSession(root, sessionID)
	if !ok {
		return parsedExport{}, ErrSessionNotFound
	}
	f, err := os.Open(path)
	if err != nil {
		return parsedExport{}, err
	}
	defer f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
	st, err := f.Stat()
	if err != nil {
		return parsedExport{}, err
	}

	lines, windowTrunc := collectTailLines(f, st.Size(), timelineWindowLines, timelineWindowBytes)
	entries := parseExportLines(lines)
	// 出域路径相对化（P-20261003-113）：正文/工具输入中嵌着的项目根绝对路径
	// 改写为相对形态（标题随改写后条目，下载名同样不外带主机布局）；cwd 未
	// 知降级不改写（export.go 原行为）
	if cwd := headCwd(f); cwd != "" {
		relativizeEntries(entries, cwd)
	}
	return parsedExport{entries: entries, title: exportTitle(entries, sessionID), windowTrunc: windowTrunc}, nil
}

// ShareSnapshotResult 会话回放分享快照（P-20261003-77）：解析后的条目序列
// （含 thinking 与工具详情，导出侧口径——回放时间线刻意跳过 thinking，分享
// 提案明确要求访客可见全量）+ 标题 + 窗口截断标记。条目已做项目根路径
// 相对化（不含主机布局）；敏感值遮蔽由分享落盘层完成（本包只管解析）
type ShareSnapshotResult struct {
	Title     string
	Entries   []TimelineEntry
	Truncated bool
}

// ShareSnapshot 会话回放分享的条目快照：与 Markdown 导出共用 parseExportAt
// （窗口上限/宽松容错/路径相对化/标题口径全继承），只是不渲染文档。会话不
// 存在返回 ErrSessionNotFound（handler 404，不暴露文件系统布局）
func ShareSnapshot(root, sessionID string) (ShareSnapshotResult, error) {
	p, err := parseExportAt(root, sessionID)
	if err != nil {
		return ShareSnapshotResult{}, err
	}
	return ShareSnapshotResult{Title: p.title, Entries: p.entries, Truncated: p.windowTrunc}, nil
}

// RawExport 原始 transcript 导出定位结果（P-20261003-60）：Path 供 handler
// 流式直传，Title 仅为合成下载名（与 md 导出同源口径）；Root = 会话 cwd
// （P-20261003-113 JSONL 出域改写锚点，头部窗口未提取到为空串——handler
// 降级为原样直传）
type RawExport struct {
	Path  string
	Title string
	Root  string
}

// ExportRaw 原始 JSONL 导出定位：不做任何解析/渲染（原文件即 timeline 解析
// 的输入本体，窗口截断是 md 渲染侧的护栏），句柄与流式拷贝由 handler 承接。
// P-20261003-113 起出域前按 Root 相对化改写（出域口同滤，见 relpath.go）；
// 会话不存在返回 ErrSessionNotFound（handler 404）
func ExportRaw(root, sessionID string) (RawExport, error) {
	path, ok := LocateSession(root, sessionID)
	if !ok {
		return RawExport{}, ErrSessionNotFound
	}
	title, cwd := rawHeadMeta(path, sessionID)
	return RawExport{Path: path, Title: title, Root: cwd}, nil
}

// rawHeadMeta 头部窗口轻量提取（titleSearchBytes 窗口与 scanFile 同口径）：
// 标题供合成下载名、cwd 供出域路径改写锚点——一次头部读两用（parseHead 同
// 一解析链），不走 Export 全量解析（尾部窗口解析 + 渲染只为元数据不成比例）。
// 标题找不到回退会话 id（与列表/md 导出同回退）；cwd 未提取到返回空串（调用
// 方降级不改写）。两字段齐了才停（标题行未必带 cwd，等齐再退出窗口）；窗口
// 切缘的截断行解析失败由 looseUnmarshal 宽松兜住，绝不因此失败
func rawHeadMeta(path, sessionID string) (title, cwd string) {
	f, err := os.Open(path)
	if err != nil {
		return sessionID, ""
	}
	defer f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
	buf := make([]byte, titleSearchBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && n == 0 {
		return sessionID, ""
	}
	var s Session
	for _, line := range bytes.Split(buf[:n], []byte("\n")) {
		if s.Title != "" && s.Cwd != "" {
			break
		}
		parseHead(line, &s)
	}
	if s.Title == "" {
		title = sessionID
	} else {
		title = s.Title
	}
	return title, s.Cwd
}

// headCwd 头部窗口提取会话工作目录（项目 root）：transcript 每行携带 cwd
// 字段，头部窗口必然命中（parseHead 既有提取链）。供 md 导出渲染前的路径
// 相对化（relpath.go）；读失败/未提取到返回空串——调用方降级为不改写
func headCwd(f *os.File) string {
	buf := make([]byte, titleSearchBytes)
	n, err := f.ReadAt(buf, 0)
	if err != nil && n == 0 {
		return ""
	}
	var s Session
	for _, line := range bytes.Split(buf[:n], []byte("\n")) {
		if s.Cwd != "" {
			break
		}
		parseHead(line, &s)
	}
	return s.Cwd
}

// relativizeEntries 就地改写条目正文与工具输入中的项目根绝对路径（md 导出
// 渲染前的最后一跳，标题取改写后条目——下载名同样不外带主机布局）。只动
// 导出链：回放时间线（timeline.go）不在此列——展示面在登录态内不出域，且
// 时间线整窗缓存（timelineCache）承载回放口径条目；导出侧每次实时解析出新
// 条目，就地改写无缓存污染面
func relativizeEntries(entries []TimelineEntry, root string) {
	for i := range entries {
		entries[i].Text = RelativizeText(entries[i].Text, root)
		entries[i].Input = RelativizeText(entries[i].Input, root)
	}
}

// parseExportLines 行序列 → 导出条目（时间正序）。user 行复用 parseUserLine
// （user 文本 + result 条目口径全继承）；assistant 行走导出侧 walker（text/
// thinking/tool 文档序，见包注释）；条目上限与解析层防御口径一致
func parseExportLines(lines [][]byte) []TimelineEntry {
	entries := make([]TimelineEntry, 0, 64)
	for _, line := range lines {
		switch {
		case isUserLine(line):
			parseUserLine(line, &entries)
		case isAssistantLine(line):
			entries = appendAssistantExport(line, entries)
		}
		if len(entries) >= timelineMaxEntries {
			return entries[:timelineMaxEntries]
		}
	}
	return entries
}

// appendAssistantExport assistant 行 → 导出条目（0..N 条，文档序）。与
// parseAssistantLine 唯一的差异是 thinking 分支（回放跳过、导出保留），text/
// tool_use 的截断与摘要口径逐字对齐——改这里必须同步那边，反之亦然
func appendAssistantExport(line []byte, entries []TimelineEntry) []TimelineEntry {
	var m struct {
		Message struct {
			Content []struct {
				Type     string          `json:"type"`
				Text     string          `json:"text"`
				Thinking string          `json:"thinking"`
				Name     string          `json:"name"`
				Input    json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Timestamp string `json:"timestamp"`
	}
	if !looseUnmarshal(line, &m) {
		return entries
	}
	for _, item := range m.Message.Content {
		switch item.Type {
		case "text":
			if text := strings.TrimSpace(item.Text); text != "" {
				entries = append(entries, TimelineEntry{
					Kind: "assistant",
					At:   m.Timestamp,
					Text: truncateRunes(text, timelineTextMaxRunes),
				})
			}
		case "thinking":
			if text := strings.TrimSpace(item.Thinking); text != "" {
				entries = append(entries, TimelineEntry{
					Kind: "thinking",
					At:   m.Timestamp,
					Text: truncateRunes(text, thinkingMaxRunes),
				})
			}
		case "tool_use":
			entries = append(entries, TimelineEntry{
				Kind:  "tool",
				At:    m.Timestamp,
				Tool:  item.Name,
				Input: summarizeToolInput(item.Input),
			})
		}
	}
	return entries
}

// exportTitle 会话标题：首条有效用户消息摘要（与列表标题同源口径），无则回退
// 会话 id（空会话/纯工具噪声会话也有可用的下载名）
func exportTitle(entries []TimelineEntry, sessionID string) string {
	for _, e := range entries {
		if e.Kind == "user" && isTitleWorthy(e.Text) {
			return truncateRunes(e.Text, titleMaxRunes)
		}
	}
	return sessionID
}

// renderExportMarkdown 条目序列 → Markdown 文档。分节规则：kind 变化时开新
// 节（相邻同 kind 条目续在节内，避免连续工具步产生重复标题）；输出累计到
// maxBytes 即止渲染（截断如实上报）。maxBytes 参数化供护栏单测注入小上限
// （生产路径传 exportMaxBytes 常量）
func renderExportMarkdown(entries []TimelineEntry, title, sessionID string, now time.Time, windowTrunc bool, maxBytes int) (doc string, truncated bool) {
	var b strings.Builder
	b.WriteString("# Claude 会话：" + title + "\n\n")
	b.WriteString("- 会话 ID：`" + sessionID + "`\n")
	b.WriteString("- 步数：" + strconv.Itoa(len(entries)) + "\n")
	b.WriteString("- 导出时间：" + now.Format("2006-01-02 15:04:05") + "\n\n")
	if windowTrunc {
		b.WriteString("> 注：会话过长，仅包含最近一段（与回放窗口一致），更早内容未导出。\n\n")
	}
	b.WriteString("---\n\n")

	prevKind := ""
	for _, e := range entries {
		if e.Kind != prevKind {
			switch e.Kind {
			case "user":
				b.WriteString("## 👤 用户" + exportTimeSuffix(e.At) + "\n\n")
			case "assistant":
				b.WriteString("## 🤖 助手" + exportTimeSuffix(e.At) + "\n\n")
			}
			prevKind = e.Kind
		}
		switch e.Kind {
		case "user", "assistant":
			b.WriteString(e.Text + "\n\n")
		case "thinking":
			b.WriteString(mdQuote("💭 "+e.Text) + "\n")
		case "tool":
			b.WriteString("- 🔧 **" + mdEscapeCell(e.Tool) + "**" + mdTarget(e.Input) + "\n")
		case "result":
			// 结果摘要走引用块（工具输出常多行，逐行 ">" 前缀保持块连续）
			if e.Status == "error" {
				b.WriteString(mdQuote("⚠️ 失败："+e.Text) + "\n")
			} else {
				b.WriteString(mdQuote("↳ "+e.Text) + "\n")
			}
		}
		// 输出护栏：到顶即止（当前条目已写完，文档保持行完整）
		if b.Len() >= maxBytes {
			truncated = true
			break
		}
	}
	if truncated {
		b.WriteString("\n> 注：内容超过导出大小上限，已在上方截断。\n")
	}
	return b.String(), truncated
}

// exportTimeSuffix 节标题的时刻后缀（「 · 01-02 15:04」）；无时间戳/解析失败
// 的行不带后缀（与回放页「前端不渲染时间」口径一致）
func exportTimeSuffix(at string) string {
	t, err := time.Parse(time.RFC3339, at)
	if err != nil {
		return ""
	}
	return " · " + t.Format("01-02 15:04")
}

// mdQuote 多行文本 → 引用块（逐行 ">" 前缀；空行也补前缀保持块连续）
func mdQuote(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, l := range lines {
		lines[i] = "> " + l
	}
	return strings.Join(lines, "\n")
}

// mdTarget 工具摘要行的目标段（「：`<目标>`」）；无输入摘要只有工具名（提案
// 口径「工具名+目标一行」，目标是尽力而为的摘要）
func mdTarget(input string) string {
	if strings.TrimSpace(input) == "" {
		return ""
	}
	return "：" + mdInlineCode(input)
}

// mdInlineCode 行内代码包裹：换行折叠为空格（摘要行语义）；反引号冲突按
// CommonMark 惯例加长围栏（内容含 N 连反引号时用 N+1 包裹）
func mdInlineCode(s string) string {
	s = strings.Join(strings.Fields(strings.ReplaceAll(s, "\r\n", "\n")), " ")
	longest, run := 1, 0
	for _, r := range s {
		if r == '`' {
			run++
			if run >= longest {
				longest = run + 1
			}
		} else {
			run = 0
		}
	}
	fence := strings.Repeat("`", longest)
	return fence + s + fence
}

// mdEscapeCell 工具名进 **强调** 段前的防御性清洗：工具名来自 transcript
// （外部产物无兼容承诺），* 与换行会破坏强调语法，折叠之（正常工具名无感）
func mdEscapeCell(name string) string {
	s := strings.Join(strings.Fields(strings.ReplaceAll(name, "\r\n", "\n")), " ")
	return strings.ReplaceAll(s, "*", "＊")
}

// ExportDownloadName 下载文件名：claude-<标题摘要>-<yyyymmdd>.<ext>（ext =
// "md"/"jsonl"，P-20261003-60 起双格式共用同一套净化与摘要规则）。标题是用户
// 内容（可含引号/CRLF/非 ASCII/路径分隔符）：控制字符（含 CRLF）与跨平台不
// 安全字符折叠为 '-'（空格合法保留，下载名可读）、rune 截断、首尾 '-'/'.' 修
// 整（Windows 段规则）；非 ASCII 由 Content-Disposition 的 RFC 5987 形式承载，
// 本函数只保证文件系统安全（patchDownloadName 同惯例）
func ExportDownloadName(title, sessionID string, now time.Time, ext string) string {
	var b strings.Builder
	for _, r := range title {
		if r >= 0x20 && r != 0x7f && !strings.ContainsRune(`\/:*?"<>|`, r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	slug := b.String()
	// 连续折叠符并缩 + 首尾修整：Windows 段尾的 '.'/' ' 非法，'-' 尾缀难看
	slug = collapseDashes(slug)
	runes := []rune(slug)
	if len(runes) > exportTitleMaxRunes {
		runes = runes[:exportTitleMaxRunes]
	}
	// 首尾修整集含空格（段首尾空格 Windows 非法；段内空格已保留）
	slug = strings.Trim(string(runes), "-. ")
	if slug == "" {
		slug = sanitizeFallbackID(sessionID)
	}
	return "claude-" + slug + "-" + now.Format("20060102") + "." + ext
}

// ExportQADownloadName 仅问答档下载名（P-20261004-132）：完整档同净化链，ext
// 前插 "-qa" 档位尾缀（claude-<标题摘要>-<日期>-qa.md）——同日同题双档下载不
// 互相覆盖，尾缀贴近扩展名（同日多档按名仍聚簇）。qa 档仅 md 形态，无 ext 参数
func ExportQADownloadName(title, sessionID string, now time.Time) string {
	return strings.TrimSuffix(ExportDownloadName(title, sessionID, now, "md"), ".md") + "-qa.md"
}

// collapseDashes 连续 '-' 并缩为单个
func collapseDashes(s string) string {
	var b strings.Builder
	prev := false
	for _, r := range s {
		if r == '-' {
			if !prev {
				b.WriteByte('-')
			}
			prev = true
			continue
		}
		b.WriteRune(r)
		prev = false
	}
	return b.String()
}

// sanitizeFallbackID 会话 id 回退下载名时的防御性清洗（id 经 LocateSession 已
// 排除分隔符/点号，此处兜底非 ASCII 与超长——不信任一切外部串）
func sanitizeFallbackID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r > 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return truncateRunes(b.String(), exportTitleMaxRunes)
}
