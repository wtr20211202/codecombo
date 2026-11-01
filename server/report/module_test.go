package report

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// TestModuleConformance 契约一致性自检（M1.6：内核模块生命周期契约验证）
func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}

// TestTickGate 到点巡检门槛：ReportHour 前不发、当日只发一轮、次日到点再发、
// store 未装配时静默跳过
func TestTickGate(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	m := NewModule()
	var calls []time.Time
	m.emitFn = func(now time.Time, _ Loaders, _ func(notification.Notification), _ func(store.DailyReport) error) int {
		calls = append(calls, now)
		return 0
	}

	day1 := time.Date(2026, 10, 2, 21, 0, 30, 0, time.Local)
	m.tick(day1.Add(-time.Hour)) // 20 点：未到点不发
	if len(calls) != 0 {
		t.Fatalf("emitted before report hour: %v", calls)
	}
	m.tick(day1)
	m.tick(day1.Add(time.Minute)) // 同日重复巡检：去重
	m.tick(day1.Add(2 * time.Hour))
	if len(calls) != 1 {
		t.Fatalf("emit calls = %d, want 1（当日只发一轮）", len(calls))
	}

	m.tick(time.Date(2026, 10, 3, 21, 0, 0, 0, time.Local)) // 次日到点再发
	if len(calls) != 2 {
		t.Fatalf("emit calls = %d, want 2（次日应再发）", len(calls))
	}
}

// TestTickNilStoreGuard store 未装配（裸模块单测环境）不发不炸
func TestTickNilStoreGuard(t *testing.T) {
	store.SetDefault(nil)
	t.Cleanup(func() { store.SetDefault(nil) })

	m := NewModule()
	called := false
	m.emitFn = func(time.Time, Loaders, func(notification.Notification), func(store.DailyReport) error) int {
		called = true
		return 0
	}
	m.tick(time.Date(2026, 10, 2, 21, 0, 0, 0, time.Local))
	if called {
		t.Fatal("emit should not run without assembled store")
	}
}

// TestTickSkipsWhenReportExists 当日日报已在通知中心（21 点后重启丢内存标记
// 的场景）：不再重发；昨日日报不拦今日
func TestTickSkipsWhenReportExists(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	m := NewModule()
	called := false
	m.emitFn = func(time.Time, Loaders, func(notification.Notification), func(store.DailyReport) error) int {
		called = true
		return 0
	}

	now := time.Date(2026, 10, 2, 21, 30, 0, 0, time.Local)
	// 播种当日日报（与 DailyNotification 同形状，Time 非零原样保留）
	s.Notification.Add(notification.Notification{
		Type: "info", Category: notification.CategorySystem,
		Title: "p · 今日动态", TitleKey: DailyTitleKey, BodyKey: "report.daily.body",
		Time: now.Add(-10 * time.Minute),
	})
	m.tick(now)
	if called {
		t.Fatal("today's existing report should suppress re-emit")
	}

	// 只剩昨日日报：今日到点照发（新 Module 实例——checkedOn 已被上一次
	// tick 置位，会先于通知扫描拦截，而那正是另一条被测路径）
	s.Notification.Clear()
	s.Notification.Add(notification.Notification{
		Type: "info", Category: notification.CategorySystem,
		Title: "p · 今日动态", TitleKey: DailyTitleKey, BodyKey: "report.daily.body",
		Time: now.AddDate(0, 0, -1),
	})
	m2 := NewModule()
	called2 := false
	m2.emitFn = func(time.Time, Loaders, func(notification.Notification), func(store.DailyReport) error) int {
		called2 = true
		return 0
	}
	m2.tick(now)
	if !called2 {
		t.Fatal("yesterday's report must not suppress today's emit")
	}
}

