package claudesessions

import (
	"testing"
	"time"
)

// SessionsAt 单测（P-20261007-11）：时间窗匹配（含边界闭区间）/FirstAt 缺失
// 跳过/接近度排序（尾端近者优先）/上限截断如实上报/同距确定性

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return ts
}

func TestSessionsAtWindowMatch(t *testing.T) {
	base := mustTime(t, "2026-10-07T10:00:00Z")
	pool := []Session{
		{ID: "cover", Title: "覆盖窗口", FirstAt: base.Add(-time.Hour), LastAt: base.Add(time.Hour)},
		{ID: "before", Title: "窗口前结束", FirstAt: base.Add(-3 * time.Hour), LastAt: base.Add(-2 * time.Hour)},
		{ID: "after", Title: "窗口后开始", FirstAt: base.Add(2 * time.Hour), LastAt: base.Add(3 * time.Hour)},
	}
	res := SessionsAt(pool, base, SessionsAtLimitMax)
	if res.Total != 1 || len(res.Sessions) != 1 || res.Sessions[0].ID != "cover" {
		t.Fatalf("expect only 'cover' hit, got total=%d sessions=%v", res.Total, res.Sessions)
	}
	if res.Truncated {
		t.Fatal("not expect truncated")
	}

	// 边界闭区间：ts 恰等于 FirstAt / LastAt 均命中
	atFirst := SessionsAt(pool, base.Add(-time.Hour), 0)
	if atFirst.Total != 1 || atFirst.Sessions[0].ID != "cover" {
		t.Fatalf("ts==FirstAt should hit inclusively, got total=%d", atFirst.Total)
	}
	atLast := SessionsAt(pool, base.Add(time.Hour), 0)
	if atLast.Total != 1 || atLast.Sessions[0].ID != "cover" {
		t.Fatalf("ts==LastAt should hit inclusively, got total=%d", atLast.Total)
	}
}

func TestSessionsAtSkipsMissingFirstAt(t *testing.T) {
	base := mustTime(t, "2026-10-07T10:00:00Z")
	pool := []Session{
		{ID: "no-first", Title: "无时间戳行", LastAt: base.Add(time.Hour)}, // FirstAt 零值
	}
	res := SessionsAt(pool, base, 0)
	if res.Total != 0 || len(res.Sessions) != 0 {
		t.Fatalf("FirstAt-missing session must not match, got total=%d", res.Total)
	}
}

func TestSessionsAtProximityOrder(t *testing.T) {
	// 提交时刻 10:00：head-near 距其首端 1min，cover 距两端各 1min，tail-far
	// 距其尾端 5min → 接近度=min(|ts-LastAt|,|ts-FirstAt|) 升序；head-near 与
	// cover 同距（1min）时 LastAt 新者优先
	base := mustTime(t, "2026-10-07T10:00:00Z")
	pool := []Session{
		{ID: "tail-far", Title: "尾端 5 分钟", FirstAt: base.Add(-time.Hour), LastAt: base.Add(5 * time.Minute)},
		{ID: "head-near", Title: "首端 1 分钟", FirstAt: base.Add(-time.Minute), LastAt: base.Add(30 * time.Minute)},
		{ID: "cover", Title: "全程覆盖", FirstAt: base.Add(-time.Minute), LastAt: base.Add(time.Minute)},
	}
	res := SessionsAt(pool, base, 0)
	if res.Total != 3 {
		t.Fatalf("expect 3 hits, got %d", res.Total)
	}
	// cover：ts 在窗内且距两端各 1min → dist=1min；head-near 距首端 1min → 同距，
	// LastAt 新者（head-near 10:30 > cover 10:01）优先
	want := []string{"head-near", "cover", "tail-far"}
	for i, id := range want {
		if res.Sessions[i].ID != id {
			t.Fatalf("rank %d: expect %s got %s (all=%v)", i, id, res.Sessions[i].ID, res.Sessions)
		}
	}
}

func TestSessionsAtLimitTruncation(t *testing.T) {
	base := mustTime(t, "2026-10-07T10:00:00Z")
	pool := make([]Session, 0, SessionsAtLimitMax+3)
	for i := 0; i < SessionsAtLimitMax+3; i++ {
		pool = append(pool, Session{
			ID:      string(rune('a' + i)),
			FirstAt: base.Add(-time.Hour),
			// LastAt 依次错开：排序按接近度取新者（距 ts 最近），截断后应保序
			LastAt: base.Add(time.Duration(i) * time.Minute),
		})
	}
	res := SessionsAt(pool, base, 0)
	if res.Total != SessionsAtLimitMax+3 {
		t.Fatalf("Total should count pre-truncation hits, got %d", res.Total)
	}
	if !res.Truncated {
		t.Fatal("expect truncated=true")
	}
	if len(res.Sessions) != SessionsAtLimitMax {
		t.Fatalf("expect %d rows, got %d", SessionsAtLimitMax, len(res.Sessions))
	}
	// 接近度升序：本夹具全部 LastAt ≥ ts，距离升序 = LastAt 升序（首行 LastAt==ts）
	if !res.Sessions[0].LastAt.Equal(base) {
		t.Fatalf("closest (LastAt==ts) should rank first, got %v", res.Sessions[0].LastAt)
	}
	last := res.Sessions[0].LastAt
	for _, s := range res.Sessions[1:] {
		if s.LastAt.Before(last) {
			t.Fatalf("proximity order broken: %v before %v", s.LastAt, last)
		}
		last = s.LastAt
	}
}

func TestSessionsAtEmpty(t *testing.T) {
	res := SessionsAt(nil, mustTime(t, "2026-10-07T10:00:00Z"), 0)
	if res.Total != 0 || len(res.Sessions) != 0 || res.Truncated {
		t.Fatalf("empty pool should yield empty result, got %+v", res)
	}
}
