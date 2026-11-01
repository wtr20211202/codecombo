package config

import (
	"strings"
	"testing"
	"time"
)

// 审批分类规则判定（P-20261003-35）+ 全局档位三档化（P-20261003-316）：命中/
// 优先序/全局放行档位短路（含 24h 到期与会话级映射）/无规则默认 ask/大小写
// 不敏感/写入口校验。CreateAgentApproval 与 agentguard 中间件共用
// ResolveApprovalDecision，此处覆盖判定函数本身，接线行为在各自包内测试

// now 固定判定时刻（时间旅行注入：24h 到期用例据此构造过去/未来时刻）
var now = time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)

func TestResolveApprovalRule_Hit(t *testing.T) {
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "git push", Effect: ApprovalEffectAllow},
			{OpPattern: "reset", Effect: ApprovalEffectDeny},
		},
	}
	// 前缀命中：op 带尾随参数同样命中
	if dec := cfg.ResolveApprovalDecision("git push origin main", "", "", now); dec.Effect != ApprovalEffectAllow || dec.RuleHit != "git push" {
		t.Fatalf("git push expect allow + ruleHit, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("reset --hard HEAD~1", "", "", now); dec.Effect != ApprovalEffectDeny || dec.RuleHit != "reset" {
		t.Fatalf("reset expect deny + ruleHit, got %+v", dec)
	}
}

func TestResolveApprovalRule_FirstMatchWins(t *testing.T) {
	// 有序列表：首个命中生效——宽规则在前会遮蔽后续严规则（文档化语义）
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "git", Effect: ApprovalEffectAllow},
			{OpPattern: "git reset", Effect: ApprovalEffectDeny},
		},
	}
	if dec := cfg.ResolveApprovalDecision("git reset --hard", "", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("first match wins: expect allow, got %+v", dec)
	}

	// 严规则在前则先命中
	cfgStrictFirst := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "git reset", Effect: ApprovalEffectDeny},
			{OpPattern: "git", Effect: ApprovalEffectAllow},
		},
	}
	if dec := cfgStrictFirst.ResolveApprovalDecision("git reset --hard", "", "", now); dec.Effect != ApprovalEffectDeny {
		t.Fatalf("strict-first expect deny, got %+v", dec)
	}
}

func TestResolveApprovalRule_AllowModeShortCircuit(t *testing.T) {
	// 全局优先：永久档（历史 allow 值语义不变）时规则不评估（deny 规则也不生效
	// ——设置文案同语义）
	cfg := &ServerConfig{
		AgentApprovalMode: ApprovalModeAllow,
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "reset", Effect: ApprovalEffectDeny},
		},
	}
	dec := cfg.ResolveApprovalDecision("reset --hard", "", "", now)
	if dec.Effect != ApprovalEffectAllow || dec.RuleHit != "" {
		t.Fatalf("allow mode short-circuit: expect allow without ruleHit, got %+v", dec)
	}
}

func TestResolveApprovalRule_DefaultAsk(t *testing.T) {
	// 无规则 / 未命中 / 空表 → 默认 ask（= 现行审批卡流，行为与历史版本零差异）
	empty := &ServerConfig{}
	if dec := empty.ResolveApprovalDecision("git push", "", "", now); dec.Effect != ApprovalEffectAsk || dec.RuleHit != "" {
		t.Fatalf("no rules expect ask, got %+v", dec)
	}
	noHit := &ServerConfig{AgentApprovalRules: []AgentApprovalRule{{OpPattern: "push", Effect: ApprovalEffectAllow}}}
	if dec := noHit.ResolveApprovalDecision("git clean -fdx", "", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("no hit expect ask, got %+v", dec)
	}
	// 空串 op 防御：不参与匹配直接 ask
	if dec := empty.ResolveApprovalDecision("   ", "", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("blank op expect ask, got %+v", dec)
	}
}

