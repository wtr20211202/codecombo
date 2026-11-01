package agentops

import (
	"testing"

	"codecombo/server/config"
	"codecombo/server/userbin"
)

// 测试共用的注册表清理：同步链路写的是全局注册表，结束后摘除自定义段，
// 不污染同包其他用例（内置注册不受 SyncCustomAgents 影响，无需恢复）
func cleanupCustomAgents(t *testing.T) {
	t.Cleanup(func() { SyncCustomAgents(nil) })
}

func TestSyncCustomAgentsRegistersAndReplaces(t *testing.T) {
	cleanupCustomAgents(t)

	SyncCustomAgents([]config.CustomAgent{
		{Name: "gemini", DisplayName: "Gemini CLI", Command: "gemini --yolo"},
		{Name: "aider", Command: "aider --model ollama/x"},
		{Name: "", Command: "broken"},  // 脏数据：空名跳过
		{Name: "empty", Command: "  "}, // 脏数据：空命令跳过
	})

	names := ProviderNames()
	if len(names) != 5 { // claude / dsh / codex + gemini / aider
		t.Fatalf("注册表应含 3 内置 + 2 自定义，实际 %v", names)
	}
	if !IsRegisteredProvider("gemini") || !IsRegisteredProvider("aider") {
		t.Fatal("自定义运行时应已注册")
	}

	// 注册顺序：内置在前，自定义按配置顺序追加在后
	if names[3] != "gemini" || names[4] != "aider" {
		t.Fatalf("自定义段应按配置顺序追加在内置之后，实际 %v", names)
	}

	// Runtimes 快照携带交互命令（选型与清单的数据源）
	rts := Runtimes()
	var found *RuntimeInfo
	for i := range rts {
		if rts[i].Name == "gemini" {
			found = &rts[i]
		}
	}
	if found == nil || found.DefaultCommand != "gemini --yolo" {
		t.Fatalf("Runtimes 应返回自定义命令，实际 %+v", found)
	}

	// 整体换血：同步空列表只摘自定义段，内置不动
	SyncCustomAgents(nil)
	if IsRegisteredProvider("gemini") || IsRegisteredProvider("aider") {
		t.Fatal("同步空列表后自定义运行时应摘除")
	}
	if !IsRegisteredProvider("claude") || !IsRegisteredProvider("codex") || !IsRegisteredProvider("dsh") {
		t.Fatal("内置运行时不得受自定义同步影响")
	}
}

func TestSyncCustomAgentsReplacesStaleEntries(t *testing.T) {
	cleanupCustomAgents(t)

	SyncCustomAgents([]config.CustomAgent{{Name: "old", Command: "old-cli"}})
	SyncCustomAgents([]config.CustomAgent{{Name: "new", Command: "new-cli"}})

	if IsRegisteredProvider("old") {
		t.Fatal("配置中已删除的旧自定义运行时不应残留")
	}
	if !IsRegisteredProvider("new") {
		t.Fatal("新配置的自定义运行时应注册")
	}
}

// 选型链路端到端：显式名 + 自定义命令 → InteractiveLaunchCommand 返回该命令。
// 用 git 作探测可用的替身命令（系统级依赖，测试环境必有）；不可用环境跳过
func TestCustomProviderInteractiveLaunchCommand(t *testing.T) {
	cleanupCustomAgents(t)

	if !userbin.Available("git") {
		t.Skip("git not available in test environment")
	}
	SyncCustomAgents([]config.CustomAgent{{Name: "myagent", Command: "git status"}})

	rt, cmd, ok := InteractiveLaunchCommand("myagent")
	if !ok || rt != "myagent" || cmd != "git status" {
		t.Fatalf("选型应返回自定义命令，实际 rt=%q cmd=%q ok=%v", rt, cmd, ok)
	}
}

func TestCustomBinName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"gemini --yolo", "gemini"},
		{"  aider  --model x ", "aider"},
		{`"C:\Program Files\tool.exe" --x`, `"C:\Program`}, // 引号路径取词限制：文档化行为，不做引号解析
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := CustomBinName(c.in); got != c.want {
			t.Errorf("CustomBinName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
