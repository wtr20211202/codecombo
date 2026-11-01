package agentops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestInstallCodexDoc_MarkerBlock codex AGENTS.md 标记块：创建 → 幂等 →
// 原位更新且保留用户自有内容
func TestInstallCodexDoc_MarkerBlock(t *testing.T) {	// os.UserHomeDir 无法注入，改为直测块替换逻辑的核心路径：
	// 用临时目录模拟（installCodexDoc 依赖 home，这里抽等价流程验证）
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)  // Windows
	t.Setenv("HOME", home)         // Unix

	if err := installCodexDoc(); err != nil {
		t.Fatalf("first install: %v", err)
	}
	path := filepath.Join(home, ".codex", "AGENTS.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("AGENTS.md missing: %v", err)
	}
	first := string(data)
	if !strings.Contains(first, docBlockStart) || !strings.Contains(first, docBlockEnd) {
		t.Fatal("first install should contain marker block")
	}
	if !strings.Contains(first, "CC_LOCK_TOKEN") {
		t.Fatal("doc should mention CC_LOCK_TOKEN credential")
	}

	// 幂等：重写内容一致时不变化（mtime 不变由内容比对保证——这里验证无重复块）
	if err := installCodexDoc(); err != nil {
		t.Fatalf("second install: %v", err)
	}
	data, _ = os.ReadFile(path)
	if strings.Count(string(data), docBlockStart) != 1 {
		t.Fatalf("second install duplicated block: count=%d", strings.Count(string(data), docBlockStart))
	}

	// 用户自有内容保留：手工追加后重装，自有行必须在
	userLine := "my own precious notes"
	if err := os.WriteFile(path, []byte("user header\n\n"+string(data)+"\n"+userLine+"\n"), 0o644); err != nil {
		t.Fatalf("seed user content: %v", err)
	}
	if err := installCodexDoc(); err != nil {
		t.Fatalf("third install: %v", err)
	}
	data, _ = os.ReadFile(path)
	final := string(data)
	if !strings.Contains(final, "user header") {
		t.Error("user header lost after reinstall")
	}
	if !strings.Contains(final, userLine) {
		t.Error("user trailing notes lost after reinstall")
	}
	if strings.Count(final, docBlockStart) != 1 {
		t.Errorf("block count = %d, want 1", strings.Count(final, docBlockStart))
	}
}

// TestInstallClaudeMemory_MarkerBlock CLAUDE.md 常驻标记块：创建 → 幂等 →
// 原位更新且保留用户自有内容（与 codex AGENTS.md 同一套标记块语义）
func TestInstallClaudeMemory_MarkerBlock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home) // Windows
	t.Setenv("HOME", home)        // Unix

	if err := installClaudeMemory(); err != nil {
		t.Fatalf("first install: %v", err)
	}
	path := filepath.Join(home, ".claude", "CLAUDE.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("CLAUDE.md missing: %v", err)
	}
	first := string(data)
	if !strings.Contains(first, docBlockStart) || !strings.Contains(first, docBlockEnd) {
		t.Fatal("first install should contain marker block")
	}
	if !strings.Contains(first, "CC_TERMINAL_ID") {
		t.Fatal("memory should mention CC_TERMINAL_ID trigger")
	}

	// 幂等：重装无重复块
	if err := installClaudeMemory(); err != nil {
		t.Fatalf("second install: %v", err)
	}
	data, _ = os.ReadFile(path)
	if strings.Count(string(data), docBlockStart) != 1 {
		t.Fatalf("second install duplicated block: count=%d", strings.Count(string(data), docBlockStart))
	}

	// 用户自有内容保留：手工追加后重装，自有行必须在
	userLine := "my own precious notes"
	if err := os.WriteFile(path, []byte("user header\n\n"+string(data)+"\n"+userLine+"\n"), 0o644); err != nil {
		t.Fatalf("seed user content: %v", err)
	}
	if err := installClaudeMemory(); err != nil {
		t.Fatalf("third install: %v", err)
	}
	data, _ = os.ReadFile(path)
	final := string(data)
	if !strings.Contains(final, "user header") {
		t.Error("user header lost after reinstall")
	}
	if !strings.Contains(final, userLine) {
		t.Error("user trailing notes lost after reinstall")
	}
	if strings.Count(final, docBlockStart) != 1 {
		t.Errorf("block count = %d, want 1", strings.Count(final, docBlockStart))
	}
}

// selProvider 测试用 Provider（原定义于 runner_test.go，随 headless 核心移除迁至此）
type selProvider struct {
	name      string
	available bool
}

func (p *selProvider) Name() string          { return p.name }
func (p *selProvider) Available() bool       { return p.available }
func (p *selProvider) InteractiveCommand() (string, bool) { return p.name, true }

// TestInteractiveLaunchCommand 交互启动命令选型：指定运行时不可用时按
// SelectProviderByName 语义回退 auto（返回任一可用运行时），而非直接失败
func TestInteractiveLaunchCommand(t *testing.T) {
	RegisterProvider(&selProvider{name: "fake-term-a", available: true})
	RegisterProvider(&selProvider{name: "fake-term-b", available: false})

	name, cmd, ok := InteractiveLaunchCommand("fake-term-b")
	if !ok || name == "" || cmd == "" {
		t.Errorf("unavailable named runtime should fall back to an available one, got %q/%q/%v", name, cmd, ok)
	}
	name, cmd, ok = InteractiveLaunchCommand("fake-term-a")
	if !ok || name != "fake-term-a" || cmd != "fake-term-a" {
		t.Errorf("InteractiveLaunchCommand(fake-term-a) = %q/%q/%v", name, cmd, ok)
	}
	// 内置链至少一个可交互运行时（claude/dsh/codex 按环境）
	if _, _, ok := InteractiveLaunchCommand("auto"); !ok {
		t.Error("auto should find an interactive runtime in test env or builtin chain")
	}
}