func TestResolveApprovalRule_CaseInsensitiveAndDirtyRules(t *testing.T) {
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "  GIT PUSH  ", Effect: ApprovalEffectAllow}, // 首尾空白清洗 + 大小写不敏感
			{OpPattern: "", Effect: ApprovalEffectAllow},             // 空 pattern 跳过（空前缀会命中一切）
			{OpPattern: "rm", Effect: "bogus"},                       // 未知 effect 按未命中继续
		},
	}
	if dec := cfg.ResolveApprovalDecision("git push --force", "", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("case-insensitive prefix expect allow, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("rm -rf /", "", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("bogus effect expect fallthrough ask, got %+v", dec)
	}
	// 空白 pattern 在首位的病态表：不得遮蔽后续规则
	cfgEmpty := &ServerConfig{AgentApprovalRules: []AgentApprovalRule{
		{OpPattern: "", Effect: ApprovalEffectAllow},
		{OpPattern: "reset", Effect: ApprovalEffectDeny},
	}}
	if dec := cfgEmpty.ResolveApprovalDecision("reset --hard", "", "", now); dec.Effect != ApprovalEffectDeny {
		t.Fatalf("empty pattern must skip, got %+v", dec)
	}
}

// ---- 临时窗口（P-20261003-243）：到点惰性回 ask / 未到期照常 / nil=永久 ----

func TestResolveApprovalRule_TempWindow(t *testing.T) {
	future := now.Add(time.Hour)
	past := now.Add(-time.Minute)
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "git push", Effect: ApprovalEffectAllow, TempUntil: &future},
			{OpPattern: "git checkout", Effect: ApprovalEffectAllow, TempUntil: &past},
			{OpPattern: "reset", Effect: ApprovalEffectAllow}, // nil = 永久（存量形态）
		},
	}
	// 窗口内：规则照常生效
	if dec := cfg.ResolveApprovalDecision("git push origin main", "", "", now); dec.Effect != ApprovalEffectAllow || dec.RuleHit != "git push" {
		t.Fatalf("in-window expect allow + ruleHit, got %+v", dec)
	}
	// 到点：惰性回 ask——与到期物化后的规则形态（effect=ask）一致，命中即回
	// 不透传后续规则，RuleHit 照记留审计
	if dec := cfg.ResolveApprovalDecision("git checkout -b feat", "", "", now); dec.Effect != ApprovalEffectAsk || dec.RuleHit != "git checkout" {
		t.Fatalf("expired window expect ask + ruleHit, got %+v", dec)
	}
	// 无窗口规则不受时间影响（存量行为零差异）
	if dec := cfg.ResolveApprovalDecision("reset --hard", "", "", now.AddDate(1, 0, 0)); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("permanent rule expect allow, got %+v", dec)
	}
	// 到点边界：到点时刻本身仍在窗口内（!now.Before 口径），其后即过期
	boundary := &ServerConfig{AgentApprovalRules: []AgentApprovalRule{
		{OpPattern: "deploy", Effect: ApprovalEffectAllow, TempUntil: &future},
	}}
	if dec := boundary.ResolveApprovalDecision("deploy prod", "", "", future.Add(-time.Nanosecond)); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("just before expiry expect allow, got %+v", dec)
	}
	if dec := boundary.ResolveApprovalDecision("deploy prod", "", "", future); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("at expiry expect ask, got %+v", dec)
	}
	// 窗口过后放行不再复活：跨过终点后同一 op 恒回 ask（恢复语义是单向的，
	// 重新放行须用户显式再授予）
	if dec := cfg.ResolveApprovalDecision("git push --force", "", "", future.Add(time.Minute)); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("after window passed expect ask, got %+v", dec)
	}
}

func TestTempWindowExpired(t *testing.T) {
	future := now.Add(time.Hour)
	if (&AgentApprovalRule{}).TempWindowExpired(now) {
		t.Fatal("nil window must never expire")
	}
	r := &AgentApprovalRule{TempUntil: &future}
	if r.TempWindowExpired(now) {
		t.Fatal("future window must not be expired")
	}
	if !r.TempWindowExpired(future) {
		t.Fatal("at end instant must count as expired (!now.Before)")
	}
}

