package store_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 笔记单库化迁移（P-20261108-3）：非全局作用域篇 → 全局库。钉住验收面——
// 内容零丢失、「[项目名] 」标题前缀、回收站篇保软删态、满额即中止留待续迁、
// 确定性目标 id 的幂等（重跑/删源失败残留只删源）、降级窗口改写另存不丢、
// 旧单篇键经两段迁移链直达全局库 ──

func newMigrationTestStores(t *testing.T) (store.DocumentStore, store.MultiNotesStore) {
	t.Helper()
	fs := filestore.New(filepath.Join(t.TempDir(), "data"))
	return fs, store.NewMultiNotesRepo(fs)
}

// globalByTitle 全局库（含回收站）按标题取篇
func globalByTitle(t *testing.T, r store.MultiNotesStore) map[string]store.MultiNote {
	t.Helper()
	notes, err := r.List(store.GlobalNotesScope)
	if err != nil {
		t.Fatalf("List global: %v", err)
	}
	out := map[string]store.MultiNote{}
	for _, n := range notes {
		out[n.Title] = n
	}
	return out
}

// TestNotesMigration_PrefixContentTrashAndOrphan 主干：项目篇带「[项目名] 」前缀
// 并入、内容逐字保留、空标题默认篇落「[项目名]」、回收站篇保软删态与时刻、
// 未登记作用域（项目已删的孤儿）保原标题；源键全部清空
func TestNotesMigration_PrefixContentTrashAndOrphan(t *testing.T) {
	_, r := newMigrationTestStores(t)
	a, _ := r.Create("p1", "交接说明", "# A 篇\n\n正文")
	if _, err := r.UpsertDefault("p1", "默认篇内容", nil); err != nil {
		t.Fatalf("seed default: %v", err)
	}
	trashed, _ := r.Create("p1", "旧篇", "回收站内容")
	if err := r.SoftDelete("p1", trashed.ID, "human"); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	src, _ := r.Get("p1", trashed.ID)
	if _, err := r.Create("ghost-project", "孤儿篇", "孤儿内容"); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}
	pre, _ := r.Create(store.GlobalNotesScope, "已有全局篇", "g")

	res, err := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if res.Migrated != 4 || res.Pending != 0 || res.Full {
		t.Fatalf("result = %+v, want migrated=4 pending=0 full=false", res)
	}

	g := globalByTitle(t, r)
	if n, ok := g["[alpha] 交接说明"]; !ok || n.Content != a.Content || !n.Live() {
		t.Errorf("prefixed live note missing/mismatch: %+v", n)
	}
	if n, ok := g["[alpha]"]; !ok || n.Content != "默认篇内容" {
		t.Errorf("empty-title default note should become [alpha]: %+v", g)
	}
	n, ok := g["[alpha] 旧篇"]
	if !ok || n.Live() || n.DeletedAt == nil || !n.DeletedAt.Equal(*src.DeletedAt) || n.DeletedBy != "human" {
		t.Errorf("trashed note must keep soft-delete state and timestamp: %+v", n)
	}
	if n, ok := g["孤儿篇"]; !ok || n.Content != "孤儿内容" {
		t.Errorf("orphan note must migrate with original title: %+v", g)
	}
	if _, ok := g["已有全局篇"]; !ok || g["已有全局篇"].ID != pre.ID {
		t.Error("pre-existing global note must stay untouched")
	}
	// 时间戳保源值（列表序反映真实编辑时刻）
	if got := g["[alpha] 交接说明"]; !got.UpdatedAt.Equal(a.UpdatedAt) {
		t.Errorf("updatedAt should be preserved: %v vs %v", got.UpdatedAt, a.UpdatedAt)
	}
	// 源作用域清空 + 滞留计数归零
	if left, _ := r.List("p1"); len(left) != 0 {
		t.Errorf("project scope should be empty after migration, got %d", len(left))
	}
	if p, err := r.PendingProjectNotes(); err != nil || p != 0 {
		t.Errorf("PendingProjectNotes = %d err=%v, want 0", p, err)
	}
}

