package agentcron

// 自动接力单测（P-20261005-207）：三段复刻语义（结论挑选/保尾装箱/遮蔽）+
// 接力源解析（显式/latest 动态）+ trigger 接线（前言注入/降级回告/事实落库）。
// 接力源夹具落真实 SC_CLAUDE_DIR 根（session-relay.spec.ts 同款形态），mtime
// 控制活跃判定——activeWindow 由 claudesessions 包自持，测试只控制文件时间。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// seedTranscript 落一份最小 transcript（1 user + 1 assistant 文本），返回路径。
// age 控制文件 mtime（活跃判定与 latest 排序键）
func seedTranscript(t *testing.T, root, dirName, sid, conclusion string, age time.Duration) {
	t.Helper()
	dir := filepath.Join(root, dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"继续巡检"},"timestamp":"2026-10-07T10:00:00Z","cwd":"D:/proj-x"}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"` + conclusion + `"}]},"timestamp":"2026-10-07T10:05:00Z"}`,
	}, "\n") + "\n"
	path := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	idle := time.Now().Add(-age)
	if err := os.Chtimes(path, idle, idle); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
}

func newRelayEnv(t *testing.T) (root string) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	root = t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	return root
}

func TestPickRelaySummary(t *testing.T) {
	entries := []claudesessions.TimelineEntry{
		{Kind: "user", Text: "继续"},
		{Kind: "assistant", Text: "第一条结论"},
		{Kind: "tool", Tool: "Bash", Input: "ls"},
		{Kind: "assistant", Text: "  最终结论：全绿  "},
		{Kind: "result", Text: "ok", Status: "ok"},
	}
	// 尾部倒序第一条 assistant 文本（trim 后）；过程性条目不参与
	if got := pickRelaySummary(entries); got != "最终结论：全绿" {
		t.Fatalf("pickRelaySummary = %q", got)
	}
	// 纯工具会话/空窗口：空串由调用方走降级
	if got := pickRelaySummary([]claudesessions.TimelineEntry{
		{Kind: "user", Text: "继续"}, {Kind: "tool", Tool: "Bash", Input: "ls"},
	}); got != "" {
		t.Fatalf("no-assistant window should be empty, got %q", got)
	}
	if got := pickRelaySummary(nil); got != "" {
		t.Fatalf("nil window should be empty, got %q", got)
	}
}

func TestFitTailKeep(t *testing.T) {
	build := func(s string) string { return "head: " + s + " :tail" }
	// 预算内原样
	if got := fitTailKeep(build, "abc", 100); got != "head: abc :tail" {
		t.Fatalf("under budget = %q", got)
	}
	// 超预算：裁头保尾，… 前缀标注，收敛进预算
	const content = "0123456789abcdefghijklmnopqrstuvwxyz"
	got := fitTailKeep(build, content, 20)
	if !strings.HasPrefix(got, "head: …") || !strings.HasSuffix(got, " :tail") {
		t.Fatalf("tail-keep shape = %q", got)
	}
	if len(got) > 20 {
		t.Fatalf("fitTailKeep = %q (%d bytes), want ≤20", got, len(got))
	}
	if !strings.HasSuffix(got[:len(got)-len(" :tail")], "xyz") {
		t.Fatalf("tail of content should be kept, got %q", got)
	}
	// 多字节不腰斩：全 CJK 内容收敛后仍为合法 UTF-8
	cjk := fitTailKeep(build, strings.Repeat("结", 40), 24)
	if !strings.Contains(cjk, "结") || strings.Contains(cjk, "\xff") {
		t.Fatalf("cjk fit broke runes: %q", cjk)
	}
}

func TestResolveRelaySession(t *testing.T) {
	// 未配置：全部为空，调用方零动作
	if sid, led, reason := resolveRelaySession(store.AgentCron{}); sid != "" || led != nil || reason != "" {
		t.Fatalf("disabled relay should return empty triple, got %q/%v/%q", sid, led, reason)
	}
	root := newRelayEnv(t)
	// 显式会话 ID 原样透传（存在性在时间线读取时判定；台账经索引查取，
	// store 未初始化时该断言无法成立——环境先行）
	if sid, _, _ := resolveRelaySession(store.AgentCron{RelayFrom: "abc-123"}); sid != "abc-123" {
		t.Fatalf("explicit id = %q", sid)
	}

	const proj = "D:/proj-x"
	dirName := claudesessions.EncodePath(proj)
	seedTranscript(t, root, dirName, "11111111-1111-1111-1111-111111111111", "旧结论", 2*time.Hour)
	seedTranscript(t, root, dirName, "22222222-2222-2222-2222-222222222222", "新结论", 10*time.Minute)

	// latest：取项目内最近「已结束」（非活跃）会话
	t1, _, reason := resolveRelaySession(store.AgentCron{RelayFrom: store.CronRelayLatest, Dir: proj})
	if reason != "" || t1 != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("latest should pick newest ended session, got %q/%q", t1, reason)
	}

	// 最新会话活跃中（结论未定型）→ 跳过它取次新
	seedTranscript(t, root, dirName, "33333333-3333-3333-3333-333333333333", "进行中", 30*time.Second)
	t2, _, reason := resolveRelaySession(store.AgentCron{RelayFrom: store.CronRelayLatest, Dir: proj})
	if reason != "" || t2 != "22222222-2222-2222-2222-222222222222" {
		t.Fatalf("active head should be skipped, got %q/%q", t2, reason)
	}

	// 全活跃项目（独立目录避免与上一场景串）：无已结束会话 → 降级
	const hot = "D:/proj-hot"
	seedTranscript(t, root, claudesessions.EncodePath(hot), "55555555-5555-5555-5555-555555555555", "跑 A", 40*time.Second)
	seedTranscript(t, root, claudesessions.EncodePath(hot), "66666666-6666-6666-6666-666666666666", "跑 B", 5*time.Second)
	if sid, _, reason := resolveRelaySession(store.AgentCron{RelayFrom: store.CronRelayLatest, Dir: hot}); sid != "" || reason == "" {
		t.Fatalf("all-active project should degrade, got %q/%q", sid, reason)
	}

	// latest 无项目锚点（Dir 空）：无从谈「该项目」，如实降级
	if sid, _, reason := resolveRelaySession(store.AgentCron{RelayFrom: store.CronRelayLatest}); sid != "" || reason == "" {
		t.Fatalf("latest without dir should degrade, got %q/%q", sid, reason)
	}
	// 不存在的项目目录：同样降级
	if sid, _, reason := resolveRelaySession(store.AgentCron{RelayFrom: store.CronRelayLatest, Dir: "D:/no-such-proj"}); sid != "" || reason == "" {
		t.Fatalf("missing project should degrade, got %q/%q", sid, reason)
	}
}

func TestRelayPreface(t *testing.T) {
	// 未配置：零动作
	if preface, note := relayPreface(store.AgentCron{Prompt: "p"}, time.Now()); preface != "" || note != "" {
		t.Fatalf("disabled relay should be a no-op, got %q/%q", preface, note)
	}

	root := newRelayEnv(t)
	const sid = "aaaaaaaa-1111-1111-1111-111111111111"
	// 结论携密钥形态片段：装箱前遮蔽（P-108 同序）
	seedTranscript(t, root, claudesessions.EncodePath("D:/proj-x"), sid,
		`巡检完成，token=supersecret123 全部通过，遗留分片超时已登记`, time.Hour)

	slot := time.Date(2026, 10, 8, 2, 0, 0, 0, time.Local)
	tk := store.AgentCron{Name: "巡检", Prompt: "继续巡检", RelayFrom: sid}
	preface, note := relayPreface(tk, slot)
	if note != relayNoteOK {
		t.Fatalf("note = %q, want relayed", note)
	}
	if !strings.HasPrefix(preface, "Conclusions from the previous session: ") || !strings.HasSuffix(preface, ". Please continue.") {
		t.Fatalf("preface shape = %q", preface)
	}
	if strings.Contains(preface, "supersecret123") {
		t.Fatalf("preface must mask secrets, got %q", preface)
	}
	if !strings.Contains(preface, "全部通过") {
		t.Fatalf("conclusion body missing, got %q", preface)
	}
	// 总注入面不超配额（前言 + prompt 组装 + 连接空格）
	if total := len(preface) + 1 + len(ComposeLaunchArgs(tk.Prompt, slot)); total > launchArgsQuota {
		t.Fatalf("launchArgs total %d exceeds quota", total)
	}

	// 源会话不存在（显式指向被删会话的竞态）：降级、任务照常
	if preface, note := relayPreface(store.AgentCron{Prompt: "p", RelayFrom: "no-such-session"}, slot); preface != "" ||
		!strings.HasPrefix(note, relayNoteSkippedPrefix) {
		t.Fatalf("missing source should degrade, got %q/%q", preface, note)
	}

	// 源无 assistant 结论：降级
	emptySid := "bbbbbbbb-2222-2222-2222-222222222222"
	seedTranscript(t, root, claudesessions.EncodePath("D:/proj-x"), emptySid, "", time.Hour)
	if preface, note := relayPreface(store.AgentCron{Prompt: "p", RelayFrom: emptySid}, slot); preface != "" ||
		!strings.Contains(note, "no assistant conclusion") {
		t.Fatalf("no-conclusion source should degrade, got %q/%q", preface, note)
	}

	// prompt 已近配额：无预算容纳固定模板 → 如实降级（不硬挤爆注入面）
	fat := store.AgentCron{Prompt: strings.Repeat("p", 460), RelayFrom: sid}
	if preface, note := relayPreface(fat, slot); preface != "" || !strings.Contains(note, "budget") {
		t.Fatalf("no-budget should degrade, got %q/%q", preface, note)
	}
}

// trigger 接线：配置接力 → 前言注入 + relayed 账；降级 → 无前言照常发起 +
// skipped 账（定时任务不停摆）；未配置 → 接力账零触碰
func TestTrigger_RelayWiring(t *testing.T) {
	root := newRelayEnv(t)
	const sid = "cccccccc-3333-3333-3333-333333333333"
	seedTranscript(t, root, claudesessions.EncodePath("D:/proj-x"), sid, "上一棒结论：测试全绿", time.Hour)

	env := newTestEnv(t)
	// 三个任务同槽点（02:00）：runDue 一轮内分别走注入/未配置/降级三形态
	relay := mustCreate(t, store.AgentCron{Name: "自动续命", Hour: 2, Minute: 0, Prompt: "接着干", Enabled: true, RelayFrom: sid})
	bare := mustCreate(t, store.AgentCron{Name: "不接力", Hour: 2, Minute: 0, Prompt: "普通活", Enabled: true})
	dead := mustCreate(t, store.AgentCron{Name: "死源", Hour: 2, Minute: 0, Prompt: "还是干", Enabled: true, RelayFrom: "gone-session"})

	now := time.Date(2026, 10, 8, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{relay, bare, dead}, now)

	if len(env.snapshot()) != 3 {
		t.Fatalf("expect 3 launches, got %d", len(env.snapshot()))
	}
	byName := map[string]string{}
	for _, call := range env.snapshot() {
		byName[call.name] = call.launchArgs
	}
	// 注入：前言在前，任务 prompt 与计划戳在后
	if a := byName["自动续命"]; !strings.HasPrefix(a, "Conclusions from the previous session: ") ||
		!strings.Contains(a, "上一棒结论：测试全绿") || !strings.Contains(a, "接着干 [scheduled") {
		t.Fatalf("relay launchArgs = %q", a)
	}
	// 降级：无前言，任务照常（发起链零变化）
	if a := byName["死源"]; strings.Contains(a, "Conclusions from") || !strings.Contains(a, "还是干 [scheduled") {
		t.Fatalf("degraded launchArgs = %q", a)
	}
	if a := byName["不接力"]; strings.Contains(a, "Conclusions from") {
		t.Fatalf("bare launchArgs = %q", a)
	}

	if c := mustGet(t, relay.ID); c.LastRelayNote != relayNoteOK || c.LastRelayAt.IsZero() {
		t.Fatalf("relay task facts = %q/%v", c.LastRelayNote, c.LastRelayAt)
	}
	if c := mustGet(t, dead.ID); !strings.HasPrefix(c.LastRelayNote, relayNoteSkippedPrefix) || c.LastRelayAt.IsZero() {
		t.Fatalf("dead-source task facts = %q", c.LastRelayNote)
	}
	if c := mustGet(t, bare.ID); c.LastRelayNote != "" || !c.LastRelayAt.IsZero() {
		t.Fatalf("bare task must not touch relay facts, got %q/%v", c.LastRelayNote, c.LastRelayAt)
	}
}

// 台账附行（P-20261005-208）：源会话有 tool_use 台账 → 前言结论行前附一行
// 量化锚；无台账 → 前言形态与 P-207 既有形态完全一致（可选增强零回归）
func TestRelayPrefaceLedger(t *testing.T) {
	root := newRelayEnv(t)
	const proj = "D:/proj-x"
	dirName := claudesessions.EncodePath(proj)
	const sid = "dddddddd-4444-4444-4444-444444444444"
	// 1 写文件 + 2 命令 + 1 结果行（结果行不携带 tool_use，不计）
	body := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"干活"},"timestamp":"2026-10-07T10:00:00Z","cwd":"D:/proj-x"}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"D:/proj-x/a.go"}}]},"timestamp":"2026-10-07T10:01:00Z"}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"go build ./..."}}]},"timestamp":"2026-10-07T10:02:00Z"}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]},"timestamp":"2026-10-07T10:31:00Z"}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]},"timestamp":"2026-10-07T10:32:00Z"}`,
	}, "\n") + "\n"
	if err := os.MkdirAll(filepath.Join(root, dirName), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, dirName, sid+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	idle := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(root, dirName, sid+".jsonl"), idle, idle); err != nil {
		t.Fatal(err)
	}

	slot := time.Date(2026, 10, 8, 2, 0, 0, 0, time.Local)
	tk := store.AgentCron{Name: "带台账", Prompt: "接着干", RelayFrom: sid}

	// 冷索引（本轮无列表请求重建）：台账如实缺席，前言仍成立——可选增强不绑架主链
	preface, note := relayPreface(tk, slot)
	if note != relayNoteOK || strings.Contains(preface, "Session ledger") {
		t.Fatalf("cold index should omit ledger line, got %q/%q", preface, note)
	}

	// 预热索引（任意一次列表即重建台账聚合）→ 前言附台账行
	if _, err := claudesessions.NewIndex(store.Get().ClaudeIndex, root).List(proj, 10, 0); err != nil {
		t.Fatal(err)
	}
	preface, note = relayPreface(tk, slot)
	if note != relayNoteOK {
		t.Fatalf("note = %q", note)
	}
	if !strings.HasPrefix(preface, "Session ledger: 1 files written, 2 shell commands, 30m elapsed.\n") {
		t.Fatalf("ledger line missing/malformed: %q", preface)
	}
	if !strings.Contains(preface, "Conclusions from the previous session: ") {
		t.Fatalf("conclusion line missing after ledger: %q", preface)
	}
	// 总注入面不超配额（台账行在预算内预留，不挤爆注入面）
	if total := len(preface) + 1 + len(ComposeLaunchArgs(tk.Prompt, slot)); total > launchArgsQuota {
		t.Fatalf("launchArgs total %d exceeds quota", total)
	}

	// 台账行塞不下（任务 prompt 逼近配额，预算够固定模板但不够台账整行）：
	// 整行让位，结论照常注入
	suffixLen := len(ComposeLaunchArgs("", slot)) // [scheduled <时刻>] 固定尾缀
	tight := store.AgentCron{Name: "挤不下", Prompt: strings.Repeat("p", 500-1-62-suffixLen), RelayFrom: sid}
	preface, note = relayPreface(tight, slot)
	if note != relayNoteOK || strings.Contains(preface, "Session ledger") ||
		!strings.Contains(preface, "Conclusions from the previous session: ") {
		t.Fatalf("tight budget should drop ledger line but keep conclusion, got %q/%q", preface, note)
	}
	if total := len(preface) + 1 + len(ComposeLaunchArgs(tight.Prompt, slot)); total > launchArgsQuota {
		t.Fatalf("launchArgs total %d exceeds quota", total)
	}
}

func TestValidRelayFrom(t *testing.T) {
	for _, ok := range []string{"", store.CronRelayLatest, "abc-uuid"} {
		if !validRelayFrom(ok) {
			t.Fatalf("%q should be valid", ok)
		}
	}
	if validRelayFrom(strings.Repeat("x", cronRelayFromMax+1)) {
		t.Fatal("over-length relayFrom should be rejected")
	}
}
