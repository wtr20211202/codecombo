package system

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 本机体检趋势链路单测（P-20261005-169）：每日定时「当日已办」判定与手动
// 体检入账/对比面组装是响应契约（前端趋势条隐藏/展示的依据），以注入提取口
// 的确定值钉死。真实磁盘/内存/会话值随环境漂移，不在此断言；快照时间由用例
// 注入（Append 对零值 Time 落真实墙钟，依赖真实日期会让去重用例跨日漂移）。

// withSelfCheckTestEnv 装配独立存储 + 注入确定值提取口（还原经 t.Cleanup）
func withSelfCheckTestEnv(t *testing.T, collect func() store.SelfCheckSnapshot) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	orig := selfCheckCollect
	selfCheckCollect = collect
	t.Cleanup(func() {
		selfCheckCollect = orig
		store.SetDefault(nil)
	})
}

// TestSelfCheckDailySnapshotDedup 每日定时：同日只入账一次，跨日补拍。去重
// 凭据是已落盘最新快照的日期（无内存标记），故第二次进程生命周期的首条巡检
// 与首次同判——重启追赶零额外状态即由此保证
func TestSelfCheckDailySnapshotDedup(t *testing.T) {
	snapDay := time.Date(2026, 10, 15, 9, 0, 0, 0, time.Local)
	withSelfCheckTestEnv(t, func() store.SelfCheckSnapshot {
		return store.SelfCheckSnapshot{Time: snapDay, DiskAvailMB: 20480, Terminals: 2}
	})

	if !maybeSelfCheckDailySnapshot(snapDay) {
		t.Fatal("first tick of the day must append a snapshot")
	}
	// 同日后续巡检（含重启后的首条巡检——Latest 落盘即恢复）不再入账
	if maybeSelfCheckDailySnapshot(snapDay.Add(7 * time.Hour)) {
		t.Fatal("same-day tick must be a no-op")
	}
	// 次日到点补拍
	snapDay = snapDay.Add(24 * time.Hour)
	if !maybeSelfCheckDailySnapshot(snapDay) {
		t.Fatal("next-day tick must append")
	}
	if hist := store.Get().SelfCheckHist.History(0); len(hist) != 2 {
		t.Fatalf("expected 2 snapshots after two days, got %d", len(hist))
	}
}

// TestSameLocalDate 同日判定：本地时区日历日相同即同日（跨日零点边界）
func TestSameLocalDate(t *testing.T) {
	base := time.Date(2026, 10, 15, 23, 50, 0, 0, time.Local)
	if !sameLocalDate(base, base.Add(5*time.Minute)) {
		t.Error("same calendar day should match")
	}
	if sameLocalDate(base, base.Add(20*time.Minute)) {
		t.Error("midnight crossing should not match")
	}
	if sameLocalDate(base, base.Add(24*time.Hour)) {
		t.Error("next day should not match")
	}
}

// TestRecordSelfCheckSnapshot 手动体检入账：首次无 prev（前端隐藏趋势条），
// 第二次起带 prev+delta 且 runs 递增；本次快照已入账（latest 即本次）
func TestRecordSelfCheckSnapshot(t *testing.T) {
	withSelfCheckTestEnv(t, func() store.SelfCheckSnapshot {
		return store.SelfCheckSnapshot{DiskAvailMB: 20480, MemUsedMB: 512, Terminals: 3}
	})

	first := recordSelfCheckSnapshot()
	if first.Prev != nil || first.Delta != nil {
		t.Fatalf("first check must have no prev/delta, got %+v", first)
	}
	if first.Runs != 1 {
		t.Fatalf("first check runs = %d, want 1", first.Runs)
	}
	if first.Latest.DiskAvailMB != 20480 || first.Latest.Terminals != 3 {
		t.Fatalf("latest = %+v, want the injected snapshot", first.Latest)
	}

	selfCheckCollect = func() store.SelfCheckSnapshot {
		return store.SelfCheckSnapshot{DiskAvailMB: 19456, MemUsedMB: 640, Terminals: 5}
	}
	second := recordSelfCheckSnapshot()
	if second.Prev == nil || second.Delta == nil {
		t.Fatalf("second check must carry prev/delta, got %+v", second)
	}
	if second.Delta.DiskAvailMB != -1024 || second.Delta.MemUsedMB != 128 || second.Delta.Terminals != 2 {
		t.Fatalf("delta = %+v, want disk -1024 / mem +128 / terminals +2", second.Delta)
	}
	if second.Prev.DiskAvailMB != 20480 {
		t.Fatalf("prev = %+v, want the first snapshot", second.Prev)
	}
	if second.Runs != 2 {
		t.Fatalf("second check runs = %d, want 2", second.Runs)
	}
}

// TestRecordSelfCheckSnapshotNilStore 未装配全局 Store（极端：store 就绪前的
// 请求窗口）时不入账不 panic，latest 仍回应当次体检
func TestRecordSelfCheckSnapshotNilStore(t *testing.T) {
	withSelfCheckTestEnv(t, func() store.SelfCheckSnapshot {
		return store.SelfCheckSnapshot{DiskAvailMB: 1024, Terminals: 1}
	})

	store.SetDefault(nil)
	info := recordSelfCheckSnapshot()
	if info.Latest.Terminals != 1 || info.Runs != 0 || info.Prev != nil {
		t.Fatalf("nil-store record = %+v, want latest-only payload", info)
	}
}
