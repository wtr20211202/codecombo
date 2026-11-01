package store_test

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newNotesTestStore 构造基于临时目录的独立项目笔记仓储（不污染全局 Store）
func newNotesTestStore(t *testing.T) store.ProjectNotesStore {
	t.Helper()
	return store.NewProjectNotesRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestProjectNotes_PutGetRoundtrip 写读回环；从未写过的项目返回 ErrNotFound
func TestProjectNotes_PutGetRoundtrip(t *testing.T) {
	r := newNotesTestStore(t)

	if _, err := r.Get("p1"); err != store.ErrNotFound {
		t.Fatalf("expected ErrNotFound for absent project, got %v", err)
	}

	if err := r.Put("p1", "# 交接说明\n\n- 待办：修复登录超时"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	n, err := r.Get("p1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if n.Content != "# 交接说明\n\n- 待办：修复登录超时" {
		t.Errorf("content mismatch: %q", n.Content)
	}
	if n.UpdatedAt.IsZero() {
		t.Error("expected UpdatedAt set on Put")
	}

	// 覆盖写（upsert）：新内容整体替换旧内容
	if err := r.Put("p1", "v2"); err != nil {
		t.Fatalf("Put overwrite: %v", err)
	}
	n, _ = r.Get("p1")
	if n.Content != "v2" {
		t.Errorf("expected overwritten content v2, got %q", n.Content)
	}
}

// TestProjectNotes_PerProjectIsolation 项目一文档：互不串扰
func TestProjectNotes_PerProjectIsolation(t *testing.T) {
	r := newNotesTestStore(t)

	if err := r.Put("p1", "note of p1"); err != nil {
		t.Fatalf("Put p1: %v", err)
	}
	if err := r.Put("p2", "note of p2"); err != nil {
		t.Fatalf("Put p2: %v", err)
	}
	n1, err := r.Get("p1")
	if err != nil || n1.Content != "note of p1" {
		t.Errorf("p1: content=%q err=%v", n1.Content, err)
	}
	n2, err := r.Get("p2")
	if err != nil || n2.Content != "note of p2" {
		t.Errorf("p2: content=%q err=%v", n2.Content, err)
	}

	// 删除只影响本项目
	if err := r.Delete("p1"); err != nil {
		t.Fatalf("Delete p1: %v", err)
	}
	if _, err := r.Get("p1"); err != store.ErrNotFound {
		t.Errorf("p1 expected ErrNotFound after delete, got %v", err)
	}
	if _, err := r.Get("p2"); err != nil {
		t.Errorf("p2 expected intact after p1 delete, got %v", err)
	}

	// 删除不存在的项目静默成功（级联清理的尽力而为语义）
	if err := r.Delete("ghost"); err != nil {
		t.Errorf("Delete ghost: %v", err)
	}
}

// TestProjectNotes_SizeLimit 256KB 边界：恰好 256KB（UTF-8 字节）放行，
// 超一字节拒绝——按字节而非字符计长（多字节中文同样受控）
func TestProjectNotes_SizeLimit(t *testing.T) {
	r := newNotesTestStore(t)

	exact := strings.Repeat("a", store.ProjNotesMaxBytes)
	if err := r.Put("p1", exact); err != nil {
		t.Fatalf("expected exact-256KB content accepted, got %v", err)
	}

	over := strings.Repeat("a", store.ProjNotesMaxBytes+1)
	if err := r.Put("p1", over); err != store.ErrNotesTooLarge {
		t.Fatalf("expected ErrNotesTooLarge for 256KB+1, got %v", err)
	}

	// 多字节字符按字节计：87382 个中文（3 字节/字 = 262146B）超限
	multiByte := strings.Repeat("笔", store.ProjNotesMaxBytes/3+1)
	if err := r.Put("p1", multiByte); err != store.ErrNotesTooLarge {
		t.Fatalf("expected ErrNotesTooLarge for multi-byte overflow, got %v", err)
	}

	// 边界后再写一次合法内容：拒绝路径不落半截文档（原内容保持可读）
	n, err := r.Get("p1")
	if err != nil || len(n.Content) != store.ProjNotesMaxBytes {
		t.Fatalf("expected original 256KB content intact, len=%d err=%v", len(n.Content), err)
	}
}

// TestProjectNotes_ConcurrentWriters 面板与 agent 并发写的并发策略实证：
// last-writer-wins——并发 Put 后最终内容必为某一个写者的完整原文，
// 不出现交错/半截（filestore 同 kind 串行 + 原子改名保证）
func TestProjectNotes_ConcurrentWriters(t *testing.T) {
	r := newNotesTestStore(t)

	const writers = 16
	contents := make([]string, writers)
	for i := range contents {
		// 各写者内容不同长度、末尾带独立标记：可判别完整性与归属
		contents[i] = strings.Repeat(string(rune('a'+i)), 100+i) + "<<writer" + string(rune('a'+i)) + ">>"
	}

	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(content string) {
			defer wg.Done()
			_ = r.Put("p1", content) // last-writer-wins：失败重试无意义，最终必有完整内容
		}(contents[i])
	}
	wg.Wait()

	n, err := r.Get("p1")
	if err != nil {
		t.Fatalf("Get after concurrent writes: %v", err)
	}
	intact := false
	for _, c := range contents {
		if n.Content == c {
			intact = true
			break
		}
	}
	if !intact {
		t.Fatalf("final content is not any writer's intact version (len=%d, tail=%q)",
			len(n.Content), tailOf(n.Content, 24))
	}
}

func tailOf(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
