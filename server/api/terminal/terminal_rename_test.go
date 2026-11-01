package terminal

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupRenameTest 构造基于临时目录的 store 装配（命名落库/槽位继承单测用）
func setupRenameTest(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// TestSaveSessionDisplayNameUpsert 改名落库：meta 缺失补建（此前 IsPersistent
// 门控 + meta 缺失静默跳过，native 下改名随进程消亡必然丢失）；重复改名更新
// 同一条且不丢已有元数据
func TestSaveSessionDisplayNameUpsert(t *testing.T) {
	setupRenameTest(t)

	// meta 缺失：改名补建（native 会话的典型路径）
	createdAt := time.Now().Add(-time.Hour)
	saveSessionDisplayName("agent-1", "构建终端", "C:/work", "proj-1", createdAt)
	meta, err := store.Get().AgentSession.Get("agent-1")
	if err != nil || meta == nil {
		t.Fatalf("meta not saved: %v", err)
	}
	if meta.Name != "构建终端" || !meta.Named {
		t.Fatalf("name/named not saved: %+v", meta)
	}
	if meta.Dir != "C:/work" || meta.ProjectID != "proj-1" {
		t.Fatalf("dir/projectID not backfilled: %+v", meta)
	}
	if !meta.CreatedAt.Equal(createdAt) {
		t.Fatalf("createdAt mismatch: %v != %v", meta.CreatedAt, createdAt)
	}
	firstNamedAt := meta.NamedAt

	// 再次改名：更新同一条，既有 Runtime/StartHead/ProjectID 保留
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-1", Runtime: "claude", StartHead: "abc", ProjectID: "proj-1",
		Name: "构建终端", Named: true, NamedAt: firstNamedAt, CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	saveSessionDisplayName("agent-1", "部署终端", "C:/work", "", time.Time{})
	meta, _ = store.Get().AgentSession.Get("agent-1")
	if meta.Name != "部署终端" || !meta.Named {
		t.Fatalf("rename not updated: %+v", meta)
	}
	if meta.Runtime != "claude" || meta.StartHead != "abc" {
		t.Fatalf("existing meta fields lost: %+v", meta)
	}
	if !meta.NamedAt.After(firstNamedAt) {
		t.Fatalf("namedAt not refreshed: %v", meta.NamedAt)
	}
	// 既有 ProjectID 不被会话空值回填清掉（upsert 保留语义）
	if meta.ProjectID != "proj-1" {
		t.Fatalf("projectID lost: %+v", meta)
	}
}

// TestInheritDisplayName 槽位名继承：项目按 ProjectID、agent 按运行时（同目录
// 优先），只认用户手动命名（Named），多条命中取 NamedAt 最新
func TestInheritDisplayName(t *testing.T) {
	setupRenameTest(t)
	now := time.Now()
	mustSave := func(m store.AgentSessionMeta) {
		t.Helper()
		if err := store.Get().AgentSession.Save(m); err != nil {
			t.Fatalf("save: %v", err)
		}
	}

	// 空库：无继承
	if got := inheritDisplayName("proj-1", "", ""); got != "" {
		t.Fatalf("empty store should inherit nothing, got %q", got)
	}

	// 项目槽位：默认名（Named=false）不算继承源
	mustSave(store.AgentSessionMeta{ID: "tmux-a", ProjectID: "proj-1", Name: "Terminal 1", CreatedAt: now})
	if got := inheritDisplayName("proj-1", "", ""); got != "" {
		t.Fatalf("default name must not be inherited, got %q", got)
	}

	// 项目槽位：Named 命中；别的项目不串
	mustSave(store.AgentSessionMeta{ID: "tmux-b", ProjectID: "proj-1", Name: "构建终端",
		Named: true, NamedAt: now.Add(-time.Minute), CreatedAt: now})
	mustSave(store.AgentSessionMeta{ID: "tmux-c", ProjectID: "proj-2", Name: "另一个项目",
		Named: true, NamedAt: now, CreatedAt: now})
	if got := inheritDisplayName("proj-1", "", ""); got != "构建终端" {
		t.Fatalf("project slot inherit = %q", got)
	}

	// 项目槽位多条：NamedAt 最新者胜
	mustSave(store.AgentSessionMeta{ID: "tmux-d", ProjectID: "proj-1", Name: "最新命名",
		Named: true, NamedAt: now, CreatedAt: now})
	if got := inheritDisplayName("proj-1", "", ""); got != "最新命名" {
		t.Fatalf("latest namedAt should win, got %q", got)
	}

	// agent 槽位：按运行时匹配；项目会话 meta（Runtime 空但 ProjectID 非空）不串
	if got := inheritDisplayName("", "codex", ""); got != "" {
		t.Fatalf("other runtime must not inherit, got %q", got)
	}
	mustSave(store.AgentSessionMeta{ID: "agent-1", Runtime: "claude", Name: "后端 Claude",
		Named: true, NamedAt: now, CreatedAt: now})
	if got := inheritDisplayName("", "claude", ""); got != "后端 Claude" {
		t.Fatalf("agent slot inherit = %q", got)
	}

	// agent 槽位：同工作目录的记录优先于更新的异目录记录
	mustSave(store.AgentSessionMeta{ID: "agent-2", Runtime: "claude", Dir: "C:/repo-a",
		Name: "仓库A会话", Named: true, NamedAt: now.Add(-time.Minute), CreatedAt: now})
	if got := inheritDisplayName("", "claude", "C:/repo-a"); got != "仓库A会话" {
		t.Fatalf("same-dir record should win, got %q", got)
	}
	if got := inheritDisplayName("", "claude", "C:/repo-b"); got != "后端 Claude" {
		t.Fatalf("no dir match falls back to latest, got %q", got)
	}
}

// TestSaveAgentSessionMetaPreservesNamed 创建时的异步落库不得覆盖先到的用户
// 命名（git rev-parse 慢时改名 upsert 会先落库）
func TestSaveAgentSessionMetaPreservesNamed(t *testing.T) {
	setupRenameTest(t)
	namedAt := time.Now().Add(-30 * time.Second)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-9", Name: "我的会话", Named: true, NamedAt: namedAt,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// dir 为空串跳过 git 探测；创建默认名 "Terminal 1" 不得覆盖用户命名
	saveAgentSessionMeta("agent-9", "", "claude", "Terminal 1", "", "2.1.3 (Claude Code)", "", launchMetaExtra{})

	meta, err := store.Get().AgentSession.Get("agent-9")
	if err != nil || meta == nil {
		t.Fatalf("meta missing: %v", err)
	}
	if meta.Name != "我的会话" || !meta.Named || !meta.NamedAt.Equal(namedAt) {
		t.Fatalf("user naming clobbered by creation save: %+v", meta)
	}
	if meta.Runtime != "claude" {
		t.Fatalf("runtime not updated: %+v", meta)
	}

	// 无用户命名的会话：创建默认名正常落库（Named 保持 false）
	saveAgentSessionMeta("agent-10", "", "shell", "Terminal 2", "", "", "", launchMetaExtra{})
	meta, _ = store.Get().AgentSession.Get("agent-10")
	if meta == nil || meta.Name != "Terminal 2" || meta.Named {
		t.Fatalf("plain creation meta wrong: %+v", meta)
	}
}
