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

	n, err := r.Create("p1", "交接说明", "# 内容 v1", nil)
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
	up, err := r.Update("p1", n.ID, &newTitle, "v2", time.Time{}, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if up.Content != "v2" || up.Title != "改名后的标题" {
		t.Errorf("updated note mismatch: %+v", up)
	}
	// title nil = 不改标题（重命名折叠进 PUT 的可选字段语义）
	up2, err := r.Update("p1", n.ID, nil, "v3", time.Time{}, nil)
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

	n, err := r.Create("p1", "", "v1", nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 用陈旧基准更新（另一写者已在其间写入 v2）
	if _, err := r.Update("p1", n.ID, nil, "v2-external", time.Time{}, nil); err != nil {
		t.Fatalf("external update: %v", err)
	}
	_, err = r.Update("p1", n.ID, nil, "v3-stale", n.UpdatedAt, nil)
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
	if _, err := r.Update("p1", n.ID, nil, "v3-ok", fresh.UpdatedAt, nil); err != nil {
		t.Errorf("expected matching base to pass, got %v", err)
	}
	// 零基准 = last-writer-wins（既有语义不破坏）
	if _, err := r.Update("p1", n.ID, nil, "v4", time.Time{}, nil); err != nil {
		t.Errorf("expected zero baseUpdatedAt (LWW) to pass, got %v", err)
	}
}

// TestMultiNotes_TrashLifecycle 软删/恢复/硬清：软删不拆 kind（同篇文档字段）、
// List 原样返回由调用方过滤、restore 幂等、超期硬清、agent 无硬删由 handler 层保证
func TestMultiNotes_TrashLifecycle(t *testing.T) {
	r := newMultiNotesTestStore(t)

	a, _ := r.Create("p1", "A", "content a", nil)
	b, _ := r.Create("p1", "B", "content b", nil)

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

	if _, err := r.Create("p1", "", strings.Repeat("a", store.ProjNotesMaxBytes), nil); err != nil {
		t.Errorf("exact 256KB expected accepted, got %v", err)
	}
	if _, err := r.Create("p1", "", strings.Repeat("a", store.ProjNotesMaxBytes+1), nil); err != store.ErrNotesTooLarge {
		t.Errorf("expected ErrNotesTooLarge, got %v", err)
	}
	if _, err := r.Create("p1", strings.Repeat("标", 67)+"x", "", nil); err != store.ErrNotesTitleTooLong { // 67*3+1=202B
		t.Errorf("expected ErrNotesTitleTooLong, got %v", err)
	}
	if _, err := r.Create("p1", strings.Repeat("标", 66)+"xy", "", nil); err != nil { // 66*3+2=200B 恰好
		t.Errorf("exact 200B title expected accepted, got %v", err)
	}

	// 篇数上限（含软删占用额度）：独立仓储灌满全局库
	first := newMultiNotesTestStore(t)
	for i := 0; i < store.NotesMaxGlobal; i++ {
		if _, err := first.Create(store.GlobalNotesScope, "", "c", nil); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}
	extra, err := first.Create(store.GlobalNotesScope, "", "overflow", nil)
	if err != store.ErrNotesGlobalLimitReached {
		t.Errorf("expected ErrNotesGlobalLimitReached at %d notes, got %v", store.NotesMaxGlobal, err)
	}
	_ = extra
	// 软删不释放额度（硬清才释放）
	notes, _ := first.List(store.GlobalNotesScope)
	_ = first.SoftDelete(store.GlobalNotesScope, notes[0].ID, "human")
	if _, err := first.Create(store.GlobalNotesScope, "", "still capped", nil); err != store.ErrNotesGlobalLimitReached {
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
			_, err := r.Create(store.GlobalNotesScope, "", "concurrent", nil)
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

// TestMultiNotes_TagsNormalize 标签归一化（P-20261112-7 S1）：trim/空串丢弃/
// 去重保序（首现位置）/超 32 rune 丢弃/超 8 个截断保前 8——非法 tag 丢弃不
// 报错（便签语义坏数据不阻断；写路径与解码共用同一归一化）
func TestMultiNotes_TagsNormalize(t *testing.T) {
	r := newMultiNotesTestStore(t)

	n, err := r.Create("p1", "标签篇", "c", []string{"  生涯  ", "", "项目A", "生涯", "项目A"})
	if err != nil {
		t.Fatalf("Create with tags: %v", err)
	}
	if len(n.Tags) != 2 || n.Tags[0] != "生涯" || n.Tags[1] != "项目A" {
		t.Errorf("expected trimmed/deduped order-kept tags [生涯 项目A], got %v", n.Tags)
	}

	// 超 32 rune 的 tag 丢弃；空串全丢 = 无标签（nil，omitempty 落盘省字段）
	long := strings.Repeat("标", 33)
	n2, err := r.Create("p1", "超限篇", "c", []string{long, "长靴", strings.Repeat("x", 32)})
	if err != nil {
		t.Fatalf("Create over-limit tag: %v", err)
	}
	if len(n2.Tags) != 2 || n2.Tags[0] != "长靴" || len([]rune(n2.Tags[1])) != 32 {
		t.Errorf("expected over-rune tag dropped (32-rune kept), got %v", n2.Tags)
	}

	// 超 8 个截断保前 8（保序）
	n3, err := r.Create("p1", "刷满篇", "c", []string{"t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"})
	if err != nil {
		t.Fatalf("Create 10 tags: %v", err)
	}
	if len(n3.Tags) != store.NotesMaxTags || n3.Tags[0] != "t1" || n3.Tags[7] != "t8" {
		t.Errorf("expected cap at %d keeping first 8 in order, got %v", store.NotesMaxTags, n3.Tags)
	}

	// 只给空白/空串 = 无标签
	n4, err := r.Create("p1", "空白篇", "c", []string{"  ", ""})
	if err != nil || n4.Tags != nil {
		t.Errorf("expected blank-only tags normalized to nil, got %v err=%v", n4.Tags, err)
	}
}

// TestMultiNotes_TagsUpdateSemantics PUT 标签三态（指针可选，与 title *string
// 同构）：携带即整体替换（标签行是全量编辑面）/显式 [] 清空/nil 不改动——
// nil=不改动使旧前端/纯改名 PUT 不清空他窗标签
func TestMultiNotes_TagsUpdateSemantics(t *testing.T) {
	r := newMultiNotesTestStore(t)

	n, err := r.Create("p1", "标签篇", "v1", []string{"旧标签"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 携带即整体替换（并归一化：trim/去重）
	newTags := []string{" 新标签 ", "新标签", "另一枚"}
	up, err := r.Update("p1", n.ID, nil, "v2", time.Time{}, &newTags)
	if err != nil {
		t.Fatalf("Update with tags: %v", err)
	}
	if len(up.Tags) != 2 || up.Tags[0] != "新标签" || up.Tags[1] != "另一枚" {
		t.Errorf("expected whole-replace normalized tags, got %v", up.Tags)
	}

	// nil = 不改动（旧前端/纯改名 PUT 不清空他窗标签）
	up2, err := r.Update("p1", n.ID, nil, "v3", time.Time{}, nil)
	if err != nil {
		t.Fatalf("Update without tags: %v", err)
	}
	if len(up2.Tags) != 2 || up2.Tags[0] != "新标签" {
		t.Errorf("nil tags must keep existing tags, got %v", up2.Tags)
	}

	// 显式 [] = 清空
	empty := []string{}
	up3, err := r.Update("p1", n.ID, nil, "v4", time.Time{}, &empty)
	if err != nil {
		t.Fatalf("Update with empty tags: %v", err)
	}
	if up3.Tags != nil {
		t.Errorf("explicit empty slice must clear tags, got %v", up3.Tags)
	}

	// 默认篇 upsert 同语义：首写携 tags 落真身（PUT /api/notes/default 带标签）
	tags := []string{"项目A"}
	d, err := r.UpsertDefault(store.GlobalNotesScope, "默认正文", nil, &tags)
	if err != nil {
		t.Fatalf("UpsertDefault with tags: %v", err)
	}
	if len(d.Tags) != 1 || d.Tags[0] != "项目A" {
		t.Errorf("default upsert should carry tags, got %v", d.Tags)
	}
	// 已落真身再 upsert：nil 不改动
	if _, err := r.UpsertDefault(store.GlobalNotesScope, "默认正文 v2", nil, nil); err != nil {
		t.Fatalf("UpsertDefault without tags: %v", err)
	}
	if got, _ := r.Get(store.GlobalNotesScope, store.DefaultNoteID); len(got.Tags) != 1 || got.Tags[0] != "项目A" {
		t.Errorf("nil tags upsert must keep tags, got %v", got.Tags)
	}
}

// TestMultiNotes_TagsDecodeFaultTolerance 解码容错（便签语义坏数据不阻断）：
// 落盘文档 tags 形态坏（超限项/空白项/元素混入非字符串）读取时只弃非法项，
// 篇不消失、其余字段保全——filestore 直写原始文档后经仓储读出验证
func TestMultiNotes_TagsDecodeFaultTolerance(t *testing.T) {
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	r := store.NewMultiNotesRepo(doc)

	n, err := r.Create("p1", "带标签篇", "body", []string{"好标签"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	key := "p1-" + n.ID

	// 形态①：元素混入非字符串（手改坏数据）——只弃坏项不弃整篇
	if err := doc.Update("notesmulti", key, []byte(`{"id":"`+n.ID+`","title":"带标签篇","content":"body","tags":["ok",42,"好标签"]} `)); err != nil {
		t.Fatalf("seed corrupt tags: %v", err)
	}
	got, err := r.Get("p1", n.ID)
	if err != nil {
		t.Fatalf("mixed-type tags must not kill the note, got %v", err)
	}
	if got.Title != "带标签篇" || len(got.Tags) != 2 || got.Tags[0] != "ok" || got.Tags[1] != "好标签" {
		t.Errorf("expected string elements kept (normalized), got %+v", got)
	}

	// 形态②：tags 整体不是数组（手改坏数据）——当无标签，篇仍可读
	if err := doc.Update("notesmulti", key, []byte(`{"id":"`+n.ID+`","title":"带标签篇","content":"body","tags":"oops"}`)); err != nil {
		t.Fatalf("seed non-array tags: %v", err)
	}
	if got, err = r.Get("p1", n.ID); err != nil || got.Content != "body" || got.Tags != nil {
		t.Errorf("non-array tags must degrade to nil tags, got %+v err=%v", got, err)
	}

	// 形态③：整篇非法 JSON —— 维持原语义（ErrNotFound，filestore 损坏隔离承接）
	if err := doc.Update("notesmulti", key, []byte(`{not-json`)); err != nil {
		t.Fatalf("seed broken doc: %v", err)
	}
	if _, err := r.Get("p1", n.ID); err != store.ErrNotFound {
		t.Errorf("broken JSON should stay ErrNotFound, got %v", err)
	}
}

