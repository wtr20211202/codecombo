package agentcron

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 指标抽取单测（P-20261005-237）：规则校验矩阵 / 数值抽取矩阵（正则 + JSON
// 两形态）/ 完成回执链集成（watch 落定后落点、无命中如实不落点）

func TestValidateExtract(t *testing.T) {
	cases := []struct {
		in   string
		want string // 期望归一后的存储值（err 非空时不校验）
		err  string // 期望错误子串（空 = 合法）
	}{
		{"", "", ""},
		{"  ", "", ""},
		{`(?:build in) (?P<sec>[0-9.]+)s`, `(?:build in) (?P<sec>[0-9.]+)s`, ""},
		{" (?P<v>\\d+) ", `(?P<v>\d+)`, ""}, // 前后空白归一
		{"json:duration.seconds", "json:duration.seconds", ""},
		{" json:build.ms ", "json:build.ms", ""},
		// 坏形态：保存口拒收的四类
		{"(?P<sec>[0-9.]+", "", "not a valid regex"},           // 编译失败
		{"(?:build in) ([0-9.]+)s", "", "named capture group"}, // 无命名组
		{"json:", "", "path is empty"},                         // 空路径
		{"json:duration..ms", "", "empty segment"},             // 空段
		{"json:build. .ms", "", "empty segment"},               // 空白段
		{strings.Repeat("a", 300), "", "too long"},             // 超长
	}
	for _, tc := range cases {
		got := tc.in
		msg := validateExtract(&got)
		if tc.err == "" {
			if msg != "" {
				t.Fatalf("rule %q: unexpected error %q", tc.in, msg)
			}
			if got != tc.want {
				t.Fatalf("rule %q normalized to %q, want %q", tc.in, got, tc.want)
			}
			continue
		}
		if msg == "" || !strings.Contains(msg, tc.err) {
			t.Fatalf("rule %q: error = %q, want contains %q", tc.in, msg, tc.err)
		}
	}
}

func TestExtractMetricName(t *testing.T) {
	cases := []struct{ rule, want string }{
		{`(?:build in) (?P<sec>[0-9.]+)s`, "sec"},
		{`(?P<first>\d+) (?P<second>\d+)`, "first"}, // 多命名组取首个
		{"json:duration.seconds", "seconds"},
		{"json:solo", "solo"},
		{"(?P<mb>[0-9]+)MB", "mb"},
		{"bogus(", ""}, // 坏形态理论不可达（保存口压实），防御性空串
	}
	for _, tc := range cases {
		if got := ExtractMetricName(tc.rule); got != tc.want {
			t.Fatalf("ExtractMetricName(%q) = %q, want %q", tc.rule, got, tc.want)
		}
	}
}

func TestExtractValue_Regex(t *testing.T) {
	const proposal = `(?:build in) (?P<sec>[0-9.]+)s`

	// 提案示例规则：命中
	if v, ok := extractValue(proposal, "done.\nbuild in 3.5s\nexit 0"); !ok || v != 3.5 {
		t.Fatalf("proposal rule: v=%v ok=%v, want 3.5/true", v, ok)
	}
	// 多命中自后向前取首个可解析（输出时序越靠后越新）
	if v, ok := extractValue(proposal, "build in 9.5s\nbuild in 3.5s"); !ok || v != 3.5 {
		t.Fatalf("last match wins: v=%v ok=%v, want 3.5/true", v, ok)
	}
	// 最后一条不可解析回落更早命中（汇总行偶发被截断不放弃整个窗口）
	if v, ok := extractValue(proposal, "build in 9.5s\nbuild in NAs"); !ok || v != 9.5 {
		t.Fatalf("fallback to earlier parseable: v=%v ok=%v, want 9.5/true", v, ok)
	}
	// 无命中 / 命中但捕获不可解析为数值 → false（「无数据」如实）
	if _, ok := extractValue(proposal, "all green"); ok {
		t.Fatal("no match must yield false")
	}
	if _, ok := extractValue(`(?P<sec>[a-z]+)`, "abc 12"); ok {
		t.Fatal("non-numeric capture must yield false")
	}
	// 负数形态
	if v, ok := extractValue(`(?P<d>-?[0-9.]+)ms`, "took -12.5ms"); !ok || v != -12.5 {
		t.Fatalf("negative value: v=%v ok=%v", v, ok)
	}
	// 命中值两侧空白容忍
	if v, ok := extractValue(`(?P<v>[0-9.]+)`, "  7  "); !ok || v != 7 {
		t.Fatalf("whitespace tolerated: v=%v ok=%v", v, ok)
	}
	// 空尾窗
	if _, ok := extractValue(proposal, ""); ok {
		t.Fatal("empty tail must yield false")
	}
	// 坏规则（保存口已压实，防御性兜底）→ false 不 panic
	if _, ok := extractValue("(", "build in 3.5s"); ok {
		t.Fatal("invalid regex must yield false")
	}
}

