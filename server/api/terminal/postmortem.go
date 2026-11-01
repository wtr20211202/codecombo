package terminal

// 失败会话一键验尸（P-20261004-60）：会话异常退出（exitCode != 0）时素材
// 全部在手——退出码（OnExit 回调实参）、输出现场（此刻 scrollback 尚可读，
// native 缓冲随会话销毁即失）、末命令（OSC 133 命令历史按会话过滤，P-20261004-35）、
// 会话元数据（AgentSessionMeta 车道 1）。本文件把素材组装为两类出口：
//  1. 退出时刻的通知（notifyAbnormalExit）：正文携验尸摘要（语言中立明细），
//     Action=postmortem 打开验尸弹层——通知从「知道挂了」升级为「可行动」。
//     两条退出链（项目终端 terminal.go / agent 会话 longsession.go）共用。
//  2. GET /api/terminals/:id/postmortem：聚合报告，Markdown / JSON 双形态
//     （Accept 协商，后者供 agent 程序化自析——「上会话为什么挂」可编程获取）。
//     会话已销毁时以 meta+history 兜底，输出尾部退化到 claude transcript
//     尾读（transcript 文件不随会话删除；native scrollback 是内存态、诚实
//     标注不可得），不虚构数据。
//
// 遮蔽纪律：验尸包含输出原文，进通知/报告/剪贴板/新会话 prompt 前必经
// mask.MaskText（P-108 模式集）——与 claudesessions 检索、录制 tap 同一纪律。
// 出域闸门：会话被人工标记敏感（P-20261003-155）时与导出/直播分享同一
// warnings+override 二次确认契约（GET 端点）。

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/api/shared"
	"codecombo/server/claudesessions"
	"codecombo/server/mask"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 验尸边界常量：报告侧以「看得清死因」为度，通知侧以「不打扰」为度。
// 行数预算覆盖 PTY 宽度折行（一行逻辑文本在缓冲里可能是多行），字节预算
// 兜底无换行的超长行
const (
	pmCaptureLines      = 80              // 退出时刻 scrollback 尾读行数（折行余量）
	pmTailMaxBytes      = 16 << 10        // 尾读字节预算（防无换行超长行拖爆聚合）
	pmReportTailLines   = 40              // 报告携带的尾部行数
	pmNotifyTailLines   = 8               // 通知体携带的尾部行数（摘要性质）
	pmNotifyLineRunes   = 160             // 通知体单行 rune 截断
	pmNotifyBodyBytes   = 2048            // 通知体总字节上限（通知落盘车道 1，量级克制）
	pmLastCommands      = 3               // 末命令条数（台账口径）
	pmTranscriptEntries = 20              // transcript 尾读条目数
	pmWindowSkew        = 2 * time.Minute // transcript 时间窗匹配的时钟容差
)

// errPostmortemNotFound 验尸目标不可得：会话不在册且 meta 无记录（历史
// 会话被清理后的补查），404 语义与导出/scrollback 同族
var errPostmortemNotFound = errors.New("session not found")

