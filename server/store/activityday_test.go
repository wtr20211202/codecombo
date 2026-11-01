package store_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newActivityDayTestStore 构造基于临时目录的独立活动序列仓储（不污染全局 Store）
func newActivityDayTestStore(t *testing.T) store.ActivityDayStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	return store.NewActivityDayRepo(filestore.New(dir))
}

// seedActivityDay 落一行最小活动序列，返回仓储便于链式播种
func seedActivityDay(t *testing.T, r store.ActivityDayStore, date string, commits, sessions, commands int) {
	t.Helper()
	err := r.Save(store.ActivityDay{Date: date, Commits: commits, Sessions: sessions, Commands: commands})
	if err != nil {
		t.Fatalf("seed %s: %v", date, err)
	}
}

// TestActivityDay_SaveUpsert 落行即持久；同日重落为整体覆盖（append 幂等——
// 重发/补跑重放同一聚合结果，不累计翻倍）
func TestActivityDay_SaveUpsert(t *testing.T) {
	r := newActivityDayTestStore(t)

	seedActivityDay(t, r, "2026-10-02", 3, 1, 12)
	got, err := r.List(0)
	if err != nil || len(got) != 1 {
		t.Fatalf("List = %v, %v; want 1 行", got, err)
	}
	if got[0].Commits != 3 || got[0].Sessions != 1 || got[0].Commands != 12 {
		t.Fatalf("row = %+v, want 3/1/12", got[0])
	}

	// 同日重落（日报重发场景）：覆盖而非追加，计数不翻倍
	seedActivityDay(t, r, "2026-10-02", 3, 1, 12)
	seedActivityDay(t, r, "2026-10-02", 5, 2, 20)
	got, err = r.List(0)
	if err != nil || len(got) != 1 {
		t.Fatalf("after upsert List = %v, %v; want 仍 1 行", got, err)
	}
	if got[0].Commits != 5 || got[0].Sessions != 2 || got[0].Commands != 20 {
		t.Fatalf("upsert 未覆盖: %+v", got[0])
	}

	// 伪日期拒绝（含越界月日）
	if err := r.Save(store.ActivityDay{Date: "2026-13-40"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("bogus date: want ErrInvalidArg, got %v", err)
	}
	if err := r.Save(store.ActivityDay{Date: ""}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("empty date: want ErrInvalidArg, got %v", err)
	}
}

// TestActivityDay_ListOrderAndClamp 列表 date 升序（旧→新，热力图列序直铺）；
// days 截断取最新段、超上限钳制；无数据返回空切片非错误
func TestActivityDay_ListOrderAndClamp(t *testing.T) {
	r := newActivityDayTestStore(t)

	// 空库：空切片非错误
	empty, err := r.List(30)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty List = %v, %v; want 空+nil", empty, err)
	}

	seedActivityDay(t, r, "2026-09-28", 1, 0, 0)
	seedActivityDay(t, r, "2026-10-01", 2, 1, 0)
	seedActivityDay(t, r, "2026-09-30", 3, 0, 4)
	seedActivityDay(t, r, "2026-10-02", 4, 0, 0)

	got, err := r.List(0) // 缺省 = 全量（≤上限）
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	wantDates := []string{"2026-09-28", "2026-09-30", "2026-10-01", "2026-10-02"}
	if len(got) != len(wantDates) {
		t.Fatalf("List len = %d, want %d", len(got), len(wantDates))
	}
	for i, w := range wantDates {
		if got[i].Date != w {
			t.Fatalf("List[%d] = %s, want %s（升序）", i, got[i].Date, w)
		}
	}

	// days 截断取最新段（升序尾部）
	tail, err := r.List(2)
	if err != nil || len(tail) != 2 || tail[0].Date != "2026-10-01" || tail[1].Date != "2026-10-02" {
		t.Fatalf("List(2) = %+v, %v; want 最新两行升序", tail, err)
	}
}

// TestActivityDay_CleanupBefore 滚动清理只删窗口外旧行（边界日保留——严格小于
// 才删），幂等重跑零删除；非法形状键跳过不误删
func TestActivityDay_CleanupBefore(t *testing.T) {
	r := newActivityDayTestStore(t)

	seedActivityDay(t, r, "2025-09-01", 1, 0, 0) // 365 天窗口外
	seedActivityDay(t, r, "2026-10-03", 1, 0, 0) // 截止日当天：保留
	seedActivityDay(t, r, "2026-10-04", 1, 0, 0)

	cutoff := time.Date(2026, 10, 3, 0, 0, 0, 0, time.Local)
	removed, err := r.CleanupBefore(cutoff)
	if err != nil || removed != 1 {
		t.Fatalf("CleanupBefore = %d, %v; want 1", removed, err)
	}
	got, err := r.List(0)
	if err != nil || len(got) != 2 || got[0].Date != "2026-10-03" || got[1].Date != "2026-10-04" {
		t.Fatalf("after cleanup List = %+v, %v; want 边界日+新鲜日保留", got, err)
	}

	// 幂等：再跑一轮零删除
	removed, err = r.CleanupBefore(cutoff)
	if err != nil || removed != 0 {
		t.Fatalf("idempotent cleanup = %d, %v; want 0", removed, err)
	}
}

// TestActivityDay_RetentionWindow 保留策略常量：365 天（车道表登记值，勿静默改动）
func TestActivityDay_RetentionWindow(t *testing.T) {
	if store.ActivityDayRetention != 365*24*time.Hour {
		t.Fatalf("ActivityDayRetention = %v, want 365d", store.ActivityDayRetention)
	}
}
