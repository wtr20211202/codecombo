package terminal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// TestRecordSessionExit 退出记录落 meta：仅非 0 退出落键；meta 缺失静默放弃
func TestRecordSessionExit(t *testing.T) {
	setupNotifyTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-pm-1", Dir: "D:/p", Name: "n", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	at := time.Now()
	recordSessionExit("agent-pm-1", 3, at)
	meta, err := store.Get().AgentSession.Get("agent-pm-1")
	if err != nil || meta == nil {
		t.Fatalf("meta missing after exit record: %v", err)
	}
	if meta.ExitCode != 3 {
		t.Fatalf("ExitCode = %d, want 3", meta.ExitCode)
	}
	if meta.ExitedAt.IsZero() {
		t.Fatal("ExitedAt not recorded")
	}

	// 正常退出不落键（0 与「无记录」同形）
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-pm-2", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	recordSessionExit("agent-pm-2", 0, at)
	meta2, _ := store.Get().AgentSession.Get("agent-pm-2")
	if meta2 == nil || meta2.ExitCode != 0 {
		t.Fatalf("zero exit must not be recorded, got %+v", meta2)
	}

	// meta 缺失：静默放弃（无主可附）
	recordSessionExit("agent-pm-missing", 1, at)
}

// TestNotifyAbnormalExit 异常退出通知：入账条目携验尸摘要与 postmortem 动作，
// 末命令（命令历史按会话过滤）进摘要，退出记录随之落 meta
func TestNotifyAbnormalExit(t *testing.T) {
	setupNotifyTest(t)
	now := time.Now()
	sess := &terminal.Session{ID: "agent-pm-n", Name: "崩了会话", Kind: terminal.KindAgent,
		ProjectID: "proj-1", Path: "D:/p", CreatedAt: now.Add(-30 * time.Minute)}
	// meta 先落（创建链异步落库的常态形态），退出记录有主可附
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-pm-n", Name: "崩了会话", CreatedAt: now.Add(-30 * time.Minute)}); err != nil {
		t.Fatal(err)
	}

	// 末命令（命令历史只覆盖项目上下文内上报的条目）
	if err := store.Get().TerminalHistory.Append("proj-1", store.HistoryEntry{
		Command: "npm run build", ExitCode: 1, At: now.Add(-time.Minute), TerminalID: "agent-pm-n",
	}); err != nil {
		t.Fatal(err)
	}

	notifyAbnormalExit(sess, 3)

	list := store.Get().Notification.List(0)
	if len(list) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(list))
	}
	n := list[0]
	if n.TitleKey != "terminal.postmortem.notify.title" || n.BodyKey != "terminal.postmortem.notify.summary" {
		t.Fatalf("unexpected template keys: %s / %s", n.TitleKey, n.BodyKey)
	}
	if n.Action != "postmortem" || n.ActionPayload != "agent-pm-n" {
		t.Fatalf("action = %s/%s, want postmortem/agent-pm-n", n.Action, n.ActionPayload)
	}
	if n.Type != "warning" || n.Category != notification.CategoryTask {
		t.Fatalf("type/category = %s/%s", n.Type, n.Category)
	}
	if m, ok := n.MsgParams["code"].(float64); !ok || m != 3 {
		t.Fatalf("MsgParams code = %v, want 3", n.MsgParams["code"])
	}
	for _, want := range []string{"exit=3", "last: npm run build (exit 1)"} {
		if !strings.Contains(n.Body, want) {
			t.Fatalf("summary body missing %q:\n%s", want, n.Body)
		}
	}

	// 退出记录随之落 meta（供销毁后补查）
	meta, _ := store.Get().AgentSession.Get("agent-pm-n")
	if meta == nil || meta.ExitCode != 3 {
		t.Fatalf("exit record missing after notify: %+v", meta)
	}
}

// TestHandleAgentSessionExitAbnormal agent 退出钩子异常分支：入账验尸通知而
// 非完成提醒（此前该分支整体沉默——P-20261004-60 补位）
func TestHandleAgentSessionExitAbnormal(t *testing.T) {
	setupNotifyTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-pm-h", Name: "hn", CreatedAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	s := &terminal.Session{ID: "agent-pm-h", Name: "hn", Kind: terminal.KindAgent, CreatedAt: time.Now().Add(-time.Hour)}
	handleAgentSessionExit(s, "claude", true, 2)

	list := store.Get().Notification.List(0)
	if len(list) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(list))
	}
	if list[0].Action != "postmortem" {
		t.Fatalf("action = %s, want postmortem", list[0].Action)
	}
	for _, n := range list {
		if n.TitleKey == longSessionTitleKey {
			t.Fatal("long-session done notification must not fire on abnormal exit")
		}
	}
}