// PostmortemReport 验尸聚合报告（JSON 形态即 API 契约）。指针字段承载
// 「有记录」语义：ExitCode/ExitedAt 仅异常退出落过 meta 才非 nil（正常退出/
// 存活中/旧数据缺省），前端按缺省渲染「无异常退出记录」
type PostmortemReport struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Runtime   string `json:"runtime,omitempty"`
	Dir       string `json:"dir,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	// Alive 会话当前是否在册（存活中仍可验尸——右键入口对活会话同样可用）
	Alive     bool       `json:"alive"`
	CreatedAt time.Time  `json:"createdAt,omitempty"`
	ExitCode  *int       `json:"exitCode,omitempty"`
	ExitedAt  *time.Time `json:"exitedAt,omitempty"`
	// InitialPrompt 创建指令原文（meta 既有，P-20261003-146）：死因常与任务
	// 本身相关（指令把 agent 带进沟里），报告带上省一次反查
	InitialPrompt string `json:"initialPrompt,omitempty"`
	// LastCommands 末命令（OSC 133 命令历史按会话过滤，旧→新）。命令历史
	// 仅前端在项目上下文内上报（无项目的纯 agent 会话无记录——诚实缺失）
	LastCommands []store.HistoryEntry `json:"lastCommands,omitempty"`
	// OutputTail 输出尾部原文（已剥 ANSI + P-108 遮蔽）；不可得时为空
	OutputTail string `json:"outputTail,omitempty"`
	// OutputSource 尾部来源：scrollback（在册会话实时缓冲）/ transcript
	//（claude 转写尾读）/ 空 = 两路都不可得（native 会话已销毁且无 transcript）
	OutputSource string `json:"outputSource,omitempty"`
	// TranscriptID 命中的 claude 会话 UUID（transcript 来源时携带，供前端
	// 深链回放页全量转写）
	TranscriptID string `json:"transcriptId,omitempty"`
}

// recordSessionExit 异常退出记录落 meta（幂等读改写；正常退出不落键——
// 0 值与「无记录」共用缺省，省一个指针字段）。meta 缺失（创建异步落库未达
// 即退出的极端窗口）放弃记录：退出记录是 meta 的增量字段，无主可附不如不写。
// 对向竞态（创建链异步 save 晚于本写落盘会覆盖退出记录）窗口为毫秒级且
// 仅影响「秒退会话」的补查报告，不为它加跨 goroutine 同步
func recordSessionExit(sessionID string, exitCode int, at time.Time) {
	if exitCode == 0 {
		return
	}
	meta, err := store.Get().AgentSession.Get(sessionID)
	if err != nil || meta == nil {
		return
	}
	meta.ExitCode = exitCode
	meta.ExitedAt = at
	if err := store.Get().AgentSession.Save(*meta); err != nil {
		slog.Warn("postmortem: exit record save failed", "id", sessionID, "err", err)
	}
}

// notifyAbnormalExit 异常退出通知（两条退出链共用出口）：退出记录落 meta →
// 通知入账（正文携验尸摘要，Action=postmortem 打开验尸弹层）。同步执行——
// 等待链（waitLoop）handler 本就串行派发，本函数的额外代价（scrollback 尾读
// ≤80 行内存拷贝 / tmux capture-pane 子进程几十毫秒）与既有入账链同量级，
// 内联保持与录制 finalize 等 handler 的确定性次序；会话随后自 map 移除不影响
// 持指针读取缓冲
func notifyAbnormalExit(session *terminal.Session, exitCode int) {
	st := store.Get()
	if st == nil || session == nil {
		return
	}
	now := time.Now()
	recordSessionExit(session.ID, exitCode, now)

	// 验尸摘要（此刻素材最全）：输出尾部 + 末命令 + 时间窗
	tail, _ := captureLiveTail(session)
	tail = mask.MaskText(tail)
	summary := buildExitSummary(session, exitCode, now, tail)

	projectName := ""
	if session.ProjectID != "" {
		if p, err := st.Project.GetByID(session.ProjectID); err == nil && p != nil {
			projectName = p.Name
		}
	}
	st.Notification.Add(notification.Notification{
		Type:     "warning",
		Category: notification.CategoryTask,
		// 模板文案（titleKey/summary）见前端 locales terminal.postmortem.notify；
		// Title 原文为无模板消费方（webhook 外发、API 直读）的回退
		TitleKey: "terminal.postmortem.notify.title",
		Title:    "会话异常退出：" + session.Name,
		BodyKey:  "terminal.postmortem.notify.summary",
		Body:     summary,
		MsgParams: map[string]any{
			"name": session.Name,
			"code": exitCode,
		},
		ProjectID:   session.ProjectID,
		ProjectName: projectName,
		// postmortem 动作（P-20261004-60）：点击打开验尸弹层（报告+一键转存
		// 问询）。原 terminal 跳转对已退出会话本就无落点（native 缓冲随会话
		// 销毁，tmux shell 退出即会话终结），验尸入口是唯一有落点的主动作
		Action:        "postmortem",
		ActionPayload: session.ID,
	})
}

// captureLiveTail 在册会话的输出尾部：scrollback 尾读（行+字节双预算）剥
// ANSI 后的纯文本。读失败降级空串（tmux capture 在底层会话已死时失败——
// 现场不可得如实留空，不阻塞通知主链）
func captureLiveTail(session *terminal.Session) (string, string) {
	raw, err := session.CaptureScrollback(pmCaptureLines)
	if err != nil || len(raw) == 0 {
		return "", ""
	}
	stripped := strings.TrimLeft(string(terminal.StripANSI(raw)), "\r\n \t")
	if stripped == "" {
		return "", ""
	}
	return clampTail(stripped, pmReportTailLines, pmTailMaxBytes), "scrollback"
}

// clampTail 尾部裁剪：保留末 maxLines 行（空行整体丢弃——终端输出空行密集
// 且零信息量，紧凑优先），总字节超 budget 时自更早的行丢弃（保尾语义，与
// 前端 promptFit.fitByBytes 同向）。返回文本不以换行结尾
func clampTail(text string, maxLines, budget int) string {
	raw := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, ln := range raw {
		if ln = strings.TrimSpace(ln); ln != "" {
			lines = append(lines, ln)
		}
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	// 字节预算：自尾部累计，超限的头部行整体丢弃
	total := 0
	start := len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		total += len(lines[i]) + 1
		if total > budget {
			break
		}
		start = i
	}
	if start < len(lines) {
		lines = lines[start:]
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

// buildExitSummary 通知体语言中立明细（webhook 外发/API 直读同读）：
// key=value 事实行 + 尾部输出摘要，ASCII 锚定便于机器消费
func buildExitSummary(session *terminal.Session, exitCode int, at time.Time, tail string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "exit=%d", exitCode)
	fmt.Fprintf(&b, "\nat=%s", at.Format("2006-01-02 15:04:05"))
	if cmds := lastCommands(session.ProjectID, session.ID, pmNotifyTailLines); len(cmds) > 0 {
		last := cmds[len(cmds)-1]
		fmt.Fprintf(&b, "\nlast: %s (exit %d)", singleLine(last.Command), last.ExitCode)
	}
	if tail != "" {
		b.WriteString("\n--- tail ---\n")
		for i, ln := range strings.Split(tail, "\n") {
			if i >= pmNotifyTailLines {
				break
			}
			b.WriteString(truncateRunesLocal(ln, pmNotifyLineRunes))
			b.WriteByte('\n')
		}
	}
	out := strings.TrimRight(b.String(), "\n")
	// 总字节上限：通知落盘车道 1，量级克制（超限自尾部保留，同 clampTail 语义）
	if len(out) > pmNotifyBodyBytes {
		out = out[len(out)-pmNotifyBodyBytes:]
		if idx := strings.IndexByte(out, '\n'); idx >= 0 {
			out = out[idx+1:] // 断在行首，避免首行残行
		}
	}
	return out
}

// truncateRunesLocal rune 截断加省略号（与 claudesessions.truncateRunes 同形
// 的包内实现，避免为单函数跨包引私有）
func truncateRunesLocal(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max]) + "…"
}

// singleLine 多行文本压平为单行（命令/prompt 摘要行渲染用，换行折叠空格）
func singleLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// lastCommands 末命令：命令历史按项目文档 + terminalId 过滤（P-20261004-35
// 既有查询面），取最近 limit 条（旧→新，验尸阅读序）。查询失败/无记录返回
// nil——命令历史只覆盖前端在项目上下文内跑过的命令，缺失是常态而非故障
func lastCommands(projectID, terminalID string, limit int) []store.HistoryEntry {
	if projectID == "" || terminalID == "" {
		return nil
	}
	entries, err := store.Get().TerminalHistory.Search(projectID, "", false, terminalID)
	if err != nil || len(entries) == 0 {
		return nil
	}
	// Search 倒序（最新在前）→ 取头 limit 条反转为时间序
	if len(entries) > limit {
		entries = entries[:limit]
	}
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	return entries
}

// buildPostmortemReport 验尸报告聚合：在册会话与 meta 双源合流（存活中右键
// 补查同样可用），输出尾部按 scrollback → transcript 顺序取第一可得路。
// 会话不在册且无 meta = errPostmortemNotFound（404）
func buildPostmortemReport(id string) (*PostmortemReport, error) {
	st := store.Get()
	if st == nil {
		return nil, errPostmortemNotFound
	}
	sess := terminal.DefaultManager.GetSession(id)
	meta, _ := st.AgentSession.Get(id)
	if sess == nil && meta == nil {
		return nil, errPostmortemNotFound
	}

	rep := &PostmortemReport{SessionID: id, Alive: sess != nil}
	if sess != nil {
		rep.Name = sess.Name
		rep.Kind = sess.Kind
		rep.Dir = sess.Path
		rep.ProjectID = sess.ProjectID
		rep.CreatedAt = sess.CreatedAt
	}
	if meta != nil {
		// meta 为权威归档（改名/运行时快照/恢复场景都在），逐字段补齐而非整体
		// 覆盖——活会话字段在册值优先，缺处回落 meta
		if rep.Name == "" {
			rep.Name = meta.Name
		}
		if rep.Dir == "" {
			rep.Dir = meta.Dir
		}
		if rep.ProjectID == "" {
			rep.ProjectID = meta.ProjectID
		}
		if rep.Runtime == "" {
			rep.Runtime = meta.Runtime
		}
		if rep.CreatedAt.IsZero() {
			rep.CreatedAt = meta.CreatedAt
		}
		rep.InitialPrompt = meta.InitialPrompt
		if meta.ExitCode != 0 {
			code := meta.ExitCode
			rep.ExitCode = &code
			exitedAt := meta.ExitedAt
			rep.ExitedAt = &exitedAt
		}
	}

	rep.LastCommands = lastCommands(rep.ProjectID, id, pmLastCommands)

	// 输出尾部：在册 → 实时缓冲；已销毁 → claude transcript 尾读（时间窗
	// 匹配防错挂并行会话），两路都不可得 = 诚实留空
	if sess != nil {
		if tail, source := captureLiveTail(sess); tail != "" {
			rep.OutputTail, rep.OutputSource = mask.MaskText(tail), source
		}
	}
	if rep.OutputTail == "" && rep.Dir != "" {
		windowEnd := time.Now()
		if rep.ExitedAt != nil {
			windowEnd = *rep.ExitedAt
		}
		if tail, tid := transcriptTail(rep.Dir, rep.CreatedAt, windowEnd); tail != "" {
			rep.OutputTail = mask.MaskText(tail)
			rep.OutputSource = "transcript"
			rep.TranscriptID = tid
		}
	}
	return rep, nil
}

// transcriptTail 已销毁会话的输出尾部兜底：meta.Dir 编码出 claude 存储
// 目录，取该目录下活动时间落在会话窗（含时钟容差）内的最近 transcript，
// 尾读 N 条摘要（Timeline 解析基建复用，文本逐条遮蔽在调用方）。找不到/
// 读失败 = 诚实缺失（transcript 可能被 claude 侧清理，或该会话非 claude）
func transcriptTail(dir string, windowStart, windowEnd time.Time) (string, string) {
	root := claudesessions.Root()
	if root == "" || strings.TrimSpace(dir) == "" {
		return "", ""
	}
	res, err := claudesessions.List(root, dir, "", 5, 0)
	if err != nil {
		return "", ""
	}
	// List 按 LastAt 倒序：首个落窗者即本会话最近使用的转写
	for _, s := range res.Sessions {
		if s.LastAt.Before(windowStart.Add(-pmWindowSkew)) || s.LastAt.After(windowEnd.Add(pmWindowSkew)) {
			continue
		}
		return transcriptTailByID(root, s.ID), s.ID
	}
	return "", ""
}

// transcriptTailByID 单条 transcript 尾读：两次分页（先探测总数取尾页窗口，
// 再取 [total-N, total) 页），条目压平为带时间前缀的行
func transcriptTailByID(root, sessionID string) string {
	head, err := claudesessions.Timeline(root, sessionID, 1, 0)
	if err != nil {
		return ""
	}
	offset := head.Total - pmTranscriptEntries
	if offset < 0 {
		offset = 0
	}
	tail, err := claudesessions.Timeline(root, sessionID, pmTranscriptEntries, offset)
	if err != nil {
		return ""
	}
	lines := make([]string, 0, len(tail.Entries))
	for _, e := range tail.Entries {
		switch e.Kind {
		case "user":
			lines = append(lines, markTimelineLine(e.At, "user", e.Text))
		case "assistant":
			lines = append(lines, markTimelineLine(e.At, "assistant", e.Text))
		case "tool":
			lines = append(lines, markTimelineLine(e.At, "tool", singleLine(e.Tool+" "+e.Input)))
		case "result":
			kind := "result(ok)"
			if e.Status == "error" {
				kind = "result(error)" // 失败结果显式标注（死因常在此）
			}
			lines = append(lines, markTimelineLine(e.At, kind, e.Text))
		}
	}
	return clampTail(strings.Join(lines, "\n"), pmReportTailLines, pmTailMaxBytes)
}

// markTimelineLine 时间线条目 → 报告行（秒级时刻 + kind 标签 + 摘要）
func markTimelineLine(at, kind, text string) string {
	when := ""
	if at != "" {
		if t, err := time.Parse(time.RFC3339, at); err == nil {
			when = t.Format("15:04:05") + " "
		}
	}
	return strings.TrimSpace(when + "[" + kind + "] " + truncateRunesLocal(strings.TrimSpace(text), 200))
}

// ---- 报告 Markdown 的事实词面：渲染文本供复制/问询新会话，语言中立优先
// （通知卡的人读文案走 titleKey/bodyKey 前端模板，不在此处） ----
const (
	postmortemTitleWord           = "Postmortem"
	postmortemAliveWord           = "n/a (session alive)"
	postmortemNoRecordWord        = "no abnormal-exit record"
	postmortemTailUnavailableWord = "unavailable (in-memory scrollback is gone with the session; no claude transcript matched)"
)

// renderPostmortemMarkdown 报告 Markdown 渲染（弹层预览 / 复制 / text/markdown
// 协商形态共用同一文本）。时间统一本地时区秒级，事实原文保留
func renderPostmortemMarkdown(rep *PostmortemReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s: %s\n", postmortemTitleWord, rep.Name)
	fmt.Fprintf(&b, "\n- sessionId: `%s`", rep.SessionID)
	if rep.Kind != "" {
		fmt.Fprintf(&b, "  |  kind: %s", rep.Kind)
	}
	if rep.Runtime != "" {
		fmt.Fprintf(&b, "  |  runtime: %s", rep.Runtime)
	}
	if rep.Dir != "" {
		fmt.Fprintf(&b, "\n- dir: `%s`", rep.Dir)
	}
	switch {
	case rep.ExitCode != nil:
		when := ""
		if rep.ExitedAt != nil && !rep.ExitedAt.IsZero() {
			when = rep.ExitedAt.Format("2006-01-02 15:04:05")
		}
		fmt.Fprintf(&b, "\n- exit: **%d** (%s)", *rep.ExitCode, when)
	case rep.Alive:
		b.WriteString("\n- exit: " + postmortemAliveWord)
	default:
		b.WriteString("\n- exit: " + postmortemNoRecordWord)
	}
	if !rep.CreatedAt.IsZero() {
		fmt.Fprintf(&b, "\n- created: %s", rep.CreatedAt.Format("2006-01-02 15:04:05"))
	}
	if rep.InitialPrompt != "" {
		fmt.Fprintf(&b, "\n- prompt: %s", truncateRunesLocal(singleLine(rep.InitialPrompt), 200))
	}
	if len(rep.LastCommands) > 0 {
		b.WriteString("\n\n## last commands\n")
		for _, cmd := range rep.LastCommands {
			fmt.Fprintf(&b, "\n- `%s` (exit %d, %s)", truncateRunesLocal(singleLine(cmd.Command), 200),
				cmd.ExitCode, cmd.At.Format("15:04:05"))
		}
	}
	if rep.OutputTail != "" {
		source := rep.OutputSource
		if rep.TranscriptID != "" {
			source += " (transcript " + rep.TranscriptID + ")"
		}
		fmt.Fprintf(&b, "\n\n## output tail (%s)\n\n```text\n%s\n```\n", source, rep.OutputTail)
	} else {
		b.WriteString("\n\n## output tail\n\n" + postmortemTailUnavailableWord + "\n")
	}
	return b.String()
}

// GetTerminalPostmortem GET /api/terminals/:id/postmortem（P-20261004-60）
// 验尸聚合报告：缺省 JSON（agent 程序化自析），Accept: text/markdown 渲染
// Markdown 文本（人读/弹层复制共用同源文本）。敏感出域闸门（P-20261003-155）
// 与导出同款：标记敏感且未带 override=1 时回 {warnings}，前端确认后带
// override 重试。只读无副作用，不入项目硬锁写族
func GetTerminalPostmortem(c *gin.Context) {
	id := c.Param("id")
	rep, err := buildPostmortemReport(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	if shared.IsSessionSensitive(id) && c.Query("override") != "1" {
		c.JSON(http.StatusOK, gin.H{"warnings": []string{shared.SensitiveSessionWarning}})
		return
	}
	if strings.Contains(c.GetHeader("Accept"), "text/markdown") {
		c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(renderPostmortemMarkdown(rep)))
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rep})
}
