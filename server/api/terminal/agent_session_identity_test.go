package terminal

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/terminal"
)

// 会话身份与命名闭环（P-20261023-3）单测：同名消歧步进（先截断后去重）、
// 旗标形态判别、命名注记文本、rename 同名警示载荷。真实创建链全路
//（同任务两次创建派生名自动步进 / rename duplicate / 注记随 prompt 落地）
// 由 e2e session-identity.spec 守门；此处守纯函数出口

// TestDedupeAgentSessionName 同名消歧步进：无冲突原样、冲突步进 ·2/·3、
// 步进产物自身撞名继续步进、空名不步进
func TestDedupeAgentSessionName(t *testing.T) {
	// 无冲突：原样返回（不加 ·1）
	got := dedupeAgentSessionName("江西农商行-发现事件导出报告", map[string]bool{"别的会话": true})
	if got != "江西农商行-发现事件导出报告" {
		t.Fatalf("no-collision name should stay, got %q", got)
	}

	// 单冲突：步进 ·2
	got = dedupeAgentSessionName("审查任务", map[string]bool{"审查任务": true})
	if got != "审查任务·2" {
		t.Fatalf("collision should step to ·2, got %q", got)
	}

	// ·2 也被占：继续步进 ·3（同任务三连建不复用同后缀）
	got = dedupeAgentSessionName("审查任务", map[string]bool{"审查任务": true, "审查任务·2": true})
	if got != "审查任务·3" {
		t.Fatalf("·2 taken should step to ·3, got %q", got)
	}

	// 空名：不步进（调用方未派生出名字的保底形态）
	if got := dedupeAgentSessionName("", map[string]bool{"": true}); got != "" {
		t.Fatalf("empty base should stay empty, got %q", got)
	}
}

// TestDedupeAfterTruncation 先截断后去重的口径：24 rune 边界的派生名步进时
// 后缀叠加在「截断产物」上——边界不因消歧抖动（再截断回去是另一类 bug）
func TestDedupeAfterTruncation(t *testing.T) {
	long := strings.Repeat("审", 30)
	base := promptSessionName(long) // 24 rune + 省略号
	if got := dedupeAgentSessionName(base, map[string]bool{base: true}); got != base+"·2" {
		t.Fatalf("truncated base should step with suffix appended, got %q", got)
	}
}

// TestFlagFormLaunchArgs 旗标形态判别：--resume 首行旗标、prompt 非旗标、
// 前导空白行跳过、空串非旗标
func TestFlagFormLaunchArgs(t *testing.T) {
	if !flagFormLaunchArgs("--resume abc-123") {
		t.Fatal("--resume should be flag form")
	}
	if !flagFormLaunchArgs("\n  --resume abc-123") {
		t.Fatal("flag after blank lines should be flag form")
	}
	if flagFormLaunchArgs("修复登录页") {
		t.Fatal("prompt should not be flag form")
	}
	if flagFormLaunchArgs("") {
		t.Fatal("empty launchArgs should not be flag form")
	}
	// 修复后跟旗标行：首非空行是 prompt → 非 flag 形态（只看首行）
	if flagFormLaunchArgs("修复登录页\n--resume x") {
		t.Fatal("only the first non-empty line decides")
	}
}

// TestAgentNamingNoteLine 命名注记：恒单行、双语言、携会话寻址与查重指引
func TestAgentNamingNoteLine(t *testing.T) {
	zh := agentNamingNoteLine("zh-CN")
	en := agentNamingNoteLine("en-US")
	for _, note := range []string{zh, en} {
		if strings.Contains(note, "\n") {
			t.Fatalf("note must stay single line: %q", note)
		}
		if !strings.Contains(note, "$CC_TERMINAL_ID") {
			t.Fatalf("note must carry session addressing: %q", note)
		}
		if !strings.Contains(note, "GET /api/terminals") {
			t.Fatalf("note must carry dedup guidance: %q", note)
		}
		if !strings.HasPrefix(note, "[") {
			t.Fatalf("note must be visibly marked as system note: %q", note)
		}
	}
	if !strings.Contains(zh, "系统注记") {
		t.Fatalf("zh note should be Chinese: %q", zh)
	}
	if !strings.Contains(en, "System note") {
		t.Fatalf("en note should be English: %q", en)
	}
	// 非 zh 系回落英文（与默认会话名 lang 约定一致）
	if agentNamingNoteLine("") != en {
		t.Fatal("empty lang should fall back to English")
	}
}