// TestClampTail 尾部裁剪：行数上限保尾、字节预算丢头、不残留首尾空行
func TestClampTail(t *testing.T) {
	// 行数上限：8 行只留末 3 行
	got := clampTail("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8", 3, 1<<20)
	if got != "l6\nl7\nl8" {
		t.Fatalf("clampTail lines = %q", got)
	}
	// 字节预算：预算 8 字节只容得下末两行（l7+l8=5 字节 + 换行）
	got = clampTail("long-line-1\nlong-line-2\nl7\nl8", 10, 8)
	if got != "l7\nl8" {
		t.Fatalf("clampTail budget = %q", got)
	}
	// 空白行修整 + 无换行结尾
	got = clampTail("\n\n  spaced  \n\nlast  \n", 5, 1<<20)
	if got != "spaced\nlast" {
		t.Fatalf("clampTail trim = %q", got)
	}
}

// TestBuildExitSummaryCap 通知体总字节上限：超限自尾部保留且断在行首
func TestBuildExitSummaryCap(t *testing.T) {
	sess := &terminal.Session{ID: "agent-pm-cap", Name: "cap", CreatedAt: time.Now()}
	tail := strings.Repeat("x", 3000)
	summary := buildExitSummary(sess, 1, time.Now(), tail)
	if len(summary) > pmNotifyBodyBytes {
		t.Fatalf("summary len = %d, cap %d", len(summary), pmNotifyBodyBytes)
	}
	if !strings.HasPrefix(summary, "exit=1") {
		t.Fatalf("summary must start with exit line, got %q", summary[:20])
	}
}

// TestLastCommands 末命令查询：terminalId 过滤、旧→新排序、limit 截断
func TestLastCommands(t *testing.T) {
	setupNotifyTest(t)
	base := time.Now()
	for i, cmd := range []string{"cmd-a", "cmd-b", "cmd-c", "cmd-d"} {
		if err := store.Get().TerminalHistory.Append("proj-lc", store.HistoryEntry{
			Command: cmd, ExitCode: i, At: base.Add(time.Duration(i) * time.Second), TerminalID: "term-lc",
		}); err != nil {
			t.Fatal(err)
		}
	}
	// 无归属条目（其他会话）不串
	if err := store.Get().TerminalHistory.Append("proj-lc", store.HistoryEntry{
		Command: "other-session", At: base.Add(10 * time.Second), TerminalID: "term-other",
	}); err != nil {
		t.Fatal(err)
	}
	got := lastCommands("proj-lc", "term-lc", 3)
	if len(got) != 3 {
		t.Fatalf("got %d commands, want 3", len(got))
	}
	if got[0].Command != "cmd-b" || got[2].Command != "cmd-d" {
		t.Fatalf("order wrong: %s..%s, want cmd-b..cmd-d", got[0].Command, got[2].Command)
	}
	// 无项目/无会话 id 直接 nil（不查库）
	if lastCommands("", "term-lc", 3) != nil || lastCommands("proj-lc", "", 3) != nil {
		t.Fatal("empty anchors must short-circuit to nil")
	}
}

// seedTranscript 种一条最小可解析 transcript（含敏感值与工具失败结果），返回
// 其所在 claude root。目录编码与 modtime 对齐真实存储（LastAt = mtime）
func seedTranscript(t *testing.T, dir, id string, ts time.Time) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	encoded := claudesessions.EncodePath(dir)
	if err := os.MkdirAll(filepath.Join(root, encoded), 0o755); err != nil {
		t.Fatal(err)
	}
	esc := strings.ReplaceAll(dir, `\`, `\\`)
	var b strings.Builder
	b.WriteString(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"把部署跑起来 token=sc-abc123"},"timestamp":"` + ts.UTC().Format(time.RFC3339) + `","cwd":"` + esc + `"}` + "\n")
	b.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run deploy"}}]},"timestamp":"` + ts.UTC().Format(time.RFC3339) + `"}` + "\n")
	b.WriteString(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","is_error":true,"content":"Error: password=hunter2 rejected"}]},"timestamp":"` + ts.UTC().Format(time.RFC3339) + `"}` + "\n")
	path := filepath.Join(root, encoded, id+".jsonl")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, ts, ts); err != nil {
		t.Fatal(err)
	}
	return root
}

