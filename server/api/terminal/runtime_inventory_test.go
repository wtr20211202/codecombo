package terminal

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// RuntimeInventory 形态契约（P-20261003-317 抽取自 ListAgentRuntimes 循环，
// 环境体检「agent 运行时」条目同源消费）：注册序非空、行字段名齐全——
// agentops 内置 provider（claude/codex/dsh）在任何环境都注册，可用性与版本
// 随环境变化不作断言
func TestRuntimeInventoryShape(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	rows := RuntimeInventory()
	if len(rows) == 0 {
		t.Fatal("RuntimeInventory returned no rows (builtin providers must always register)")
	}
	seen := map[string]bool{}
	for _, r := range rows {
		if r.Name == "" {
			t.Fatal("row with empty name")
		}
		if seen[r.Name] {
			t.Fatalf("duplicate runtime name %q", r.Name)
		}
		seen[r.Name] = true
	}
}
