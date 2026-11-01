package store_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newDailyReportTestStore 构造基于临时目录的独立日报存档仓储（不污染全局 Store）
func newDailyReportTestStore(t *testing.T) store.DailyReportStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	return store.NewDailyReportRepo(filestore.New(dir))
}

// seedDailyReport 落一份最小存档，返回仓储便于链式播种
func seedDailyReport(t *testing.T, r store.DailyReportStore, date, projectID string, commits int) {
	t.Helper()
	err := r.Save(store.DailyReport{
		ProjectID:   projectID,
		ProjectName: "p-" + projectID,
		Date:        date,
		Commits:     commits,
	})
	if err != nil {
		t.Fatalf("seed %s/%s: %v", date, projectID, err)
	}
}

// TestDailyReport_SaveUpsert 落档即持久；同键（项目+日期）重落为整体覆盖
// 而非新档（同日重发/补跑的 upsert 语义）
func TestDailyReport_SaveUpsert(t *testing.T) {
	r := newDailyReportTestStore(t)

	seedDailyReport(t, r, "2026-10-02", "p1", 2)
	got, err := r.ListByDate("2026-10-02")
	if err != nil || len(got) != 1 {
		t.Fatalf("ListByDate = %v, %v; want 1 条", got, err)
	}
	if got[0].ProjectID != "p1" || got[0].Commits != 2 {
		t.Fatalf("archived = %+v, want p1/commits=2", got[0])
	}

	// 同键重落：覆盖（计数翻倍、附带主题明细），不产生第二条
	err = r.Save(store.DailyReport{
		ProjectID: "p1", ProjectName: "p1", Date: "2026-10-02",
		Commits: 4, CommitSubjects: []string{"feat: a", "fix: b"}, ClaudeTokens: 2800,
	})
	if err != nil {
		t.Fatalf("re-save: %v", err)
	}
	got, err = r.ListByDate("2026-10-02")
	if err != nil || len(got) != 1 {
		t.Fatalf("after upsert ListByDate = %v, %v; want 仍 1 条", got, err)
	}
	if got[0].Commits != 4 || len(got[0].CommitSubjects) != 2 || got[0].ClaudeTokens != 2800 {
		t.Fatalf("upsert 未覆盖: %+v", got[0])
	}

	// 非法入参拒绝：空项目 ID / 伪日期（含越界月日）
	if err := r.Save(store.DailyReport{ProjectID: "", Date: "2026-10-02"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("empty projectID: want ErrInvalidArg, got %v", err)
	}
	if err := r.Save(store.DailyReport{ProjectID: "p1", Date: "2026-13-40"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("bogus date: want ErrInvalidArg, got %v", err)
	}
}

// TestDailyReport_ListOrderAndLimit 列表倒序（date 降序），同日按项目 ID 升序；
// limit 截断取最新；非法日期查详情返回 ErrInvalidArg
func TestDailyReport_ListOrderAndLimit(t *testing.T) {
	r := newDailyReportTestStore(t)

	seedDailyReport(t, r, "2026-09-30", "pb", 1)
	seedDailyReport(t, r, "2026-10-02", "pa", 2)
	seedDailyReport(t, r, "2026-10-02", "pc", 3)
	seedDailyReport(t, r, "2026-10-01", "pd", 4)

	got, err := r.List(0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	wantOrder := []struct{ date, id string }{
		{"2026-10-02", "pa"}, {"2026-10-02", "pc"}, {"2026-10-01", "pd"}, {"2026-09-30", "pb"},
	}
	if len(got) != len(wantOrder) {
		t.Fatalf("List len = %d, want %d", len(got), len(wantOrder))
	}
	for i, w := range wantOrder {
		if got[i].Date != w.date || got[i].ProjectID != w.id {
			t.Fatalf("List[%d] = %s/%s, want %s/%s", i, got[i].Date, got[i].ProjectID, w.date, w.id)
		}
	}

	// limit 截断取最新（倒序头部）
	top, err := r.List(2)
	if err != nil || len(top) != 2 || top[0].Date != "2026-10-02" || top[1].Date != "2026-10-02" {
		t.Fatalf("List(2) = %+v, %v; want 最新日两条", top, err)
	}

	// 单日详情只含该日；无存档日返回空切片非错误
	day, err := r.ListByDate("2026-10-01")
	if err != nil || len(day) != 1 || day[0].ProjectID != "pd" {
		t.Fatalf("ListByDate(10-01) = %+v, %v", day, err)
	}
	empty, err := r.ListByDate("2026-09-01")
	if err != nil || len(empty) != 0 {
		t.Fatalf("ListByDate(无档日) = %+v, %v; want 空+nil", empty, err)
	}
	if _, err := r.ListByDate("not-a-date"); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("ListByDate(畸形) = %v, want ErrInvalidArg", err)
	}
}

// TestDailyReport_CleanupBefore 滚动清理只删窗口外旧档（键前缀日期直判，
// 窗口内与当天边界档保留），幂等重跑零删除
func TestDailyReport_CleanupBefore(t *testing.T) {
	r := newDailyReportTestStore(t)

	seedDailyReport(t, r, "2026-09-01", "old", 1)
	seedDailyReport(t, r, "2026-09-18", "stale", 1)
	seedDailyReport(t, r, "2026-09-19", "edge", 1) // 截止日当天：保留（严格小于才删）
	seedDailyReport(t, r, "2026-10-02", "fresh", 1)

	// before = 2026-09-19：严格早于该日的删除（09-01 与 09-18 入删，边界档保留）
	cutoff := time.Date(2026, 9, 19, 0, 0, 0, 0, time.Local)
	removed, err := r.CleanupBefore(cutoff)
	if err != nil || removed != 2 {
		t.Fatalf("CleanupBefore = %d, %v; want 2", removed, err)
	}
	got, err := r.List(0)
	if err != nil || len(got) != 2 {
		t.Fatalf("after cleanup List = %d 条, %v; want 2", len(got), err)
	}
	for _, g := range got {
		if g.ProjectID == "old" || g.ProjectID == "stale" {
			t.Fatalf("窗口外旧档未被删除: %+v", g)
		}
	}
	// 截止日当天（edge）与 fresh 必须仍在：len==2 + 无 old/stale 已隐含；
	// 显式点名断言防将来排序/形状改动把边界档悄悄弄丢
	day, err := r.ListByDate("2026-09-19")
	if err != nil || len(day) != 1 || day[0].ProjectID != "edge" {
		t.Fatalf("截止日当天档案应保留, got %+v, %v", day, err)
	}

	// 幂等：再跑一轮零删除
	removed, err = r.CleanupBefore(cutoff)
	if err != nil || removed != 0 {
		t.Fatalf("idempotent cleanup = %d, %v; want 0", removed, err)
	}
}
