package store_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 全局笔记库存储面（P-20261107-5 → P-20261108-3 单库化）：哨兵作用域
// （_global-<noteID> 复合键）与存量项目作用域同仓储同方法——本套测试只钉
// 全局专属语义：篇数上限（ErrNotesGlobalLimitReached）、30 天硬清覆盖
// _global-* 键、启动迁移哨兵冲突跳过。CRUD/409/软删恢复主干由
// notesmulti_test.go 覆盖（同一实现，不重复）；单库化迁移见 notesmigrate_test.go。
// 项目删除级联守卫随 P-20261108-3 退役（项目删除不再删笔记——残留项目篇改走
// 迁移并入全局库）──

func newGlobalNotesTestStore(t *testing.T) store.MultiNotesStore {
	t.Helper()
	return store.NewMultiNotesRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestGlobalNotes_ScopeIsolation 全局库与项目库键空间隔离：同 id 互不可见、
// List 前缀互不串扰（哨兵键 _global- 与项目键 <uuid>- 同一 List(Prefix) 口径）
func TestGlobalNotes_ScopeIsolation(t *testing.T) {
	r := newGlobalNotesTestStore(t)

	g, err := r.Create(store.GlobalNotesScope, "全局备忘", "global content")
	if err != nil {
		t.Fatalf("Create global: %v", err)
	}
	p, err := r.Create("p1", "项目交接", "project content")
	if err != nil {
		t.Fatalf("Create project: %v", err)
	}
	if g.ID == p.ID {
		t.Fatalf("expected distinct uuid ids, both %q", g.ID)
	}
	// 全局清单不含项目篇、反之亦然
	gl, _ := r.List(store.GlobalNotesScope)
	if len(gl) != 1 || gl[0].ID != g.ID {
		t.Errorf("global list = %+v, want only global note", gl)
	}
	pl, _ := r.List("p1")
	if len(pl) != 1 || pl[0].ID != p.ID {
		t.Errorf("project list = %+v, want only project note", pl)
	}
	// 项目通道读全局篇 id → not found（键空间隔离）
	if _, err := r.Get("p1", g.ID); err != store.ErrNotFound {
		t.Errorf("cross-scope get should be ErrNotFound, got %v", err)
	}
}

// TestGlobalNotes_Limit100 额度：全局库灌满 100 篇 → ErrNotesGlobalLimitReached
// （计数只扫本作用域前缀——存量项目作用域篇不占全局额度，迁移并入时才计入）
func TestGlobalNotes_Limit100(t *testing.T) {
	r := newGlobalNotesTestStore(t)
	for i := 0; i < store.NotesMaxGlobal; i++ {
		if _, err := r.Create(store.GlobalNotesScope, "", "c"); err != nil {
			t.Fatalf("seed global #%d: %v", i, err)
		}
	}
	if _, err := r.Create(store.GlobalNotesScope, "", "overflow"); err != store.ErrNotesGlobalLimitReached {
		t.Errorf("expected ErrNotesGlobalLimitReached, got %v", err)
	}
	// 其他作用域计数独立（只扫本作用域前缀）
	if _, err := r.Create("p1", "", "fine"); err != nil {
		t.Errorf("project create after global limit: %v", err)
	}
	// 软删篇计入额度（同项目档口径），恢复后额度不释放
	first, _ := r.List(store.GlobalNotesScope)
	_ = r.SoftDelete(store.GlobalNotesScope, first[0].ID, "human")
	if _, err := r.Create(store.GlobalNotesScope, "", "still full"); err != store.ErrNotesGlobalLimitReached {
		t.Errorf("trashed note must count toward limit, got %v", err)
	}
}

// TestGlobalNotes_TrashPurgePipeline 30 天硬清同管线覆盖 _global-* 键：
// PurgeDeletedBefore 全 kind 扫描（软删篇滞留过 cutoff 即硬清——「永不自动清」
// 只指活篇）
func TestGlobalNotes_TrashPurgePipeline(t *testing.T) {
	r := newGlobalNotesTestStore(t)
	g1, _ := r.Create(store.GlobalNotesScope, "将清", "old trashed")
	_ = r.SoftDelete(store.GlobalNotesScope, g1.ID, "human")
	g2, _ := r.Create(store.GlobalNotesScope, "活篇", "live stays")

	removed, err := r.PurgeDeletedBefore(time.Now().Add(store.NotesTrashRetention + time.Hour))
	if err != nil {
		t.Fatalf("PurgeDeletedBefore: %v", err)
	}
	if removed != 1 {
		t.Errorf("expected 1 purged, got %d", removed)
	}
	if _, err := r.Get(store.GlobalNotesScope, g1.ID); err != store.ErrNotFound {
		t.Errorf("trashed global note expected hard-purged, got %v", err)
	}
	if _, err := r.Get(store.GlobalNotesScope, g2.ID); err != nil {
		t.Errorf("live global note must stay: %v", err)
	}
}

// TestGlobalNotes_MigrationSkipsSentinelLegacyKey 哨兵冲突校验①（-2a 定案）：
// 旧单篇键撞保留字 _global 时迁移跳过（旧键原样保留、不落成全局库默认篇），
// 正常项目键照常迁移
func TestGlobalNotes_MigrationSkipsSentinelLegacyKey(t *testing.T) {
	fs := filestore.New(filepath.Join(t.TempDir(), "data"))
	multi := store.NewMultiNotesRepo(fs)
	old := store.NewProjectNotesRepo(fs)
	if err := old.Put("p1", "# 正常项目旧篇"); err != nil {
		t.Fatalf("seed legacy p1: %v", err)
	}
	if err := old.Put(store.GlobalNotesScope, "哨兵冲突旧篇"); err != nil {
		t.Fatalf("seed legacy sentinel key: %v", err)
	}

	n, err := multi.MigrateLegacyProjectNotes()
	if err != nil || n != 1 {
		t.Fatalf("migration: migrated=%d err=%v（哨兵键必须跳过）", n, err)
	}
	// 哨兵键未落成全局库默认篇（项目内容不串进全局面）
	if got, err := multi.Get(store.GlobalNotesScope, store.DefaultNoteID); err != store.ErrNotFound {
		t.Errorf("sentinel legacy key must not migrate into global default note: %+v err=%v", got, err)
	}
	// 正常项目键照常迁移
	if got, err := multi.Get("p1", store.DefaultNoteID); err != nil || !strings.Contains(got.Content, "正常项目旧篇") {
		t.Errorf("normal legacy key migration broken: %+v err=%v", got, err)
	}
	// 哨兵旧键原样保留（数据无损，人工核对后处置）
	if has, _ := fsHasLegacy(fs, store.GlobalNotesScope); !has {
		t.Error("sentinel legacy key must be preserved for manual inspection")
	}
}