func TestExtractValue_JSON(t *testing.T) {
	// 整窗即 JSON 文档（嵌套路径）
	tail := `{"ok":true,"duration":{"seconds":42.5},"count":7}`
	if v, ok := extractValue("json:duration.seconds", tail); !ok || v != 42.5 {
		t.Fatalf("whole-tail nested: v=%v ok=%v", v, ok)
	}
	if v, ok := extractValue("json:count", tail); !ok || v != 7 {
		t.Fatalf("whole-tail leaf: v=%v ok=%v", v, ok)
	}
	// 末行 JSON 摘要（构建工具常见形态）：整窗解析失败逐行自尾向头兜底
	tail = "compile ok\nwarnings: 3\n{\"build_ms\": 1830}"
	if v, ok := extractValue("json:build_ms", tail); !ok || v != 1830 {
		t.Fatalf("last-line summary: v=%v ok=%v", v, ok)
	}
	// 数字字符串叶接受
	if v, ok := extractValue("json:mem", `{"mem":"128.5"}`); !ok || v != 128.5 {
		t.Fatalf("numeric string: v=%v ok=%v", v, ok)
	}
	// 路径缺键 / 非数值叶 / 候选全非 JSON → false
	if _, ok := extractValue("json:nope", tail); ok {
		t.Fatal("missing key must yield false")
	}
	if _, ok := extractValue("json:ok", `{"ok":true}`); ok {
		t.Fatal("boolean leaf must yield false")
	}
	if _, ok := extractValue("json:a.b", "not json at all"); ok {
		t.Fatal("non-JSON tail must yield false")
	}
	// 路径命中数组中间段（非 map）→ false
	if _, ok := extractValue("json:list.0", `{"list":[1,2]}`); ok {
		t.Fatal("array mid-path must yield false")
	}
}

func TestClampExtractTail(t *testing.T) {
	// 行数裁剪保尾
	var b strings.Builder
	for i := 0; i < 200; i++ {
		b.WriteString("line\n")
	}
	got := clampExtractTail(b.String())
	if n := len(strings.Split(got, "\n")); n != extractTailLines {
		t.Fatalf("line clamp: %d lines, want %d", n, extractTailLines)
	}
	// 字节预算裁剪保尾（多行各 1200B 的超长行）
	var c strings.Builder
	for i := 0; i < 100; i++ {
		c.WriteString(strings.Repeat("x", 1200) + "\n")
	}
	if n := len(clampExtractTail(c.String())); n > extractTailMaxBytes+1201 {
		t.Fatalf("byte clamp exceeded budget: %d", n)
	}
	// 空窗/尾换行归一
	if got := clampExtractTail(""); got != "" {
		t.Fatalf("empty tail: %q", got)
	}
	if got := clampExtractTail("a\n\n"); got != "a" {
		t.Fatalf("trailing newlines trimmed, got %q", got)
	}
}

// TestExtractMetricPoint_NoDataHonest 抽取失败如实不落点（无命中/空尾窗），
// 绝不硬凑 0——DiagSnapshot 零值隐藏同纪律
func TestExtractMetricPoint_NoDataHonest(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "无命中", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, Extract: `(?:build in) (?P<sec>[0-9.]+)s`})

	extractMetricPoint(created.ID, created.Extract, "agent-x", func(string) string { return "all green, nothing to extract" })
	if h := store.Get().CronMetric.History(created.ID, 0); len(h) != 0 {
		t.Fatalf("no-match must not append a point, got %+v", h)
	}

	extractMetricPoint(created.ID, created.Extract, "agent-x", func(string) string { return "" })
	if h := store.Get().CronMetric.History(created.ID, 0); len(h) != 0 {
		t.Fatalf("empty tail must not append a point, got %+v", h)
	}
	_ = env
}

// TestExtractMetricPoint_Hit 命中落点：数值/时刻齐备
func TestExtractMetricPoint_Hit(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "命中", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, Extract: `(?:build in) (?P<sec>[0-9.]+)s`})

	extractMetricPoint(created.ID, created.Extract, "agent-x", func(string) string {
		return "done\nbuild in 3.5s"
	})
	hist := store.Get().CronMetric.History(created.ID, 0)
	if len(hist) != 1 || hist[0].Value != 3.5 {
		t.Fatalf("expected one point 3.5, got %+v", hist)
	}
	if hist[0].At.IsZero() {
		t.Fatal("point should carry a timestamp")
	}
	_ = env
}

// TestPollWatches_ExtractOnDone 全链：完成回执落定 → 按触发时快照的规则抽取。
// 无规则任务零动作；失败回执同样抽取（构建失败也常打印耗时——有命中才落点）
func TestPollWatches_ExtractOnDone(t *testing.T) {
	env := newTestEnv(t)
	withRule := mustCreate(t, store.AgentCron{Name: "带规则", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, Extract: `(?:build in) (?P<sec>[0-9.]+)s`})
	noRule := mustCreate(t, store.AgentCron{Name: "无规则", Hour: 3, Minute: 0, Prompt: "p", Enabled: true})

	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{withRule, noRule}, now)

	// 尾窗桩：会话滚回里已有构建输出（会话 ID 形态 agent-<任务名>，与桩 launch 同）
	env.module.r.tailFn = func(sessionID string) string {
		if sessionID == "agent-带规则" {
			return "build in 12.5s"
		}
		return ""
	}

	seedProgress(t, "agent-带规则", "done", "完成", time.Now().Add(time.Minute))
	seedProgress(t, "agent-无规则", "done", "完成", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	hist := store.Get().CronMetric.History(withRule.ID, 0)
	if len(hist) != 1 || hist[0].Value != 12.5 {
		t.Fatalf("watch done should extract one point 12.5, got %+v", hist)
	}
	if h := store.Get().CronMetric.History(noRule.ID, 0); len(h) != 0 {
		t.Fatalf("task without rule must not gain points, got %+v", h)
	}

	// 失败回执同样抽取（有命中才落点）；试跑绕开当日去重（首跑已记 LastRunAt）
	if _, err := env.module.r.RunNow(withRule); err != nil {
		t.Fatalf("rerun: %v", err)
	}
	env.module.r.tailFn = func(string) string { return "build in 15.0s" }
	seedProgress(t, "agent-带规则", "failed", "退出码 1", time.Now().Add(2*time.Minute))
	env.module.r.pollWatches()

	hist = store.Get().CronMetric.History(withRule.ID, 0)
	if len(hist) != 2 || hist[0].Value != 15.0 {
		t.Fatalf("failed receipt should also extract, got %+v", hist)
	}
}
