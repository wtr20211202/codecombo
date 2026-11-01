package store_test

import (
	"errors"
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newSnippetStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newSnippetStoreForTest(t *testing.T) store.SnippetStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).Snippet
}

// TestSnippetStore_SeedOnFirstList 首次 List 播种 2 条系统片段（幂等）
func TestSnippetStore_SeedOnFirstList(t *testing.T) {
	s := newSnippetStoreForTest(t)
	first, err := s.List()
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("seeded = %d, want 2", len(first))
	}
	for _, sn := range first {
		if !sn.IsSystem {
			t.Errorf("seeded snippet %q should be system", sn.Title)
		}
		if sn.Scope != "global" {
			t.Errorf("seeded snippet %q scope = %q, want global", sn.Title, sn.Scope)
		}
	}
	second, _ := s.List()
	if len(second) != 2 {
		t.Fatalf("second list = %d, want 2 (seed must be idempotent)", len(second))
	}
	// 系统片段必须带服务端生成的 ID：无 ID 会导致前端编辑走错分支、列表 key 冲突
	for _, sn := range second {
		if len(sn.ID) < 8 {
			t.Fatalf("seeded snippet %q has empty/short ID %q", sn.Title, sn.ID)
		}
	}
}

// TestSnippetStore_MigrateLegacyIDLess 早期版本存量（无 ID）在读取时回填 ID
func TestSnippetStore_MigrateLegacyIDLess(t *testing.T) {
	// 直接写原始文档模拟早期版本存量（绕过 repo 的 seed/迁移逻辑）
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	raw := `[{"title":"旧片段甲","command":"df -h","scope":"global","isSystem":true},{"title":"旧片段乙","command":"ls","scope":"global"}]`
	if err := doc.Create("snippets", "all", []byte(raw)); err != nil {
		t.Fatalf("seed raw: %v", err)
	}
	s := store.New(doc).Snippet

	first, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("list = %d, want 2", len(first))
	}
	for _, sn := range first {
		if sn.ID == "" {
			t.Fatalf("legacy snippet %q still has no ID after migration", sn.Title)
		}
	}
	// 迁移必须持久化：第二次读取 ID 稳定（不重新生成）
	second, _ := s.List()
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatalf("ID not stable across reads: %q vs %q", first[i].ID, second[i].ID)
		}
	}
	// 迁移后的片段可正常更新（旧 bug：无 ID 使编辑 404/走错分支）
	updated, err := s.Update(first[0].ID, store.Snippet{Command: "df -h /"})
	if err != nil {
		t.Fatalf("update migrated snippet: %v", err)
	}
	if updated.Command != "df -h /" {
		t.Fatalf("command = %q, want updated", updated.Command)
	}
}

// TestSnippetStore_CRUD 创建/更新/删除用户片段
func TestSnippetStore_CRUD(t *testing.T) {
	s := newSnippetStoreForTest(t)
	created, err := s.Create(store.Snippet{Title: "磁盘占用", Command: "df -h", Description: "查看磁盘"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" || created.IsSystem {
		t.Fatalf("ID=%q IsSystem=%v, want server-generated non-system", created.ID, created.IsSystem)
	}
	// 忽略客户端传入的 IsSystem / ID
	forged, err := s.Create(store.Snippet{Title: "伪造", Command: "id", ID: "sc_snip_x", IsSystem: true})
	if err != nil {
		t.Fatalf("create forged: %v", err)
	}
	if forged.ID == "sc_snip_x" || forged.IsSystem {
		t.Fatalf("server must generate ID and reject IsSystem=true")
	}

	updated, err := s.Update(created.ID, store.Snippet{Command: "df -h /"})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Command != "df -h /" {
		t.Fatalf("command = %q, want updated", updated.Command)
	}

	if err := s.Delete(forged.ID); err != nil {
		t.Fatalf("delete user snippet: %v", err)
	}
	if _, err := s.Update("sc_snip_missing", store.Snippet{Title: "x"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing = %v, want ErrNotFound", err)
	}
}

// TestSnippetStore_SystemProtected 系统片段可编辑内容但不可删除
func TestSnippetStore_SystemProtected(t *testing.T) {
	s := newSnippetStoreForTest(t)
	snippets, _ := s.List()
	sysID := snippets[0].ID

	// 内容可改（改出副本效果）
	updated, err := s.Update(sysID, store.Snippet{Command: "tmux new -s work || tmux attach -t work"})
	if err != nil {
		t.Fatalf("update system snippet: %v", err)
	}
	if updated.Command != "tmux new -s work || tmux attach -t work" {
		t.Fatalf("system snippet command not updated: %q", updated.Command)
	}
	// 身份不可变：Update 不接受 IsSystem 字段
	if err := s.Delete(sysID); !errors.Is(err, store.ErrSystemSnippet) {
		t.Fatalf("delete system = %v, want ErrSystemSnippet", err)
	}
}

// TestSnippetStore_KindLanguageRoundTrip（P-20261002-44）：code 片段 Kind/Language
// 创建即落盘；缺省 Kind 归一 command（旧数据零迁移）；Update 可补 Language、
// 白名单外 Kind 不落盘
func TestSnippetStore_KindLanguageRoundTrip(t *testing.T) {
	s := newSnippetStoreForTest(t)

	code, err := s.Create(store.Snippet{
		Title:    "组件模板",
		Command:  "const x = 1",
		Kind:     store.SnippetKindCode,
		Language: "typescript",
	})
	if err != nil {
		t.Fatalf("create code snippet: %v", err)
	}
	if code.Kind != store.SnippetKindCode || code.Language != "typescript" {
		t.Fatalf("kind/language = %q/%q, want code/typescript", code.Kind, code.Language)
	}

	// 缺省 Kind → command；白名单外 Kind → 收敛为 command
	legacy, err := s.Create(store.Snippet{Title: "旧式命令", Command: "ls -la", Kind: "yaml"})
	if err != nil {
		t.Fatalf("create legacy: %v", err)
	}
	if legacy.Kind != store.SnippetKindCommand {
		t.Fatalf("kind = %q, want normalized command", legacy.Kind)
	}

	// 落盘持久：重读一致（列表含两条且 Kind 不串）
	list, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	byKind := map[string]int{}
	for _, sn := range list {
		byKind[sn.Kind]++
	}
	if byKind[store.SnippetKindCode] != 1 || byKind[store.SnippetKindCommand] < 3 {
		t.Fatalf("kind histogram = %v, want 1 code + >=3 command", byKind)
	}

	// Update：补 Language；Kind 白名单外值不落盘
	patched, err := s.Update(code.ID, store.Snippet{Language: "javascript", Kind: "nope"})
	if err != nil {
		t.Fatalf("update code snippet: %v", err)
	}
	if patched.Language != "javascript" {
		t.Fatalf("language = %q, want javascript", patched.Language)
	}
	if patched.Kind != store.SnippetKindCode {
		t.Fatalf("kind = %q, whitelist must reject non-kind values", patched.Kind)
	}
}