// ---- 全局档位三档化（P-20261003-316）：24h 到期 / 会话级映射 / 未知值回落 ----

func TestEffectiveApprovalMode_24hExpiry(t *testing.T) {
	cfg := &ServerConfig{
		AgentApprovalMode:      ApprovalModeAllow24h,
		AgentApprovalExpiresAt: now.Add(time.Hour),
	}
	if got := cfg.EffectiveApprovalMode(now); got != ApprovalModeAllow24h {
		t.Fatalf("before expiry expect allow-24h, got %q", got)
	}
	if dec := cfg.ResolveApprovalDecision("anything", "", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("unexpired 24h expect allow short-circuit, got %+v", dec)
	}
	// 到期：惰性回落 ask（含规则重获评估权——deny 规则重新生效）
	after := now.Add(2 * time.Hour)
	if got := cfg.EffectiveApprovalMode(after); got != ApprovalModeAsk {
		t.Fatalf("after expiry expect ask, got %q", got)
	}
	if dec := cfg.ResolveApprovalDecision("anything", "", "", after); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("expired 24h expect ask, got %+v", dec)
	}
	denied := &ServerConfig{
		AgentApprovalMode:      ApprovalModeAllow24h,
		AgentApprovalExpiresAt: now.Add(-time.Minute), // 已过期
		AgentApprovalRules:     []AgentApprovalRule{{OpPattern: "reset", Effect: ApprovalEffectDeny}},
	}
	if dec := denied.ResolveApprovalDecision("reset --hard", "", "", now); dec.Effect != ApprovalEffectDeny {
		t.Fatalf("expired 24h must re-evaluate rules, got %+v", dec)
	}
}

func TestEffectiveApprovalMode_24hDirtyExpiryFailsSafe(t *testing.T) {
	// 脏数据（24h 档位缺到期时刻）按已过期处理——失效方向朝 ask（安全侧），
	// 不允许「缺时限 = 永久放行」的隐式提权
	cfg := &ServerConfig{AgentApprovalMode: ApprovalModeAllow24h}
	if got := cfg.EffectiveApprovalMode(now); got != ApprovalModeAsk {
		t.Fatalf("24h without expiry must fail safe to ask, got %q", got)
	}
}