// TestBuildPostmortemReportDestroyedFallback 已销毁会话：meta+history 兜底，
// 输出尾部退化到 transcript 尾读且敏感值遮蔽（P-108 必经路径）
func TestBuildPostmortemReportDestroyedFallback(t *testing.T) {
	setupNotifyTest(t)
	dir := `D:\pm-demo`
	started := time.Now().Add(-time.Hour)
	exited := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-pm-d", Dir: dir, Name: "死掉的会话", Runtime: "claude", ProjectID: "proj-pm",
		InitialPrompt: "把部署跑起来", ExitCode: 1, ExitedAt: exited, CreatedAt: started,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Get().TerminalHistory.Append("proj-pm", store.HistoryEntry{
		Command: "npm run deploy\n--verbose", ExitCode: 1, At: exited.Add(-time.Second), TerminalID: "agent-pm-d",
	}); err != nil {
		t.Fatal(err)
	}
	seedTranscript(t, dir, "trans-pm-1", exited.Add(-time.Second))

	rep, err := buildPostmortemReport("agent-pm-d")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Alive {
		t.Fatal("destroyed session must report alive=false")
	}
	if rep.ExitCode == nil || *rep.ExitCode != 1 {
		t.Fatalf("exitCode = %+v, want 1", rep.ExitCode)
	}
	if rep.Runtime != "claude" || rep.Name != "死掉的会话" || rep.InitialPrompt != "把部署跑起来" {
		t.Fatalf("meta fallback fields wrong: %+v", rep)
	}
	if len(rep.LastCommands) != 1 || rep.LastCommands[0].Command != "npm run deploy\n--verbose" {
		t.Fatalf("lastCommands wrong: %+v", rep.LastCommands)
	}
	if rep.OutputSource != "transcript" || rep.TranscriptID != "trans-pm-1" {
		t.Fatalf("tail source = %s (%s), want transcript", rep.OutputSource, rep.TranscriptID)
	}
	if !strings.Contains(rep.OutputTail, "[result(error)]") {
		t.Fatalf("tail must carry the failed tool result:\n%s", rep.OutputTail)
	}
	// P-108 遮蔽：sc?_ 令牌与 password= 赋值值段不得出现在报告中
	if strings.Contains(rep.OutputTail, "sc-abc123") || strings.Contains(rep.OutputTail, "hunter2") {
		t.Fatalf("sensitive values leaked in tail:\n%s", rep.OutputTail)
	}
	if !strings.Contains(rep.OutputTail, "token=***") || !strings.Contains(rep.OutputTail, "password=***") {
		t.Fatalf("mask placeholder missing:\n%s", rep.OutputTail)
	}

	// Markdown 形态：退出码 + 遮蔽后的尾部 + 末命令在位
	md := renderPostmortemMarkdown(rep)
	for _, want := range []string{"# Postmortem: 死掉的会话", "exit: **1**", "npm run deploy", "output tail (transcript"} {
		if !strings.Contains(md, want) {
			t.Fatalf("markdown missing %q:\n%s", want, md)
		}
	}
}

// TestBuildPostmortemReportTimeWindow transcript 时间窗匹配：窗口外（更晚的
// 并行会话）不得错挂到本会话报告
func TestBuildPostmortemReportTimeWindow(t *testing.T) {
	setupNotifyTest(t)
	dir := `/tmp/pm-window`
	exited := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-pm-w", Dir: dir, Name: "w", ExitCode: 2, ExitedAt: exited, CreatedAt: exited.Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	seedTranscript(t, dir, "trans-after", exited.Add(10*time.Minute)) // 退出后才活跃的会话

	rep, err := buildPostmortemReport("agent-pm-w")
	if err != nil {
		t.Fatal(err)
	}
	if rep.OutputTail != "" || rep.OutputSource != "" {
		t.Fatalf("out-of-window transcript must not be attached, got source=%s", rep.OutputSource)
	}
	// 报告对不可得尾部诚实标注（Markdown 侧）
	if !strings.Contains(renderPostmortemMarkdown(rep), postmortemTailUnavailableWord) {
		t.Fatal("unavailable wording missing")
	}
}

// TestBuildPostmortemReportNotFound 会话不在册且无 meta → 404 语义
func TestBuildPostmortemReportNotFound(t *testing.T) {
	setupNotifyTest(t)
	if _, err := buildPostmortemReport("agent-none"); err != errPostmortemNotFound {
		t.Fatalf("err = %v, want errPostmortemNotFound", err)
	}
}