// TestWithAgentNamingNote 注入门控（P-20261023-3）：开关关/旗标形态/纯 shell/
// 空注入均原样不注入；开 + prompt 形态在尾部附单行注记（首行派生名不受影响）
func TestWithAgentNamingNote(t *testing.T) {
	const prompt = "修复登录页跳转问题"

	// 默认开 + prompt：注入（尾部一行，注记在原文之后）
	got, injected := withAgentNamingNote(prompt, true, false, "zh-CN")
	if !injected {
		t.Fatal("note should be injected for prompt launchArgs")
	}
	if !strings.HasPrefix(got, prompt+"\n") {
		t.Fatalf("note must be appended after original prompt, got %q", got)
	}
	if strings.Count(got, "\n") != 1 {
		t.Fatalf("injection must add exactly one line, got %q", got)
	}

	// 注入不毁首行派生（promptSessionName 语义边界）
	if promptSessionName(got) != prompt {
		t.Fatalf("first-line derivation must survive injection, got %q", promptSessionName(got))
	}

	// 开关关：原样
	if got, injected := withAgentNamingNote(prompt, false, false, ""); injected || got != prompt {
		t.Fatalf("disabled note must pass through, got %q injected=%v", got, injected)
	}
	// 旗标形态：不注入（--resume 无 prompt 可注记）
	if _, injected := withAgentNamingNote("--resume abc", true, false, ""); injected {
		t.Fatal("flag-form launchArgs must not be annotated")
	}
	// 纯 shell：不注入（注记进命令行即成待执行文本）
	if _, injected := withAgentNamingNote(prompt, true, true, ""); injected {
		t.Fatal("shell runtime must not be annotated")
	}
	// 空注入：不注入
	if _, injected := withAgentNamingNote("", true, false, ""); injected {
		t.Fatal("empty launchArgs must not be annotated")
	}
}

// TestDuplicateAgentSessions rename 同名警示载荷：同名其余 agent 会话入列
// （排除自身、排除不同名、排除项目会话），携带创建时间与最近活动
func TestDuplicateAgentSessions(t *testing.T) {
	now := time.Now()
	list := []*terminal.Session{
		{ID: "agent-a", Name: "同名会话", Kind: "agent", CreatedAt: now},
		{ID: "agent-b", Name: "同名会话", Kind: "agent", CreatedAt: now.Add(-time.Hour)},
		{ID: "agent-c", Name: "别的名字", Kind: "agent", CreatedAt: now},
		{ID: "agent-self", Name: "同名会话", Kind: "agent", CreatedAt: now},
		{ID: "tmux-x", Name: "同名会话", Kind: "shell", CreatedAt: now},
	}

	dups := duplicateAgentSessions("agent-self", "同名会话", list)
	if len(dups) != 2 {
		t.Fatalf("want 2 duplicates (self/other-name/shell excluded), got %d: %v", len(dups), dups)
	}
	ids := map[string]bool{dups[0]["id"].(string): true, dups[1]["id"].(string): true}
	if !ids["agent-a"] || !ids["agent-b"] {
		t.Fatalf("duplicates should carry the same-named agent ids: %v", dups)
	}
	for _, d := range dups {
		if _, ok := d["createdAt"]; !ok {
			t.Fatalf("duplicate payload must carry createdAt: %v", d)
		}
	}

	// 无重名：空载荷（rename 响应不带 duplicate 键的判定面）
	if got := duplicateAgentSessions("agent-self", "独一无二的名称", list); got != nil {
		t.Fatalf("no duplicates should return nil, got %v", got)
	}
	// 空名不对照（binding required 已挡空名，防御性兜底）
	if got := duplicateAgentSessions("agent-self", "  ", list); got != nil {
		t.Fatalf("blank name should return nil, got %v", got)
	}
}