func TestResolveApprovalDecision_SessionScope(t *testing.T) {
	cfg := &ServerConfig{
		AgentApprovalMode: ApprovalModeAllowSession,
		AgentSessionAllows: map[string]time.Time{
			"sc-a": now,
			"sc-b": now, // 授予入口已 trim（GrantSessionAllow），键恒为裸会话 ID
		},
		AgentApprovalRules: []AgentApprovalRule{{OpPattern: "reset", Effect: ApprovalEffectDeny}},
	}
	// 映射内会话：短路放行（规则不评估）；查表侧对入参空白容忍（头/载荷来源）
	if dec := cfg.ResolveApprovalDecision("anything", "", "sc-a", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("granted session expect allow, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("anything", "", " sc-b ", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("granted session (padded lookup) expect allow, got %+v", dec)
	}
	// 映射外会话：不受会话级档位影响——走规则表（deny 命中仍拒）
	if dec := cfg.ResolveApprovalDecision("reset --hard", "", "sc-other", now); dec.Effect != ApprovalEffectDeny {
		t.Fatalf("other session expect rule deny, got %+v", dec)
	}
	// 无会话标识：退 ask（提案语义：会话级放行只覆盖可归属的会话）
	if dec := cfg.ResolveApprovalDecision("anything", "", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("no session id expect ask, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("anything", "", "   ", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("blank session id expect ask, got %+v", dec)
	}
}

func TestEffectiveApprovalMode_UnknownFallsBackAsk(t *testing.T) {
	// 空串/历史脏值回落 ask（旧行为兜底）；永久档不受时间影响
	for _, mode := range []string{"", "weird", ApprovalModeAsk} {
		cfg := &ServerConfig{AgentApprovalMode: mode}
		if got := cfg.EffectiveApprovalMode(now); got != ApprovalModeAsk {
			t.Fatalf("mode %q expect ask fallback, got %q", mode, got)
		}
	}
	perm := &ServerConfig{AgentApprovalMode: ApprovalModeAllow}
	if got := perm.EffectiveApprovalMode(now.AddDate(10, 0, 0)); got != ApprovalModeAllow {
		t.Fatalf("permanent mode must ignore time, got %q", got)
	}
}

func TestGrantRevokeSessionAllow(t *testing.T) {
	cfg := &ServerConfig{}
	cfg.GrantSessionAllow("sc-a", now)
	cfg.GrantSessionAllow("  sc-b  ", now.Add(time.Minute))
	if _, ok := cfg.AgentSessionAllows["sc-b"]; !ok {
		t.Fatal("grant must store trimmed session id")
	}
	if v := cfg.AgentSessionAllows["sc-a"]; !v.Equal(now) {
		t.Fatalf("grant timestamp = %v, want %v", v, now)
	}
	// 空白会话标识：授予为无害 no-op（判定侧同样退 ask）
	cfg.GrantSessionAllow("   ", now)
	if len(cfg.AgentSessionAllows) != 2 {
		t.Fatalf("blank grant must be ignored, got %v", cfg.AgentSessionAllows)
	}
	// 上限裁最旧：灌满 +1 后最旧授予被挤出
	for i := 0; i < ApprovalMaxSessionAllows; i++ {
		cfg.GrantSessionAllow(strings.Repeat("s", i+1), now.Add(time.Duration(i)*time.Second))
	}
	if len(cfg.AgentSessionAllows) > ApprovalMaxSessionAllows {
		t.Fatalf("cap exceeded: %d > %d", len(cfg.AgentSessionAllows), ApprovalMaxSessionAllows)
	}
	if _, ok := cfg.AgentSessionAllows["sc-a"]; ok {
		t.Fatal("oldest grant must be evicted beyond cap")
	}
	// 摘除幂等
	cfg.RevokeSessionAllow("sc-b")
	cfg.RevokeSessionAllow("sc-b")
	if _, ok := cfg.AgentSessionAllows["sc-b"]; ok {
		t.Fatal("revoke must remove entry")
	}
	cfg.RevokeSessionAllow("never-granted") // 不存在的条目不 panic
}

func TestValidateApprovalRules(t *testing.T) {
	if msg := ValidateApprovalRules(nil); msg != "" {
		t.Fatalf("nil rules expect pass, got %q", msg)
	}
	if msg := ValidateApprovalRules([]AgentApprovalRule{{OpPattern: "git push", Effect: ApprovalEffectAllow}}); msg != "" {
		t.Fatalf("valid rule expect pass, got %q", msg)
	}
	cases := []struct {
		rules []AgentApprovalRule
		want  string
	}{
		{[]AgentApprovalRule{{OpPattern: "  ", Effect: ApprovalEffectAllow}}, "opPattern is required"},
		{[]AgentApprovalRule{{OpPattern: strings_repeat(200), Effect: ApprovalEffectAllow}}, "opPattern too long"},
		{[]AgentApprovalRule{{OpPattern: "x", Effect: "maybe"}}, "invalid effect"},
		{make([]AgentApprovalRule, ApprovalMaxRules+1), "too many approval rules"},
	}
	for _, c := range cases {
		if msg := ValidateApprovalRules(c.rules); msg != c.want {
			t.Fatalf("validate = %q, want %q", msg, c.want)
		}
	}
}

func strings_repeat(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

// ---- 路径条件（P-20261004-67）：op 前缀 AND 路径 glob 双条件 ----

func TestResolveApprovalRule_PathConditionMatrix(t *testing.T) {
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "files.write", PathPattern: "docs/**", Effect: ApprovalEffectAllow},
		},
	}
	// op + 路径双命中 → 生效，RuleHit 注记带路径条件（审计可辨哪半个条件命中）
	dec := cfg.ResolveApprovalDecision("files.write", "docs/guide.md", "", now)
	if dec.Effect != ApprovalEffectAllow || dec.RuleHit != "files.write (path: docs/**)" {
		t.Fatalf("op+path hit expect allow with annotated ruleHit, got %+v", dec)
	}
	// 跨目录段：** 吞多段
	if dec := cfg.ResolveApprovalDecision("files.write", "docs/sub/deep/x.md", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("** must span directories, got %+v", dec)
	}
	// op 命中 + 路径不命中 → 按未命中回落 ask（不是整表短路成 allow）
	if dec := cfg.ResolveApprovalDecision("files.write", "src/main.go", "", now); dec.Effect != ApprovalEffectAsk || dec.RuleHit != "" {
		t.Fatalf("path miss must fall through to ask, got %+v", dec)
	}
	// op 不命中 → ask（与路径无关）
	if dec := cfg.ResolveApprovalDecision("files.delete", "docs/guide.md", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("op miss expect ask, got %+v", dec)
	}
	// 命令型 target 不参与路径判定（诚实边界）→ 该规则按未命中跳过
	if dec := cfg.ResolveApprovalDecision("files.write", "git add docs && git commit", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("command-shaped target must not match path rules, got %+v", dec)
	}
	// URL/绝对路径形态（agentguard 面的 /api/... target）同样不命中路径条件
	if dec := cfg.ResolveApprovalDecision("files.write", "/api/projects/x/files/write", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("absolute-path target must not match path rules, got %+v", dec)
	}
	// 空 target：带路径条件的规则按未命中跳过
	if dec := cfg.ResolveApprovalDecision("files.write", "", "", now); dec.Effect != ApprovalEffectAsk {
		t.Fatalf("empty target must not match path rules, got %+v", dec)
	}
}

