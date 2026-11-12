package terminal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// agent 会话自动命名（P-20261111-6 S1）单测：资格判定 / 命名策略 / transcript
// 归属（恢复链精确 + 新会话候选唯一）/ 敏感抑制 / 手动改名永不覆盖 / 同名
// 消歧与振荡守卫 / 幂等已决。观察器 autoNameTick 直调（不经 kernel 调度），
// 会话注册表与名集合取数口走既有 stub 惯例（terminalSessionsLister /
// autoNameTakenNames），transcript 根走 CC_CLAUDE_DIR 覆盖

// setupAutoNameTest 装配：临时 store + 临时 claude projects 根 + stub 清理
func setupAutoNameTest(t *testing.T) string {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	prevTaken := autoNameTakenNames
	autoNameTakenNames = func() map[string]bool { return map[string]bool{} }
	t.Cleanup(func() { autoNameTakenNames = prevTaken })
	resetAutoNameResolved(t)
	return root
}

// resetAutoNameResolved 清空已决表（包级内存态，用例间隔离）
func resetAutoNameResolved(t *testing.T) {
	t.Helper()
	autoNameResolved.Lock()
	autoNameResolved.ids = make(map[string]bool)
	autoNameResolved.Unlock()
	t.Cleanup(func() {
		autoNameResolved.Lock()
		autoNameResolved.ids = make(map[string]bool)
		autoNameResolved.Unlock()
	})
}

// stubAutoNameSessions 注册会话注册表 stub（claude_sessions_active_test 同款
// stubTerminalSessions 直接复用）
func stubAutoNameSessions(t *testing.T, sessions []*terminal.Session) {
	t.Helper()
	stubTerminalSessions(t, sessions)
}

// writeAutoNameTranscript 在 claude projects 根下按 EncodePath 写 fixture
// transcript（cwd 取会话路径；timestamp 为 ISO 时刻），返回文件路径
func writeAutoNameTranscript(t *testing.T, root, sessionPath, id, timestamp, firstMessage string) string {
	t.Helper()
	dir := filepath.Join(root, claudesessions.EncodePath(sessionPath))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, id+".jsonl")
	escapedCwd := strings.ReplaceAll(sessionPath, `\`, `\\`)
	line := fmt.Sprintf(`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":%s},"timestamp":%q,"cwd":%q}`,
		mustJSONString(firstMessage), timestamp, escapedCwd)
	if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// mustJSONString 字符串转 JSON 字面量（消息文本含引号/换行时的确定性编码）
func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestAutoNameTitleFromMessage(t *testing.T) {
	// 单行原样
	if got := autoNameTitleFromMessage("修复登录页跳转问题"); got != "修复登录页跳转问题" {
		t.Fatalf("single line = %q", got)
	}
	// 多行取首行（转写首条消息可携换行——「去换行」口径）
	if got := autoNameTitleFromMessage("修复登录页跳转问题\n附带截图"); got != "修复登录页跳转问题" {
		t.Fatalf("multi-line should take first line, got %q", got)
	}
	// 首行全空白跳到次行
	if got := autoNameTitleFromMessage("  \n真正的内容"); got != "真正的内容" {
		t.Fatalf("blank first line skipped, got %q", got)
	}
	// 控制字符折叠为空格（promptSessionName 同款）
	if got := autoNameTitleFromMessage("审查\x01这段\t代码"); got != "审查 这段 代码" {
		t.Fatalf("control chars folded, got %q", got)
	}
	// 超 40 rune 截断加省略号（rune 计，中文不截半字）
	long := strings.Repeat("审", 45)
	want := strings.Repeat("审", 40) + "…"
	if got := autoNameTitleFromMessage(long); got != want {
		t.Fatalf("long = %q, want %q", got, want)
	}
	// 恰 40 rune 不加省略号
	if got := autoNameTitleFromMessage(strings.Repeat("审", 40)); got != strings.Repeat("审", 40) {
		t.Fatalf("40-rune stays as-is, got %q", got)
	}
	// 空/全空白：不派生
	if got := autoNameTitleFromMessage(""); got != "" {
		t.Fatalf("empty = %q", got)
	}
	if got := autoNameTitleFromMessage(" \n\t "); got != "" {
		t.Fatalf("blank = %q", got)
	}
}

