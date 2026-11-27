package shareapi

import "testing"

// P-20261124-1 S1⑥：share 计时双环——最近 20 保时间序、最慢 20 保慢样本，
// 防止 30s 轮询把单次 2m33s 的慢调用挤出「最近」环后无从复查
func TestShareCallRingsKeepRecentAndSlowest(t *testing.T) {
	resetShareCallStatsForTest()
	t.Cleanup(resetShareCallStatsForTest)
	for i := 0; i < shareCallRingSize+5; i++ {
		recordShareCall(ShareCallSample{
			At:      "2026-11-24T21:37:00Z",
			TotalMS: int64(i),
			Items:   1,
			SlowItems: []ShareSlowItem{{
				Kind: "file", Snapshot: true, ProjectID: "p1", Health: "ok", DurationMS: int64(i),
			}},
		})
	}
	doc, ok := ShareHealthStats().(shareHealthDoc)
	if !ok {
		t.Fatalf("ShareHealthStats type = %T", ShareHealthStats())
	}
	if doc.Status != "ok" || doc.Calls != int64(shareCallRingSize+5) {
		t.Fatalf("doc status/calls = %q/%d", doc.Status, doc.Calls)
	}
	if len(doc.Recent) != shareCallRingSize {
		t.Fatalf("recent ring = %d, want %d", len(doc.Recent), shareCallRingSize)
	}
	if len(doc.Slowest) != shareCallRingSize {
		t.Fatalf("slowest ring = %d, want %d", len(doc.Slowest), shareCallRingSize)
	}
	if doc.Slowest[0].TotalMS != int64(shareCallRingSize+4) {
		t.Fatalf("slowest[0] = %d, want the max call", doc.Slowest[0].TotalMS)
	}
	if doc.Recent[len(doc.Recent)-1].TotalMS != int64(shareCallRingSize+4) {
		t.Fatalf("recent must keep insertion order (newest last), got tail=%d", doc.Recent[len(doc.Recent)-1].TotalMS)
	}
}

func TestShareHealthAbsentBeforeFirstCall(t *testing.T) {
	resetShareCallStatsForTest()
	t.Cleanup(resetShareCallStatsForTest)
	doc, ok := ShareHealthStats().(shareHealthDoc)
	if !ok || doc.Status != "absent" {
		t.Fatalf("no calls yet must be absent, got %+v", ShareHealthStats())
	}
}

func resetShareCallStatsForTest() {
	shareCallStats.mu.Lock()
	shareCallStats.calls = 0
	shareCallStats.recent = nil
	shareCallStats.slowest = nil
	shareCallStats.bytes = 0
	shareCallStats.dropped = 0
	shareCallStats.mu.Unlock()
}