func TestResolveApprovalRule_PathRulePriority(t *testing.T) {
	// 有序列表语义不变：路径规则在前 = 先试更窄条件，未中路径透传后面的宽规则
	//（「.env 永远 ask，其余写操作放行」的表达）
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{
			{OpPattern: "files.write", PathPattern: ".env*", Effect: ApprovalEffectAsk},
			{OpPattern: "files.write", Effect: ApprovalEffectAllow},
		},
	}
	dec := cfg.ResolveApprovalDecision("files.write", ".env.local", "", now)
	if dec.Effect != ApprovalEffectAsk || dec.RuleHit != "files.write (path: .env*)" {
		t.Fatalf("path-scoped ask must win, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("files.write", "docs/notes.md", "", now); dec.Effect != ApprovalEffectAllow || dec.RuleHit != "files.write" {
		t.Fatalf("path miss must pass through to broad allow, got %+v", dec)
	}
}

func TestResolveApprovalRule_LegacyRuleTargetAgnostic(t *testing.T) {
	// 存量兼容：PathPattern 缺省 = 不限路径——任意 target 形态（含命令型/分支名）
	// 行为与历史版本零变化
	cfg := &ServerConfig{
		AgentApprovalRules: []AgentApprovalRule{{OpPattern: "git push", Effect: ApprovalEffectAllow}},
	}
	if dec := cfg.ResolveApprovalDecision("git push origin main", "main", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("legacy rule must ignore target, got %+v", dec)
	}
	if dec := cfg.ResolveApprovalDecision("git push origin main", "", "", now); dec.Effect != ApprovalEffectAllow {
		t.Fatalf("legacy rule with empty target must still hit, got %+v", dec)
	}
}

