package mask

import (
	"strings"
	"testing"
)

// 自定义敏感模式注册表单测（P-20261006-11）：注入/清空/遮蔽/命中判定 +
// 坏条目兜底跳过。全局注册表是进程态——用例自清（t.Cleanup 回空），防污染
// 同包其他用例的基线

func TestSetCustomPatterns_MaskAndMatch(t *testing.T) {
	t.Cleanup(func() { SetCustomPatterns(nil) })

	if n := SetCustomPatterns([]string{`(MY_APP_TOKEN=)([^ ]+)`, "scrt_[A-Za-z0-9]{20,}"}); n != 2 {
		t.Fatalf("compiled count = %d, want 2", n)
	}
	// 有捕获组：第 1 组（键名+分隔符）保留可读，值段 ***
	if got := MaskText("deploy MY_APP_TOKEN=abc123 now"); got != "deploy MY_APP_TOKEN=*** now" {
		t.Fatalf("MaskText custom hit: %q", got)
	}
	// 无捕获组：命中段整段 ***
	if got := MaskText("uploading scrt_a1B2c3D4e5F6g7H8A9B2 done"); got != "uploading *** done" {
		t.Fatalf("MaskText token form: %q", got)
	}
	if !MatchCustom("x MY_APP_TOKEN=zzz x") {
		t.Fatal("MatchCustom want true")
	}
	// 空列表 = 纯通用表现状零变化
	if got := SetCustomPatterns(nil); got != 0 {
		t.Fatalf("reset count = %d, want 0", got)
	}
	if got := MaskText("deploy MY_APP_TOKEN=abc123 now"); got != "deploy MY_APP_TOKEN=abc123 now" {
		t.Fatalf("reset must fall back to builtin-only: %q", got)
	}
	if MatchCustom("x MY_APP_TOKEN=zzz x") {
		t.Fatal("MatchCustom after reset want false")
	}
}

func TestSetCustomPatterns_BadEntrySkipped(t *testing.T) {
	t.Cleanup(func() { SetCustomPatterns(nil) })

	// 一条坏正则不拖累其余条目（写侧已校验，此处是存量脏数据兜底）
	if n := SetCustomPatterns([]string{"(unclosed", `scrt_[A-Za-z0-9]{20,}`}); n != 1 {
		t.Fatalf("compiled count = %d, want 1 (bad entry skipped)", n)
	}
	if got := MaskText("x scrt_a1B2c3D4e5F6g7H8A9B2 y"); got != "x *** y" {
		t.Fatalf("good entry after bad one: %q", got)
	}
}

func TestMaskCustom_LiteralReplacementNoDollarExpansion(t *testing.T) {
	t.Cleanup(func() { SetCustomPatterns(nil) })

	// 值里的 $ 不做替换展开（ReplaceAllLiteralString 对齐 TS replace 的字面 '***'）
	if n := SetCustomPatterns([]string{`HINT_[A-Z]+`}); n != 1 {
		t.Fatalf("compiled count = %d, want 1", n)
	}
	if got := MaskText("HINT_ABC and $1 signs stay"); got != "*** and $1 signs stay" {
		t.Fatalf("literal replacement: %q", got)
	}
}

func TestMaskApprovalText_CustomFlowsThrough(t *testing.T) {
	t.Cleanup(func() { SetCustomPatterns(nil) })

	// 审批面链条打底 MaskText——自定义模式自动并入（消费点零改动面）
	if n := SetCustomPatterns([]string{`scrt_[A-Za-z0-9]{20,}`}); n != 1 {
		t.Fatalf("compiled count = %d, want 1", n)
	}
	got := MaskApprovalText("key scrt_a1B2c3D4e5F6g7H8A9B2 ok")
	if strings.Contains(got, "scrt_a1B2") {
		t.Fatalf("custom pattern leaked into approval text: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("mask missing: %q", got)
	}
}