// TestNotesMigration_FullAbortAndResume 满额即中止（不越限、不迁回收站歧路）：
// 剩余额度只够 1 篇 → 在册最近更新篇优先；滞留计数如实；腾出空间后续迁收尾
func TestNotesMigration_FullAbortAndResume(t *testing.T) {
	_, r := newMigrationTestStores(t)
	for i := 0; i < store.NotesMaxGlobal-1; i++ {
		if _, err := r.Create(store.GlobalNotesScope, "", "filler"); err != nil {
			t.Fatalf("fill #%d: %v", i, err)
		}
	}
	older, _ := r.Create("p1", "较旧在册", "older")
	time.Sleep(5 * time.Millisecond)
	newer, _ := r.Create("p1", "较新在册", "newer")
	time.Sleep(5 * time.Millisecond)
	tr, _ := r.Create("p1", "回收站篇", "trashed")
	_ = r.SoftDelete("p1", tr.ID, "human") // 回收站篇即便最新也排在在册篇之后

	res, err := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if res.Migrated != 1 || res.Pending != 2 || !res.Full {
		t.Fatalf("result = %+v, want migrated=1 pending=2 full=true", res)
	}
	if c, _ := r.CountLive(store.GlobalNotesScope); c != store.NotesMaxGlobal {
		t.Errorf("global count = %d, must not exceed %d", c, store.NotesMaxGlobal)
	}
	if _, ok := globalByTitle(t, r)["[alpha] 较新在册"]; !ok {
		t.Error("most recently updated live note should win the last slot")
	}
	if _, err := r.Get("p1", newer.ID); err != store.ErrNotFound {
		t.Errorf("migrated source should be removed, got %v", err)
	}
	if _, err := r.Get("p1", older.ID); err != nil {
		t.Errorf("unmigrated source must stay intact (zero loss): %v", err)
	}
	if p, _ := r.PendingProjectNotes(); p != 2 {
		t.Errorf("PendingProjectNotes = %d, want 2", p)
	}

	// 腾出空间（人侧彻底删除两篇）→ 续迁收尾
	all, _ := r.List(store.GlobalNotesScope)
	purged := 0
	for _, n := range all {
		if n.Title == "" && purged < 2 {
			_ = r.Purge(store.GlobalNotesScope, n.ID)
			purged++
		}
	}
	res2, err := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"})
	if err != nil || res2.Migrated != 2 || res2.Pending != 0 || res2.Full {
		t.Fatalf("resume result = %+v err=%v, want migrated=2 pending=0", res2, err)
	}
	if n, ok := globalByTitle(t, r)["[alpha] 回收站篇"]; !ok || n.Live() {
		t.Errorf("trashed note should resume into global trash: %+v", n)
	}
}

// TestNotesMigration_IdempotentAndDowngradeWindow 确定性目标 id：重跑零新增；
// 「目标已落、删源失败」残留（同键同内容复现）只删源不重复入库；降级窗口内
// 旧二进制改写过的源（同键异内容）另存一篇——零丢弃优先于去重
func TestNotesMigration_IdempotentAndDowngradeWindow(t *testing.T) {
	fs, r := newMigrationTestStores(t)
	n, _ := r.Create("p1", "交接", "v1")
	key := "p1-" + n.ID
	raw, err := fs.Get("notesmulti", key)
	if err != nil {
		t.Fatalf("read source doc: %v", err)
	}

	if res, err := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"}); err != nil || res.Migrated != 1 {
		t.Fatalf("first run = %+v err=%v", res, err)
	}
	if res, _ := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"}); res.Migrated != 0 || res.Pending != 0 {
		t.Fatalf("re-run must be a no-op, got %+v", res)
	}

	// 删源失败残留形态：同键同内容复现 → 只删源
	if err := fs.Create("notesmulti", key, raw); err != nil {
		t.Fatalf("reseed source: %v", err)
	}
	res, _ := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"})
	if res.Migrated != 0 || res.Pending != 0 {
		t.Fatalf("leftover source must only be cleaned, got %+v", res)
	}
	if c, _ := r.CountLive(store.GlobalNotesScope); c != 1 {
		t.Errorf("no duplicate expected, global count = %d", c)
	}
	if _, err := fs.Get("notesmulti", key); err == nil {
		t.Error("leftover source should be removed")
	}

	// 降级窗口改写：同键异内容 → 另存一篇
	var doc store.MultiNote
	_ = json.Unmarshal(raw, &doc)
	doc.Content = "v2 written by old binary"
	b, _ := json.Marshal(doc)
	if err := fs.Create("notesmulti", key, b); err != nil {
		t.Fatalf("reseed rewritten source: %v", err)
	}
	if res, _ := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"}); res.Migrated != 1 {
		t.Fatalf("rewritten source must migrate as a new note, got %+v", res)
	}
	notes, _ := r.List(store.GlobalNotesScope)
	contents := map[string]bool{}
	for _, n := range notes {
		contents[n.Content] = true
	}
	if !contents["v1"] || !contents["v2 written by old binary"] {
		t.Errorf("both versions must survive, got %v", contents)
	}
}