func TestMatchPathGlob_Table(t *testing.T) {
	cases := []struct {
		pattern, p string
		want       bool
	}{
		// ** 跨目录段（零段消费 = 目录自身，见表后 glob 层直测——裸目录名单段
		// 无扩展名过不了路径形态守卫，不进本表）
		{"docs/**", "docs/a.md", true},
		{"docs/**", "docs/sub/b.md", true},
		{"docs/**", "docsx/a.md", false},
		{"docs/**", "do/a.md", false},
		// 前置 **：任意深度（含根）
		{"**/*.env", ".env", true},
		{"**/*.env", "a/.env", true},
		{"**/*.env", "a/b/.env", true},
		{"**/*.env", "a/env", false},
		// 中置 **：跨目录段
		{"src/**/x.go", "src/x.go", true},
		{"src/**/x.go", "src/a/b/x.go", true},
		{"src/**/x.go", "lib/x.go", false},
		// 单段通配
		{".env*", ".env", true},
		{".env*", ".env.local", true},
		{".env*", "config/.env", false}, // 单段模式只认根（任意深度须写 **/.env*，文档化语义）
		{"*.go", "main.go", true},
		{"*.go", "cmd/main.go", false},
		// 问号与字符类（path.Match 段内语法照常）
		{"file?.md", "file1.md", true},
		{"[abc].md", "b.md", true},
		// 归一：反斜杠 / ./ 前缀 / 大小写不敏感（与 op 前缀同口径，三平台一致）
		{"docs/**", "docs\\sub\\x.md", true},
		{"docs/**", "./docs/x.md", true},
		{"docs/**", "DOCS/X.MD", true},
		{"Docs/**", "docs/x.md", true},
		// 空段容错
		{"docs/**", "docs//x.md", true},
	}
	for _, c := range cases {
		rel := approvalTargetRelPath(c.p)
		if got := rel != "" && matchPathGlob(c.pattern, rel); got != c.want {
			t.Fatalf("matchPathGlob(%q, %q) = %v, want %v", c.pattern, c.p, got, c.want)
		}
	}
	// ** 零段消费：`docs/**` 在 glob 层匹配目录自身 `docs`
	if !matchPathGlob("docs/**", "docs") {
		t.Fatal("** must consume zero segments (match the directory itself)")
	}
}

func TestApprovalTargetRelPath(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"docs/x.md", "docs/x.md"},
		{"  docs/x.md  ", "docs/x.md"},       // trim
		{"docs\\sub\\x.md", "docs/sub/x.md"}, // 反斜杠归一
		{"./docs/x.md", "docs/x.md"},         // ./ 前缀剥离
		{"README.md", "README.md"},           // 单段带扩展名 = 路径形态
		{"main", ""},                         // 单段无扩展名 = 分支名
		{"Makefile", ""},
		{"git push origin main", ""},  // 空白 = 命令行形态
		{"/api/projects/x/files", ""}, // 绝对路径（agentguard URL 面）
		{"https://x/y.md", ""},        // URL
		{"C:\\temp\\x.md", ""},        // 盘符绝对路径
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := approvalTargetRelPath(c.in); got != c.want {
			t.Fatalf("approvalTargetRelPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestValidateApprovalRules_PathPattern(t *testing.T) {
	// 合法 glob 与缺省形态放行（空白经归一 = 不限路径）
	if msg := ValidateApprovalRules([]AgentApprovalRule{
		{OpPattern: "files.write", PathPattern: "docs/**", Effect: ApprovalEffectAllow},
		{OpPattern: "files.write", PathPattern: "  ", Effect: ApprovalEffectAsk},
		{OpPattern: "files.write", PathPattern: "docs\\**", Effect: ApprovalEffectAsk}, // 反斜杠归一后合法
	}); msg != "" {
		t.Fatalf("valid path patterns expect pass, got %q", msg)
	}
	cases := []struct {
		rule AgentApprovalRule
		want string
	}{
		{AgentApprovalRule{OpPattern: "x", PathPattern: strings.Repeat("a", ApprovalPathMax+1), Effect: ApprovalEffectAsk}, "pathPattern too long"},
		{AgentApprovalRule{OpPattern: "x", PathPattern: "docs/[a", Effect: ApprovalEffectAsk}, "invalid pathPattern glob"}, // 未闭合字符类
	}
	for _, c := range cases {
		if msg := ValidateApprovalRules([]AgentApprovalRule{c.rule}); msg != c.want {
			t.Fatalf("validate(%+v) = %q, want %q", c.rule, msg, c.want)
		}
	}
}
