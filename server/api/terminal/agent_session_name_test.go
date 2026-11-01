package terminal

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// agent 会话以 prompt 摘要命名（P-20261003-12）：派生规则、命名优先级
// （显式命名 > prompt 摘要 > 槽位继承 > 序号默认名）与定时任务名不被覆盖

// TestPromptSessionName prompt 首行派生摘要名：截断、控制字符、旗标形态
func TestPromptSessionName(t *testing.T) {
	// 短 prompt 原样（首行）
	if got := promptSessionName("修复登录页跳转问题"); got != "修复登录页跳转问题" {
		t.Fatalf("short prompt = %q", got)
	}

	// 多行取首个非空行
	if got := promptSessionName("修复登录页跳转问题\n附带截图\n再补一条"); got != "修复登录页跳转问题" {
		t.Fatalf("multi-line should take first non-empty line, got %q", got)
	}
	if got := promptSessionName("\n\n  第二行才是内容\n第三行"); got != "第二行才是内容" {
		t.Fatalf("leading blank lines should be skipped, got %q", got)
	}

	// 超 24 rune 截断加省略号（中文按 rune 计，不截半字）
	long := strings.Repeat("审", 30)
	got := promptSessionName(long)
	want := strings.Repeat("审", 24) + "…"
	if got != want {
		t.Fatalf("long prompt = %q, want %q", got, want)
	}
	// 恰 24 rune 不加省略号
	if got := promptSessionName(strings.Repeat("审", 24)); got != strings.Repeat("审", 24) {
		t.Fatalf("24-rune prompt should stay as-is, got %q", got)
	}

	// 控制字符折叠为空格并去首尾空白（行内 \x01 控制符、\t 制表；\r\n 属行分隔）
	if got := promptSessionName("审查\x01这段\t代码"); got != "审查 这段 代码" {
		t.Fatalf("control chars should fold to space, got %q", got)
	}

	// 旗标形态（Claude 恢复链 --resume）非 prompt：不派生
	if got := promptSessionName("--resume abc-123"); got != "" {
		t.Fatalf("flag-like launchArgs should derive nothing, got %q", got)
	}

	// 空/全空白：不派生
	if got := promptSessionName(""); got != "" {
		t.Fatalf("empty launchArgs = %q", got)
	}
	if got := promptSessionName("  \r\n \t "); got != "" {
		t.Fatalf("blank launchArgs = %q", got)
	}
}

// TestResolveAgentSessionName 命名决策优先级：显式命名（含定时任务名 P-43）
// 不被覆盖；prompt 摘要优先于槽位继承；非 prompt 形态维持既有继承/序号链
func TestResolveAgentSessionName(t *testing.T) {
	setupRenameTest(t)
	now := time.Now()
	// 种一条用户手动命名的 claude 槽位记录（同目录）——继承源
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-old", Runtime: "claude", Dir: "D:/repo", Name: "旧命名",
		Named: true, NamedAt: now, CreatedAt: now,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// 显式命名优先：定时任务名 + prompt 同至，任务名不被覆盖（P-43 口径）
	if got := resolveAgentSessionName("夜间审查", "审查当日改动", "claude", "D:/repo", ""); got != "夜间审查" {
		t.Fatalf("explicit cron name must win, got %q", got)
	}

	// prompt 摘要优先于槽位继承：带 prompt 的新会话以摘要辨识，不吃旧命名
	if got := resolveAgentSessionName("", "审查 useCrossReview 实现", "claude", "D:/repo", ""); got != "审查 useCrossReview 实现" {
		t.Fatalf("prompt summary should win over inheritance, got %q", got)
	}

	// 非 prompt 形态（--resume 旗标）：维持既有继承链（同目录优先）
	if got := resolveAgentSessionName("", "--resume abc-123", "claude", "D:/repo", ""); got != "旧命名" {
		t.Fatalf("resume should inherit same-dir naming, got %q", got)
	}

	// 无 launchArgs 无继承：序号默认名（lang 空 = 英文）
	if got := resolveAgentSessionName("", "", "codex", "", ""); !strings.HasPrefix(got, "Terminal ") {
		t.Fatalf("no prompt no inherit should fall back to numbered name, got %q", got)
	}
}