// TestNotesMigration_TitleBounds 标题守 200 字节上限（rune 边界不劈字）；已带
// 同前缀不叠加
func TestNotesMigration_TitleBounds(t *testing.T) {
	_, r := newMigrationTestStores(t)
	longTitle := strings.Repeat("标", 66) // 198B
	if _, err := r.Create("p1", longTitle, "c1"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := r.Create("p1", "[alpha] 已带前缀", "c2"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := r.Create("p2", "", "c3"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	labels := map[string]string{"p1": "alpha", "p2": strings.Repeat("项", 80)} // 240B 项目名
	if res, err := r.MigrateProjectNotesToGlobal(labels); err != nil || res.Migrated != 3 {
		t.Fatalf("migrate = %+v err=%v", res, err)
	}
	notes, _ := r.List(store.GlobalNotesScope)
	seenNoDouble := false
	for _, n := range notes {
		if len(n.Title) > store.NotesMaxTitleBytes || !utf8.ValidString(n.Title) {
			t.Errorf("title out of bound or split rune: %q (%dB)", n.Title, len(n.Title))
		}
		if n.Title == "[alpha] 已带前缀" {
			seenNoDouble = true
		}
		if n.Content == "c1" && !strings.HasPrefix(n.Title, "[alpha] 标") {
			t.Errorf("long title should keep prefix and be truncated: %q", n.Title)
		}
		if n.Content == "c3" && (!strings.HasPrefix(n.Title, "[项") || !strings.HasSuffix(n.Title, "]")) {
			t.Errorf("oversized project name should be truncated inside brackets: %q", n.Title)
		}
	}
	if !seenNoDouble {
		t.Error("existing same prefix must not be doubled")
	}
}

// TestNotesMigration_LegacyChain 旧单篇键（projnotes kind，P-20261002-110 形态）
// 经两段迁移链直达全局库：MigrateLegacyProjectNotes → 项目默认篇 →
// MigrateProjectNotesToGlobal → 「[项目名]」全局篇（旧数据面 + 新二进制）
func TestNotesMigration_LegacyChain(t *testing.T) {
	fs, r := newMigrationTestStores(t)
	if err := store.NewProjectNotesRepo(fs).Put("p1", "# 单篇时代交接"); err != nil {
		t.Fatalf("seed legacy: %v", err)
	}
	if n, err := r.MigrateLegacyProjectNotes(); err != nil || n != 1 {
		t.Fatalf("legacy step: n=%d err=%v", n, err)
	}
	if res, err := r.MigrateProjectNotesToGlobal(map[string]string{"p1": "alpha"}); err != nil || res.Migrated != 1 {
		t.Fatalf("global step = %+v err=%v", res, err)
	}
	if n, ok := globalByTitle(t, r)["[alpha]"]; !ok || n.Content != "# 单篇时代交接" {
		t.Errorf("legacy content should land in global library as [alpha]: %+v", n)
	}
	if p, _ := r.PendingProjectNotes(); p != 0 {
		t.Errorf("pending = %d, want 0", p)
	}
}