func TestAutoNameEligible(t *testing.T) {
	cases := []struct {
		name string
		meta *store.AgentSessionMeta
		want bool
	}{
		{"meta 缺失", nil, false},
		{"非 claude 运行时（dsh/codex 显式豁免）", &store.AgentSessionMeta{Runtime: "codex", Derived: true}, false},
		{"shell 降级", &store.AgentSessionMeta{Runtime: "shell", Derived: true}, false},
		{"显式命名（Derived=false）", &store.AgentSessionMeta{Runtime: "claude"}, false},
		{"手动改名过（Named=true）", &store.AgentSessionMeta{Runtime: "claude", Derived: true, Named: true}, false},
		{"敏感标记", &store.AgentSessionMeta{Runtime: "claude", Derived: true, Sensitive: true}, false},
		{"prompt 派生名（再改名零增益）", &store.AgentSessionMeta{Runtime: "claude", Derived: true, InitialPrompt: "审查 useCrossReview 实现"}, false},
		{"恢复旗标创建（缺省形态）", &store.AgentSessionMeta{Runtime: "claude", Derived: true, InitialPrompt: "--resume abcd1234-1111"}, true},
		{"无注入（缺省形态）", &store.AgentSessionMeta{Runtime: "claude", Derived: true}, true},
	}
	for _, c := range cases {
		if got := autoNameEligible(c.meta); got != c.want {
			t.Errorf("%s: eligible = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestAutoNameTickRenamesFromTranscript 全链正向：无注入 claude 会话 + 首条
// 用户消息落盘 → 会话名/meta 名随派生标题更新（Named 保持 false——自动名不是
// 用户意志，不进槽位继承源）
func TestAutoNameTickRenamesFromTranscript(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-1", Runtime: "claude", Derived: true, Name: "Terminal 1",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "e1111111-1111-4111-8111-111111111111",
		time.Now().Format(time.RFC3339), "修复 update 看门狗竞态\n补充：从 S7 用例复现")
	s := &terminal.Session{ID: "agent-1", Kind: terminal.KindAgent, Name: "Terminal 1", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()

	if s.Name != "修复 update 看门狗竞态" {
		t.Fatalf("session name = %q, want transcript first message summary", s.Name)
	}
	meta, err := store.Get().AgentSession.Get("agent-1")
	if err != nil || meta == nil {
		t.Fatalf("meta missing: %v", err)
	}
	if meta.Name != "修复 update 看门狗竞态" {
		t.Fatalf("meta name = %q", meta.Name)
	}
	if meta.Named {
		t.Fatal("auto name must not set Named (用户意志判据，不进槽位继承源)")
	}
	if !autoNameResolvedIds()["agent-1"] {
		t.Fatal("renamed session should be marked resolved (免重复派生)")
	}

	// 二轮幂等：已决会话不重派生不重广播（即便转写续写新消息，首条不变）
	writeAutoNameTranscript(t, root, sessionPath, "e1111111-1111-4111-8111-111111111111",
		time.Now().Format(time.RFC3339), "修复 update 看门狗竞态\n补充：从 S7 用例复现\n追加内容")
	autoNameTick()
	if s.Name != "修复 update 看门狗竞态" {
		t.Fatalf("resolved session renamed again: %q", s.Name)
	}
}

// TestAutoNameTickWaitsForFirstMessage 首条用户消息尚未落盘（只有无消息行）：
// 不改名不标记已决，落盘后的下一轮改名
func TestAutoNameTickWaitsForFirstMessage(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-2", Runtime: "claude", Derived: true, Name: "Terminal 2",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	// 只有 last-prompt 行：无用户消息
	transcriptDir := filepath.Join(root, claudesessions.EncodePath(sessionPath))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(transcriptDir, "f2222222-2222-4222-8222-222222222222.jsonl"),
		[]byte(`{"type":"last-prompt","timestamp":"`+time.Now().Format(time.RFC3339)+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &terminal.Session{ID: "agent-2", Kind: terminal.KindAgent, Name: "Terminal 2", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "Terminal 2" {
		t.Fatalf("no first message yet: name = %q, want unchanged", s.Name)
	}
	if len(autoNameResolvedIds()) != 0 {
		t.Fatal("not-yet-named session must not be marked resolved (要等首条消息)")
	}

	// 首条消息落盘：下一轮改名
	writeAutoNameTranscript(t, root, sessionPath, "f2222222-2222-4222-8222-222222222222",
		time.Now().Format(time.RFC3339), "重构 sessionSnapshot 广播链")
	autoNameTick()
	if s.Name != "重构 sessionSnapshot 广播链" {
		t.Fatalf("after first message: name = %q", s.Name)
	}
}

// TestAutoNameTickRespectsManualRename 手动改名过（Named=true）永不覆盖
func TestAutoNameTickRespectsManualRename(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-3", Runtime: "claude", Derived: true, Named: true, Name: "我的调查会话",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "a3333333-3333-4333-8333-333333333333",
		time.Now().Format(time.RFC3339), "修复 update 看门狗竞态")
	s := &terminal.Session{ID: "agent-3", Kind: terminal.KindAgent, Name: "我的调查会话", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "我的调查会话" {
		t.Fatalf("manual rename must never be overridden, got %q", s.Name)
	}
}

// TestAutoNameTickSkipsSensitiveFirstMessage 首句命中敏感模式：不自动命名且
// 标记已决（transcript 头部不可变，抑制结论稳定，不逐轮重试）
func TestAutoNameTickSkipsSensitiveFirstMessage(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-4", Runtime: "claude", Derived: true, Name: "Terminal 4",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "b4444444-4444-4444-8444-444444444444",
		time.Now().Format(time.RFC3339), "帮我看看 token=sca_abcdef123456 怎么失效了")
	s := &terminal.Session{ID: "agent-4", Kind: terminal.KindAgent, Name: "Terminal 4", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "Terminal 4" {
		t.Fatalf("sensitive first message must not become session name, got %q", s.Name)
	}
	if !autoNameResolvedIds()["agent-4"] {
		t.Fatal("sensitive suppression should be marked resolved (稳定事实不重试)")
	}
}

// TestAutoNameTickOldTranscriptNotAttributed 早于终端创建的 transcript 是别的
// 会话的旧对话：不归属不错名
func TestAutoNameTickOldTranscriptNotAttributed(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-5", Runtime: "claude", Derived: true, Name: "Terminal 5",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "c5555555-5555-4555-8555-555555555555",
		createdAt.Add(-time.Hour).Format(time.RFC3339), "上一个会话的任务主题")
	s := &terminal.Session{ID: "agent-5", Kind: terminal.KindAgent, Name: "Terminal 5", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "Terminal 5" {
		t.Fatalf("stale transcript must not be attributed, got %q", s.Name)
	}
}

// TestAutoNameTickAmbiguousCandidatesSkip 同目录两个可归属候选（并发第二个
// claude 终端/原生 claude）：归属不明整轮放弃——不命名好过错名
func TestAutoNameTickAmbiguousCandidatesSkip(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-6", Runtime: "claude", Derived: true, Name: "Terminal 6",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Format(time.RFC3339)
	writeAutoNameTranscript(t, root, sessionPath, "d6666666-6666-4666-8666-666666666666", now, "甲主题")
	writeAutoNameTranscript(t, root, sessionPath, "e6666666-6666-4666-8666-666666666666", now, "乙主题")
	s := &terminal.Session{ID: "agent-6", Kind: terminal.KindAgent, Name: "Terminal 6", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "Terminal 6" {
		t.Fatalf("ambiguous candidates must be skipped, got %q", s.Name)
	}
	if len(autoNameResolvedIds()) != 0 {
		t.Fatal("skipped-for-ambiguity must not be marked resolved (候选减少后仍可命名)")
	}
}

// TestAutoNameTickResumeExactAttribution 恢复链精确归属：InitialPrompt 的
// --resume <id> 直接定位 transcript，同目录其他新 transcript 不干扰
func TestAutoNameTickResumeExactAttribution(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	rid := "abcd1234-1111-4111-8111-111111111111"
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-7", Runtime: "claude", Derived: true, Name: "Terminal 7",
		Dir: sessionPath, CreatedAt: createdAt, InitialPrompt: "--resume " + rid,
	}); err != nil {
		t.Fatal(err)
	}
	// 恢复目标 transcript（首条时间戳早于本终端创建——恢复的旧对话，精确归属
	// 不吃 CreatedAt 过滤）+ 同目录另一条更晚的新 transcript（干扰项）
	writeAutoNameTranscript(t, root, sessionPath, rid,
		createdAt.Add(-2*time.Hour).Format(time.RFC3339), "原始对话的任务主题")
	writeAutoNameTranscript(t, root, sessionPath, "f7777777-7777-4777-8777-777777777777",
		time.Now().Format(time.RFC3339), "干扰主题")
	s := &terminal.Session{ID: "agent-7", Kind: terminal.KindAgent, Name: "Terminal 7", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "原始对话的任务主题" {
		t.Fatalf("resume session should be named from resumed transcript, got %q", s.Name)
	}
}

// TestAutoNameApplyDedupesCollisionAndNoOscillation 同名消歧：派生名撞存量
// 会话名步进「·2」；改名后派生名==现名（自身不算占用）不再步进——防逐轮
// 「X→X·2→X·3」振荡
func TestAutoNameApplyDedupesCollisionAndNoOscillation(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-8", Runtime: "claude", Derived: true, Name: "Terminal 8",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "a8888888-8888-4888-8888-888888888888",
		time.Now().Format(time.RFC3339), "撞名主题")
	s := &terminal.Session{ID: "agent-8", Kind: terminal.KindAgent, Name: "Terminal 8", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})
	prevTaken := autoNameTakenNames
	// 生产语义：liveAgentSessionNames 返回全部在册 agent 会话名（含自身）——
	// stub 动态带自身现名，才能复现「自身占用未剔除→步进振荡」的病理
	autoNameTakenNames = func() map[string]bool { return map[string]bool{"撞名主题": true, s.Name: true} }
	t.Cleanup(func() { autoNameTakenNames = prevTaken })

	autoNameTick()
	if s.Name != "撞名主题·2" {
		t.Fatalf("collision should step to ·2, got %q", s.Name)
	}

	// 二轮：派生名撞「他人占用的 X」但自身现名是 X·2——自身占用已剔除，
	// 步进产物 X·2 可用且==现名 → 幂等跳过，不再步进到 X·3
	autoNameTick()
	if s.Name != "撞名主题·2" {
		t.Fatalf("oscillation guard failed, got %q (want 撞名主题·2 stable)", s.Name)
	}
}

// TestAutoNameTickEqualDerivedNameNoOp 名字已等于派生名（重启后已决表丢失）：
// 幂等无操作，不重广播不重写 meta
func TestAutoNameTickEqualDerivedNameNoOp(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-9", Runtime: "claude", Derived: true, Name: "已是派生名的会话",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "b9999999-9999-4999-8999-999999999999",
		time.Now().Format(time.RFC3339), "已是派生名的会话")
	s := &terminal.Session{ID: "agent-9", Kind: terminal.KindAgent, Name: "已是派生名的会话", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	autoNameTick()
	if s.Name != "已是派生名的会话" {
		t.Fatalf("equal name must stay, got %q", s.Name)
	}
	if !autoNameResolvedIds()["agent-9"] {
		t.Fatal("equal-no-op should be marked resolved")
	}
}

// autoNameResolvedIds 已决表快照（测试断言用）
func autoNameResolvedIds() map[string]bool {
	autoNameResolved.Lock()
	defer autoNameResolved.Unlock()
	out := make(map[string]bool, len(autoNameResolved.ids))
	for id := range autoNameResolved.ids {
		out[id] = true
	}
	return out
}

// TestAutoNameTickDisabledBySetting 总开关（P-20261111-6 S2）：显式关闭 =
// 观察器整体旁路——不改名、不标记已决（重开后的会话从头走资格链）；重开
// 后下一轮按首条消息恢复命名（开关是唯一闸，关闭期间落盘的首条消息不丢）
func TestAutoNameTickDisabledBySetting(t *testing.T) {
	root := setupAutoNameTest(t)
	sessionPath := t.TempDir()
	createdAt := time.Now().Add(-time.Minute)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-s2", Runtime: "claude", Derived: true, Name: "Terminal 12",
		Dir: sessionPath, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	writeAutoNameTranscript(t, root, sessionPath, "c2000000-0000-4000-8000-000000000012",
		time.Now().Format(time.RFC3339), "开关关闭期间不得自动命名")
	s := &terminal.Session{ID: "agent-s2", Kind: terminal.KindAgent, Name: "Terminal 12", Path: sessionPath, CreatedAt: createdAt}
	stubAutoNameSessions(t, []*terminal.Session{s})

	// 就地改写 + 清理复位：settingsRepo 无文档时回落 config.Load() 全局单例，
	// 残留指针会跨用例泄漏（terminal_history_test 同坑）；复位为 nil = 未配置
	// 默认开，对全部读端语义等价
	t.Cleanup(func() { store.Get().Settings.Get().Server.AgentAutoNameEnabled = nil })
	off := false
	store.Get().Settings.Get().Server.AgentAutoNameEnabled = &off

	autoNameTick()
	if s.Name != "Terminal 12" {
		t.Fatalf("disabled toggle renamed: %q", s.Name)
	}
	if len(autoNameResolvedIds()) != 0 {
		t.Fatal("disabled toggle must not mark resolved")
	}

	// 重开（显式 true）：下一轮命名，关闭期间落盘的首条消息照常消费
	on := true
	store.Get().Settings.Get().Server.AgentAutoNameEnabled = &on
	autoNameTick()
	if s.Name != "开关关闭期间不得自动命名" {
		t.Fatalf("re-enabled toggle should rename, got %q", s.Name)
	}
}

// TestAutoNameEnabledStoreNil 观察器开关的装配窗语义：store 未装配 = 关
// （无 meta 面无以为继，与 autoNameTick 既有 store nil 静默跳过同语义）
func TestAutoNameEnabledStoreNil(t *testing.T) {
	prev := store.Get()
	store.SetDefault(nil)
	t.Cleanup(func() { store.SetDefault(prev) })
	if autoNameEnabled() {
		t.Fatal("store nil must disable the observer")
	}
}