// TestTick_CleanupArchives 存档滚动清理随当日首次巡检执行（P-20261003-4）：
// 窗口外旧档删除、窗口内保留；去重早退路径（当日已发）同样不缺勤
func TestTick_CleanupArchives(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	now := time.Date(2026, 10, 2, 21, 0, 0, 0, time.Local)
	old := now.AddDate(0, 0, -20).Format("2006-01-02")
	fresh := now.AddDate(0, 0, -1).Format("2006-01-02")
	for _, seed := range []struct{ date, id string }{{old, "old"}, {fresh, "fresh"}} {
		if err := s.DailyReport.Save(store.DailyReport{ProjectID: seed.id, ProjectName: seed.id, Date: seed.date}); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	// 无项目（Emit 零产出）也要清到旧档：清理在去重扫描之前、与发报解耦
	NewModule().tick(now)
	keys, _, _ := doc.List("dailyreport", store.ListOpts{})
	if len(keys) != 1 || !strings.HasPrefix(keys[0], fresh+"_") {
		t.Fatalf("after tick keys = %v, want 仅剩窗口内 %s", keys, fresh)
	}

	// 幂等：当日第二次巡检（checkedOn 去重）不再重复处理
	m := NewModule()
	m.tick(now)
	m.tick(now.Add(time.Minute))
	keys, _, _ = doc.List("dailyreport", store.ListOpts{})
	if len(keys) != 1 {
		t.Fatalf("second tick keys = %v, want 不变", keys)
	}
}

// TestTickWritesArchive 真实链路接线（ Emit 默认口 + 落档口）：有提交的当日
// 项目到点巡检 → 通知与存档同批产出，存档事实与通知 MsgParams 同源
func TestTickWritesArchive(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	repo := gitRepoFixture(t)
	// 提交时间伪造进合成当日窗口（tick 的 now 是固定值，非真实此刻）
	commit(t, repo, "a.txt", "feat: today", "2026-10-02T12:00:00")

	if err := s.Project.Create(config.ProjectConfig{ID: "p1", Name: "alpha", Path: repo}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	now := time.Date(2026, 10, 2, 21, 0, 0, 0, time.Local)
	NewModule().tick(now)

	if got := len(s.Notification.List(0)); got != 1 {
		t.Fatalf("notifications = %d, want 1", got)
	}
	archived, err := s.DailyReport.ListByDate(now.Format("2006-01-02"))
	if err != nil || len(archived) != 1 {
		t.Fatalf("archive = %v, %v; want 1 条", archived, err)
	}
	if archived[0].Commits != 1 || archived[0].CommitSubjects[0] != "feat: today" {
		t.Fatalf("archived = %+v, want 当日 1 提交", archived[0])
	}
}

// TestTick_AppendsActivity 活动序列挂点（P-20261003-37）：真实链路到点巡检 →
// 存档落库顺带 upsert 实例级单日行（三项数值与各项目存档之和一致，多项目累计）；
// 零活动日不落行（热力图缺行即空档）
func TestTick_AppendsActivity(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	repo := gitRepoFixture(t)
	commit(t, repo, "a.txt", "feat: today", "2026-10-02T12:00:00")
	commit(t, repo, "b.txt", "fix: today too", "2026-10-02T13:00:00")
	if err := s.Project.Create(config.ProjectConfig{ID: "p1", Name: "alpha", Path: repo}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	now := time.Date(2026, 10, 2, 21, 0, 0, 0, time.Local)
	NewModule().tick(now)

	rows, err := s.ActivityDay.List(0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("activity rows = %v, %v; want 1 行", rows, err)
	}
	if rows[0].Date != "2026-10-02" || rows[0].Commits != 2 {
		t.Fatalf("row = %+v, want 2026-10-02/commits=2", rows[0])
	}

	// 同日重复巡检：checkedOn 去重不再 emit，活动行不重放（append 幂等靠覆盖）
	NewModule().tick(now.Add(time.Minute))
	rows, _ = s.ActivityDay.List(0)
	if len(rows) != 1 || rows[0].Commits != 2 {
		t.Fatalf("second tick rows = %+v, want 不变", rows)
	}

	// 零活动日：无任何项目事实时新巡检不落零行
	s.Notification.Clear()
	NewModule().tick(time.Date(2026, 10, 3, 21, 0, 0, 0, time.Local))
	rows, _ = s.ActivityDay.List(0)
	if len(rows) != 1 {
		t.Fatalf("zero-activity day rows = %+v, want 仍 1 行", rows)
	}
}

// TestRunDaily_BackfillAppendsActivityHistory 手动补历史档：活动行落历史日
// （热力图回看口径与存档一致）；重放覆盖不翻倍（append 幂等）
func TestRunDaily_BackfillAppendsActivityHistory(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	repo := gitRepoFixture(t)
	commit(t, repo, "old.txt", "feat: backfill", "2026-09-20T12:00:00")
	commit(t, repo, "old2.txt", "fix: backfill again", "2026-09-20T13:00:00")
	if err := s.Project.Create(config.ProjectConfig{ID: "p1", Name: "alpha", Path: repo}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	past := time.Date(2026, 9, 20, 10, 0, 0, 0, time.Local)
	if n := RunDaily(past); n != 1 {
		t.Fatalf("RunDaily(past) = %d, want 1", n)
	}
	rows, err := s.ActivityDay.List(0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("activity rows = %v, %v; want 1 行", rows, err)
	}
	if rows[0].Date != "2026-09-20" || rows[0].Commits != 2 {
		t.Fatalf("row = %+v, want 2026-09-20/commits=2", rows[0])
	}

	// 重放同日补档：整体覆盖，仍 1 行
	if n := RunDaily(past); n != 1 {
		t.Fatalf("re-run = %d, want 1", n)
	}
	rows, _ = s.ActivityDay.List(0)
	if len(rows) != 1 || rows[0].Commits != 2 {
		t.Fatalf("after replay rows = %+v, want 不变（覆盖不翻倍）", rows)
	}
}

// TestTick_CleansActivitySeries 活动序列滚动清理随当日首次巡检执行（365 天
// 窗口），与存档清理同点位；去重早退路径不缺勤
func TestTick_CleansActivitySeries(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	now := time.Date(2026, 10, 2, 21, 0, 0, 0, time.Local)
	for _, d := range []string{
		now.AddDate(0, 0, -400).Format("2006-01-02"), // 窗口外
		now.AddDate(0, 0, -1).Format("2006-01-02"),   // 窗口内
	} {
		if err := s.ActivityDay.Save(store.ActivityDay{Date: d, Commits: 1}); err != nil {
			t.Fatalf("seed %s: %v", d, err)
		}
	}

	NewModule().tick(now)
	rows, err := s.ActivityDay.List(0)
	if err != nil || len(rows) != 1 || rows[0].Date != now.AddDate(0, 0, -1).Format("2006-01-02") {
		t.Fatalf("rows = %+v, %v; want 仅剩窗口内一行", rows, err)
	}
}

// TestRunDaily_BackfillNoNotify 手动补历史档：只落档不投递（往日日报不在
// 今天的通知流里复活）；今天 = 全量投递+落档
func TestRunDaily_BackfillNoNotify(t *testing.T) {
	doc := filestore.New(t.TempDir())
	s := store.New(doc)
	store.SetDefault(s)
	t.Cleanup(func() { store.SetDefault(nil) })

	repo := gitRepoFixture(t)
	commit(t, repo, "old.txt", "feat: backfill", "2026-09-20T12:00:00")
	commit(t, repo, "new.txt", "feat: today", "")
	if err := s.Project.Create(config.ProjectConfig{ID: "p1", Name: "alpha", Path: repo}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	// 补历史日：存档落 09-20，通知零新增
	past := time.Date(2026, 9, 20, 10, 0, 0, 0, time.Local)
	if n := RunDaily(past); n != 1 {
		t.Fatalf("RunDaily(past) = %d, want 1", n)
	}
	if got := len(s.Notification.List(0)); got != 0 {
		t.Fatalf("backfill notifications = %d, want 0（补档不投递）", got)
	}
	archived, err := s.DailyReport.ListByDate("2026-09-20")
	if err != nil || len(archived) != 1 || archived[0].Commits != 1 {
		t.Fatalf("backfill archive = %+v, %v; want 09-20 一条 1 提交", archived, err)
	}

	// 今天：通知 + 存档都产出（存档覆盖 upsert，仍各一条）
	if n := RunDaily(time.Time{}); n != 1 {
		t.Fatalf("RunDaily(today) = %d, want 1", n)
	}
	if got := len(s.Notification.List(0)); got != 1 {
		t.Fatalf("today notifications = %d, want 1", got)
	}
	today := time.Now().Format("2006-01-02")
	archived, err = s.DailyReport.ListByDate(today)
	if err != nil || len(archived) != 1 || archived[0].Commits != 1 {
		t.Fatalf("today archive = %+v, %v; want 1 条", archived, err)
	}
}
