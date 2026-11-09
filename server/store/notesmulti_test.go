package store_test

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newMultiNotesTestStore 构造基于临时目录的独立多篇笔记仓储（不污染全局 Store）
func newMultiNotesTestStore(t *testing.T) store.MultiNotesStore {
	t.Helper()
	return store.NewMultiNotesRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestMultiNotes_CreateGetUpdate CRUD 主干：服务端生成 id（客户端不可指定）、
// Create 与 Update 分离（Create 直调 Create 不走 Upsert——首写并发靠 repo
// 自持锁串行，ErrAlreadyExists 不该冒给调用方）
func TestMultiNotes_CreateGetUpdate(t *testing.T) {
	r := newMultiNotesTestStore(t)

	if _, err := r.Get("p1", "ghost"); err != store.ErrNotFound {
		t.Fatalf("expected ErrNotFound for absent note, got %v", err)
	}

	n, err := r.Create("p1", "交接说明", "# 内容 v1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if n.ID == "" || n.ID == store.DefaultNoteID {
		t.Fatalf("expected server-generated uuid id, got %q", n.ID)
	}
	if n.Content != "# 内容 v1" || n.Title != "交接说明" {
		t.Errorf("created note mismatch: %+v", n)
	}
	if n.CreatedAt.IsZero() || n.UpdatedAt.IsZero() {
		t.Error("expected timestamps set on Create")
	}

	got, err := r.Get("p1", n.ID)
	if err != nil || got.Content != "# 内容 v1" {
		t.Fatalf("Get: %+v err=%v", got, err)
	}

	newTitle := "改名后的标题"
	up, err := r.Update("p1", n.ID, &newTitle, "v2", time.Time{})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if up.Content != "v2" || up.Title != "改名后的标题" {
		t.Errorf("updated note mismatch: %+v", up)
	}
	// title nil = 不改标题（重命名折叠进 PUT 的可选字段语义）
	up2, err := r.Update("p1", n.ID, nil, "v3", time.Time{})
	if err != nil {
		t.Fatalf("Update(nil title): %v", err)
	}
	if up2.Title != "改名后的标题" || up2.Content != "v3" {
		t.Errorf("nil-title update should keep title: %+v", up2)
	}
}

// TestMultiNotes_BaseUpdatedAtConflict 覆盖保护三件套①：baseUpdatedAt 与当前
// 版本不符返回 ErrNotesConflict 且携带当前文档（409 currentContent 载荷源）；
// 不传（零值）保持 last-writer-wins
func TestMultiNotes_BaseUpdatedAtConflict(t *testing.T) {
	r := newMultiNotesTestStore(t)

	n, err := r.Create("p1", "", "v1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 用陈旧基准更新（另一写者已在其间写入 v2）
	if _, err := r.Update("p1", n.ID, nil, "v2-external", time.Time{}); err != nil {
		t.Fatalf("external update: %v", err)
	}
	_, err = r.Update("p1", n.ID, nil, "v3-stale", n.UpdatedAt)
	var nce *store.NotesConflictError
	if !errors.As(err, &nce) || !errors.Is(err, store.ErrNotesConflict) {
		t.Fatalf("expected ErrNotesConflict (carried), got %v", err)
	}
	// 冲突载荷 = 服务端当前文档（面板「载入服务端版本」动作的数据源）
	if nce.Current.Content != "v2-external" {
		t.Errorf("conflict payload should carry current content, got %q", nce.Current.Content)
	}

	// 基准吻合：写入成功
	fresh, _ := r.Get("p1", n.ID)
	if _, err := r.Update("p1", n.ID, nil, "v3-ok", fresh.UpdatedAt); err != nil {
		t.Errorf("expected matching base to pass, got %v", err)
	}
	// 零基准 = last-writer-wins（既有语义不破坏）
	if _, err := r.Update("p1", n.ID, nil, "v4", time.Time{}); err != nil {
		t.Errorf("expected zero baseUpdatedAt (LWW) to pass, got %v", err)
	}
}

// TestMultiNotes_TrashLifecycle 软删/恢复/硬清：软删不拆 kind（同篇文档字段）、
// List 原样返回由调用方过滤、restore 幂等、超期硬清、agent 无硬删由 handler 层保证
func TestMultiNotes_TrashLifecycle(t *testing.T) {
	r := newMultiNotesTestStore(t)

	a, _ := r.Create("p1", "A", "content a")
	b, _ := r.Create("p1", "B", "content b")

	if err := r.SoftDelete("p1", a.ID, "human"); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	// 幂等：再删一次仍成功
	if err := r.SoftDelete("p1", a.ID, "human"); err != nil {
		t.Errorf("idempotent SoftDelete: %v", err)
	}

	got, err := r.Get("p1", a.ID)
	if err != nil {
		t.Fatalf("Get soft-deleted: %v", err)
	}
	if got.Live() || got.DeletedAt == nil || got.DeletedBy != "human" {
		t.Errorf("expected soft-deleted state with by=human, got %+v", got)
	}

	notes, err := r.List("p1")
	if err != nil || len(notes) != 2 {
		t.Fatalf("List should return raw (incl. trashed): n=%d err=%v", len(notes), err)
	}
	// CountLive 是额度计数（含软删篇——软删不释放额度，硬清才释放）
	quota, _ := r.CountLive("p1")
	if quota != 2 {
		t.Errorf("expected quota count 2 (incl. trashed), got %d", quota)
	}

	if err := r.Restore("p1", a.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if err := r.Restore("p1", a.ID); err != nil { // 幂等
		t.Errorf("idempotent Restore: %v", err)
	}
	if got, _ = r.Get("p1", a.ID); !got.Live() {
		t.Error("expected live after restore")
	}

	// 软删超期 → PurgeDeletedBefore 清掉；未超期的留下
	if err := r.SoftDelete("p1", b.ID, "human"); err != nil {
		t.Fatalf("SoftDelete b: %v", err)
	}
	removed, err := r.PurgeDeletedBefore(time.Now().Add(store.NotesTrashRetention + time.Hour))
	if err != nil || removed != 1 {
		t.Fatalf("PurgeDeletedBefore: removed=%d err=%v", removed, err)
	}
	if _, err := r.Get("p1", b.ID); err != store.ErrNotFound {
		t.Errorf("expected purged note gone, got %v", err)
	}
	if _, err := r.Get("p1", a.ID); err != nil {
		t.Errorf("expected live note intact, got %v", err)
	}

	// Purge 幂等（不存在的篇视为已清——级联语义）
	if err := r.Purge("p1", b.ID); err != nil {
		t.Errorf("idempotent Purge: %v", err)
	}
}

// TestMultiNotes_Limits 上界护栏：256KB 内容、200 字节标题、100 篇/作用域
// （P-20261108-3 单库化后各作用域统一 NotesMaxGlobal 档与 ErrNotesGlobalLimitReached）
func TestMultiNotes_Limits(t *testing.T) {
	r := newMultiNotesTestStore(t)

	if _, err := r.Create("p1", "", strings.Repeat("a", store.ProjNotesMaxBytes)); err != nil {
		t.Errorf("exact 256KB expected accepted, got %v", err)
	}
	if _, err := r.Create("p1", "", strings.Repeat("a", store.ProjNotesMaxBytes+1)); err != store.ErrNotesTooLarge {
		t.Errorf("expected ErrNotesTooLarge, got %v", err)
	}
	if _, err := r.Create("p1", strings.Repeat("标", 67)+"x", ""); err != store.ErrNotesTitleTooLong { // 67*3+1=202B
		t.Errorf("expected ErrNotesTitleTooLong, got %v", err)
	}
	if _, err := r.Create("p1", strings.Repeat("标", 66)+"xy", ""); err != nil { // 66*3+2=200B 恰好
		t.Errorf("exact 200B title expected accepted, got %v", err)
	}

	// 篇数上限（含软删占用额度）：独立仓储灌满全局库
	first := newMultiNotesTestStore(t)
	for i := 0; i < store.NotesMaxGlobal; i++ {
		if _, err := first.Create(store.GlobalNotesScope, "", "c"); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}
	extra, err := first.Create(store.GlobalNotesScope, "", "overflow")
	if err != store.ErrNotesGlobalLimitReached {
		t.Errorf("expected ErrNotesGlobalLimitReached at %d notes, got %v", store.NotesMaxGlobal, err)
	}
	_ = extra
	// 软删不释放额度（硬清才释放）
	notes, _ := first.List(store.GlobalNotesScope)
	_ = first.SoftDelete(store.GlobalNotesScope, notes[0].ID, "human")
	if _, err := first.Create(store.GlobalNotesScope, "", "still capped"); err != store.ErrNotesGlobalLimitReached {
		t.Errorf("soft-deleted note should still consume quota, got %v", err)
	}
}

// TestMultiNotes_LegacyMigration 启动期幂等迁移矩阵（提案风险项①）：旧键在/
// 两键并存/空三种形态——旧键内容落默认篇后删旧键；重跑幂等（第二次 0 篇）；
// 两键并存以新键为准（提案既定策略）；已删除项目不复活
func TestMultiNotes_LegacyMigration(t *testing.T) {
	// 旧数据面：手工直写 projnotes kind（模拟旧二进制留下的形态）
	fs := filestore.New(filepath.Join(t.TempDir(), "data"))
	multi := store.NewMultiNotesRepo(fs)
	old := store.NewProjectNotesRepo(fs)
	if err := old.Put("p1", "# 旧单篇内容"); err != nil {
		t.Fatalf("seed legacy note: %v", err)
	}
	if err := old.Put("p2", "p2 legacy"); err != nil {
		t.Fatalf("seed legacy note p2: %v", err)
	}

	n, err := multi.MigrateLegacyProjectNotes()
	if err != nil || n != 2 {
		t.Fatalf("migration: migrated=%d err=%v", n, err)
	}
	got, err := multi.Get("p1", store.DefaultNoteID)
	if err != nil || got.Content != "# 旧单篇内容" {
		t.Fatalf("default note should carry legacy content: %+v err=%v", got, err)
	}
	if got.UpdatedAt.IsZero() {
		t.Error("expected legacy updatedAt preserved")
	}
	// 旧键已删（两键并存窗口收敛）
	if has, _ := fsHasLegacy(fs, "p1"); has {
		t.Error("legacy key should be deleted after migration")
	}
	// p2 未被迁移成 p1 的内容（项目隔离不串扰）
	if got2, _ := multi.Get("p2", store.DefaultNoteID); got2.Content != "p2 legacy" {
		t.Errorf("p2 content mismatch: %q", got2.Content)
	}

	// 重跑幂等：无旧键 → 0 篇
	n2, err := multi.MigrateLegacyProjectNotes()
	if err != nil || n2 != 0 {
		t.Fatalf("re-run should migrate nothing: n=%d err=%v", n2, err)
	}

	// 两键并存以新键为准：用户升级（迁移落位）→ 降级旧二进制改写旧键 → 再升级
	if err := old.Put("p1", "降级窗口的新内容"); err != nil {
		t.Fatalf("downgrade-window write: %v", err)
	}
	n3, _ := multi.MigrateLegacyProjectNotes()
	_ = n3
	if got, _ = multi.Get("p1", store.DefaultNoteID); got.Content != "# 旧单篇内容" {
		t.Errorf("two-key coexistence must favor the new key, got %q", got.Content)
	}
	if has, _ := fsHasLegacy(fs, "p1"); has {
		t.Error("redundant legacy key should be cleaned on re-migration")
	}
}

// fsHasLegacy 检查 projnotes kind 里旧键是否还在（迁移测试断言面）
func fsHasLegacy(fs store.DocumentStore, projectID string) (bool, error) {
	keys, _, err := fs.List("projnotes", store.ListOpts{Prefix: projectID})
	if err != nil {
		return false, err
	}
	for _, k := range keys {
		if k == projectID {
			return true, nil
		}
	}
	return false, nil
}

// TestMultiNotes_ConcurrentCreate 并发首写不越限：repo 自持锁内「数额度→写」
// 串行，100 上限在并发冲刷下仍精确守住（ErrAlreadyExists 也不冒给调用方）
func TestMultiNotes_ConcurrentCreate(t *testing.T) {
	r := newMultiNotesTestStore(t)

	const workers = 130 // 超过 100 上限：冲刷下额度精确守住
	var wg sync.WaitGroup
	var mu sync.Mutex
	okCount, limitErr := 0, 0
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.Create(store.GlobalNotesScope, "", "concurrent")
			mu.Lock()
			defer mu.Unlock()
			switch err {
			case nil:
				okCount++
			case store.ErrNotesGlobalLimitReached:
				limitErr++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()
	if okCount != store.NotesMaxGlobal || limitErr != workers-store.NotesMaxGlobal {
		t.Errorf("expected exactly %d ok / %d limited, got %d ok / %d limited",
			store.NotesMaxGlobal, workers-store.NotesMaxGlobal, okCount, limitErr)
	}
}
