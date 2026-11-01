package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/claudesessions"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// P-20261031-1：Claude 会话 Active 判定的终端注册表校正三档 + resume id 提取

func TestParseResumeSessionID(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"--resume abc12345-1111-2222-3333-444455556666", "abc12345-1111-2222-3333-444455556666"},
		{"claude --resume=ABC12345-1111", "abc12345-1111"},
		{"claude -r abc12345-1111", "abc12345-1111"},
		{"claude --resume abcdef12-1111-2222", "abcdef12-1111-2222"},
		{"实现登录功能", ""}, // prompt 形态非旗标
		{"", ""},
		{"--resume", ""},                // 无目标
		{"--resume short", ""},          // 非 UUID 形态（<8 hex 起始位）
		{"--resumex abcdef12-1111", ""}, // 旗标名须整词
	}
	for _, c := range cases {
		if got := parseResumeSessionID(c.in); got != c.want {
			t.Errorf("parseResumeSessionID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 平台诚实断言（不按 GOOS 跳过——各平台断言各自为真的语义）：尾分隔符与冗余
// 段由 filepath.Clean 双平台归一（POSIX 尾 / 与 Windows 尾 \ 各自平台语义）；
// 大小写折叠仅 Windows（盘符路径不敏感语义），Linux/mac 大小写敏感必须保形
func TestNormalizeClaudeDir(t *testing.T) {
	if normalizeClaudeDir(`/tmp/x/`) != normalizeClaudeDir(`/tmp/x`) {
		t.Error("trailing separator variants should normalize equal")
	}
	if normalizeClaudeDir("") != "" {
		t.Error("empty stays empty")
	}
	if runtime.GOOS == "windows" {
		if normalizeClaudeDir(`D:\p\sub\`) != normalizeClaudeDir(`d:\p\sub`) {
			t.Error("windows case/trailing-separator variants should normalize equal (case-insensitive dir identity)")
		}
	} else {
		// 大小写敏感文件系统：字母不同 = 两个真实存在的不同目录，折叠即错并
		if normalizeClaudeDir(`/tmp/X`) == normalizeClaudeDir(`/tmp/x`) {
			t.Error("case-sensitive platforms must not fold distinct dirs")
		}
	}
}

func stubTerminalSessions(t *testing.T, sessions []*terminal.Session) {
	t.Helper()
	prev := terminalSessionsLister
	terminalSessionsLister = func() []*terminal.Session { return sessions }
	t.Cleanup(func() { terminalSessionsLister = prev })
}

func newAssocTestStore(t *testing.T) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
}

func TestBuildClaudeActiveRegistry(t *testing.T) {
	newAssocTestStore(t)
	metas := []store.AgentSessionMeta{
		{ID: "agent-1", Runtime: "claude", InitialPrompt: "--resume aaaa1111-1111-1111-1111-111111111111"},
		{ID: "agent-2", Runtime: "claude", InitialPrompt: "实现登录功能"}, // 新会话无 resume 旗标
		{ID: "agent-3", Runtime: "shell"},
		// agent-4 有活终端但 meta 尚未落库（异步毫秒窗）：只降级精确关联
	}
	docStore := store.Get()
	for _, m := range metas {
		if err := docStore.AgentSession.Save(m); err != nil {
			t.Fatal(err)
		}
	}
	stubTerminalSessions(t, []*terminal.Session{
		{ID: "agent-1", Path: `D:\proj-a`},
		{ID: "agent-2", Path: `D:\proj-a`},
		{ID: "agent-3", Path: `D:\proj-b`},
		{ID: "agent-4", Path: `D:\proj-c`},
	})

	reg := buildClaudeActiveRegistry()
	if got := reg.liveResume["aaaa1111-1111-1111-1111-111111111111"]; got != "agent-1" {
		t.Fatalf("liveResume[resume-id] = %q, want agent-1", got)
	}
	if len(reg.liveResume) != 1 {
		t.Fatalf("liveResume size = %d, want 1 (prompt 形态/非 claude/meta 缺席均不挂精确关联)", len(reg.liveResume))
	}
	// 活终端 id 全量在册（档 2 对账底线）：shell runtime 与 meta 缺席会话同样
	// 「活着」，漏记会让档 2 误翻正在写入的会话
	for _, id := range []string{"agent-1", "agent-2", "agent-3", "agent-4"} {
		if !reg.liveTerminalIDs[id] {
			t.Errorf("liveTerminalIDs[%s] = false, want true (all live terminals)", id)
		}
	}
	if !reg.liveClaudeDirs[normalizeClaudeDir(`D:\proj-a`)] {
		t.Error("proj-a should be a live claude dir (agent-1/agent-2)")
	}
	if reg.liveClaudeDirs[normalizeClaudeDir(`D:\proj-b`)] {
		t.Error("shell runtime session must not mark claude dir")
	}
	if reg.liveClaudeDirs[normalizeClaudeDir(`D:\proj-c`)] {
		t.Error("meta-missing session must not mark claude dir")
	}
}

func TestApplyClaudeActiveCorrection(t *testing.T) {
	newAssocTestStore(t)
	now := time.Now()
	fresh := now.Add(-30 * time.Second) // 90s 窄档内
	stale := now.Add(-2 * time.Minute)  // 90s 外、5min 宽档内
	ancient := now.Add(-72 * time.Hour) // 宽档外（扫描层本就判非活跃）

	liveID := "aaaa1111-1111-1111-1111-111111111111"
	deadID := "bbbb2222-2222-2222-2222-222222222222"
	// 持久关联：deadID 由 Codecombo 拉起过、终端已关；liveID 的终端还活着；
	// windowFresh/windowStale 关联终端仍活但 meta 未落库（创建链异步毫秒窗的
	// 判定形态）——档 2 不许翻非活跃（误翻正在写入的会话比僵尸态更糟），
	// 落档 3 窄档按 mtime 走
	windowFreshID := "gggg7777-7777-7777-7777-777777777777"
	windowStaleID := "hhhh8888-8888-8888-8888-888888888888"
	docStore := store.Get()
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	if err := docStore.ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, deadID), ID: deadID, TerminalID: "agent-dead", LaunchedAt: now.Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err := docStore.ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, windowFreshID), ID: windowFreshID, TerminalID: "agent-window-live", LaunchedAt: now.Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err := docStore.ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, windowStaleID), ID: windowStaleID, TerminalID: "agent-window-live", LaunchedAt: now.Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	reg := &claudeActiveRegistry{
		liveTerminalIDs: map[string]bool{"agent-window-live": true},
		liveResume:      map[string]string{liveID: "agent-live"},
		liveClaudeDirs:  map[string]bool{normalizeClaudeDir(`D:\live-dir`): true},
	}
	rows := []claudesessions.Session{
		{ID: liveID, Cwd: `D:\any`, LastAt: ancient, Active: false},                                        // 档1：活终端挂载，mtime 过期也翻活跃（长思考零误判）
		{ID: deadID, Cwd: `D:\any`, LastAt: fresh, Active: true},                                           // 档2：managed 死终端，mtime 再新也立即失活
		{ID: windowFreshID, Cwd: `D:\native-dir`, LastAt: fresh, Active: true},                             // 档2 不翻（终端 id 仍活）→ 档3 窄档内保持活跃
		{ID: windowStaleID, Cwd: `D:\native-dir`, LastAt: stale, Active: true},                             // 档2 不翻 → 档3 窄档收敛失活
		{ID: "cccc3333-3333-3333-3333-333333333333", Cwd: `D:\native-dir`, LastAt: stale, Active: true},    // 档3：原生+目录无活终端，窄档收敛
		{ID: "dddd4444-4444-4444-4444-444444444444", Cwd: `D:\native-dir`, LastAt: fresh, Active: true},    // 档3：窄档内保持活跃
		{ID: "eeee5555-5555-5555-5555-555555555555", Cwd: `D:\live-dir`, LastAt: stale, Active: true},      // 目录有活 claude 终端：宽档保持
		{ID: "ffff6666-6666-6666-6666-666666666666", Cwd: `D:\native-dir`, LastAt: ancient, Active: false}, // 宽档外本就非活跃，不动
	}
	assocs := loadClaudeAssocs(root)
	if assocs == nil || len(assocs) != 3 {
		t.Fatalf("assocs = %v, want 3 entries", assocs)
	}
	applyClaudeActiveCorrection(rows, reg, assocs, now)

	want := map[string]bool{
		liveID: true, deadID: false,
		windowFreshID: true, windowStaleID: false,
		"cccc3333-3333-3333-3333-333333333333": false,
		"dddd4444-4444-4444-4444-444444444444": true,
		"eeee5555-5555-5555-5555-555555555555": true,
		"ffff6666-6666-6666-6666-666666666666": false,
	}
	for _, s := range rows {
		if s.Active != want[s.ID] {
			t.Errorf("session %s Active = %v, want %v", s.ID[:8], s.Active, want[s.ID])
		}
	}

	// GC：超 TTL 死关联被清（liveResume 挂载中的豁免）——deadID 条目仅 1h 龄
	// 不及 TTL，另布 40 天龄的过期死关联与同龄活挂载关联各一
	expiredDeadID := "d0d0d0d0-0000-0000-0000-000000000000"
	if err := docStore.ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, expiredDeadID), ID: expiredDeadID, TerminalID: "agent-old", LaunchedAt: now.Add(-40 * 24 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if err := docStore.ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, liveID), ID: liveID, TerminalID: "agent-old", LaunchedAt: now.Add(-40 * 24 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	assocs = loadClaudeAssocs(root)
	applyClaudeActiveCorrection(rows, reg, assocs, now)
	if _, ok := assocs[expiredDeadID]; ok {
		t.Error("expired dead assoc should be GC'd")
	}
	if _, ok := loadClaudeAssocs(root)[liveID]; !ok {
		t.Error("live-mounted expired assoc must be exempt from GC")
	}
	if _, ok := loadClaudeAssocs(root)[deadID]; !ok {
		t.Error("non-expired assoc must survive GC")
	}
}

// 端点级：managed 会话在关联终端关闭后立即非活跃（僵尸「进行中」零延迟），
// 恢复入口随 active=false 放开——e2e 断言的数据面契约
func TestListClaudeSessionsActiveCorrectionEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/claude/sessions", ListClaudeSessions)

	zombieID := "bfbf1111-2222-3333-4444-555566667777"
	enc := claudesessions.EncodePath(`D:\zombie-proj`)
	dir := filepath.Join(root, enc)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := strings.Join([]string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"僵尸会话"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\zombie-proj"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"2026-01-01T00:01:00Z"}`,
	}, "\n") + "\n"
	path := filepath.Join(dir, zombieID+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-time.Minute) // mtime 在 5min 宽档内：扫描层判活跃
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
	// 持久关联在案、无活终端（listers stub 空）
	if err := store.Get().ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key: store.ClaudeAssocKey(root, zombieID), ID: zombieID, TerminalID: "agent-gone", LaunchedAt: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	stubTerminalSessions(t, nil)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Sessions []struct {
				ID     string `json:"id"`
				Active bool   `json:"active"`
				Title  string `json:"title"`
			} `json:"sessions"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, s := range body.Data.Sessions {
		if s.ID == zombieID && s.Active {
			t.Fatal("zombie session must be inactive immediately (managed, terminal closed)")
		}
	}
}
