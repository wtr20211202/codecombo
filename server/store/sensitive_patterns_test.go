package store_test

import (
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/mask"
	"codecombo/server/store"
)

// 自定义敏感模式在 store 层两个消费面的并入测试（P-20261006-11）：
// 命令历史整条跳过（IsSensitiveCommand/Append）+ 审计 Detail 入账脱敏
//（MaskAuditDetail）。注册表是进程态，用例自清回空防污染并行包内用例基线

func TestCustomSensitivePatterns_HistorySkip(t *testing.T) {
	t.Cleanup(func() { mask.SetCustomPatterns(nil) })
	if n := mask.SetCustomPatterns([]string{`MY_APP_TOKEN=.`}); n != 1 {
		t.Fatalf("SetCustomPatterns = %d, want 1", n)
	}

	s := store.New(filestore.New(filepath.Join(t.TempDir(), "data")))

	// 自定义模式命中：整条跳过（与通用词表同语义）
	cmd := "deploy MY_APP_TOKEN=abc123"
	if !store.IsSensitiveCommand(cmd) {
		t.Fatal("expected custom pattern to mark command sensitive")
	}
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: cmd}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	// 通用词表命中不受影响
	if !store.IsSensitiveCommand("export API_KEY=x9") {
		t.Fatal("builtin word list must stay effective")
	}
	// 未命中命令照常落盘
	normal := "echo hello"
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: normal}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 || got[0].Command != normal {
		t.Fatalf("expected only non-sensitive entry persisted, got %d", len(got))
	}

	// 清空注册表 = 回落纯通用表现状
	mask.SetCustomPatterns(nil)
	if store.IsSensitiveCommand(cmd) {
		t.Fatal("custom pattern must not match after reset")
	}
}

func TestCustomSensitivePatterns_AuditDetailMasked(t *testing.T) {
	t.Cleanup(func() { mask.SetCustomPatterns(nil) })
	if n := mask.SetCustomPatterns([]string{`(MY_APP_TOKEN=)([^ ]+)`}); n != 1 {
		t.Fatalf("SetCustomPatterns = %d, want 1", n)
	}

	// 有捕获组：组 1（键名+分隔符）保留可读，值段 ***
	if got := store.MaskAuditDetail("deploy MY_APP_TOKEN=abc123 ok"); got != "deploy MY_APP_TOKEN=*** ok" {
		t.Fatalf("MaskAuditDetail: %q", got)
	}
	// 通用词表赋值形态不受影响（兜底单点不变）
	if got := store.MaskAuditDetail("password=hunter2"); got != "password=***" {
		t.Fatalf("builtin assign form: %q", got)
	}

	mask.SetCustomPatterns(nil)
	if got := store.MaskAuditDetail("deploy MY_APP_TOKEN=abc123 ok"); got != "deploy MY_APP_TOKEN=abc123 ok" {
		t.Fatalf("custom pattern must not mask after reset: %q", got)
	}
}
