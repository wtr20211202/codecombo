package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newDiagTestStore 构造基于临时目录的独立诊断历史仓储（不污染全局 Store）
func newDiagTestStore(t *testing.T) store.DiagHistStore {
	t.Helper()
	return store.NewDiagHistRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestDiagHist_AppendAndOrder 追加即落盘；History 时间倒序（最新在前），Latest 取尾
func TestDiagHist_AppendAndOrder(t *testing.T) {
	r := newDiagTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		r.Append("h1", store.DiagSnapshot{
			Time:        base.Add(time.Duration(i) * time.Minute),
			DiskAvailMB: int64(1000 + i),
			MemUsedMB:   2048,
		})
	}

	hist := r.History("h1", 0)
	if len(hist) != 3 {
		t.Fatalf("expected 3 items, got %d", len(hist))
	}
	// 倒序：最新在前
	if hist[0].DiskAvailMB != 1002 || hist[2].DiskAvailMB != 1000 {
		t.Errorf("expected newest-first order, got avail %d..%d", hist[0].DiskAvailMB, hist[2].DiskAvailMB)
	}
	latest, ok := r.Latest("h1")
	if !ok || latest.DiskAvailMB != 1002 {
		t.Errorf("Latest: ok=%v snap=%+v", ok, latest)
	}
	// 按主机隔离
	if h, ok := r.Latest("h2"); ok {
		t.Errorf("expected no history for h2, got %+v", h)
	}
}

// TestDiagHist_RingRetention 环形保留：超过 DiagHistMax 裁最旧，总量恒封顶
func TestDiagHist_RingRetention(t *testing.T) {
	r := newDiagTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < store.DiagHistMax+5; i++ {
		r.Append("h1", store.DiagSnapshot{
			Time:      base.Add(time.Duration(i) * time.Minute),
			MemUsedMB: int64(100 + i), // 递增序列可校验被裁掉的是最旧的
		})
	}

	hist := r.History("h1", 0)
	if len(hist) != store.DiagHistMax {
		t.Fatalf("expected ring capped at %d, got %d", store.DiagHistMax, len(hist))
	}
	// 最旧 5 条（MemUsedMB=100..104）应被裁掉；保留 105..124
	if hist[0].MemUsedMB != 124 {
		t.Errorf("expected newest kept, got %d", hist[0].MemUsedMB)
	}
	if hist[len(hist)-1].MemUsedMB != 105 {
		t.Errorf("expected oldest trimmed, got %d", hist[len(hist)-1].MemUsedMB)
	}
}

// TestDiagHist_HistoryLimit History 的 limit 截尾（列表侧只需最近 1~2 条）
func TestDiagHist_HistoryLimit(t *testing.T) {
	r := newDiagTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 4; i++ {
		r.Append("h1", store.DiagSnapshot{Time: base.Add(time.Duration(i) * time.Minute), MemUsedMB: int64(i)})
	}

	top2 := r.History("h1", 2)
	if len(top2) != 2 || top2[0].MemUsedMB != 3 || top2[1].MemUsedMB != 2 {
		t.Errorf("expected latest 2 [3 2], got %+v", top2)
	}
}

// TestDiagHist_Delete 主机删除级联清理：删除后 Latest 无历史
func TestDiagHist_Delete(t *testing.T) {
	r := newDiagTestStore(t)

	r.Append("h1", store.DiagSnapshot{MemUsedMB: 512})
	r.Delete("h1")
	if _, ok := r.Latest("h1"); ok {
		t.Error("expected no history after Delete")
	}
	// 删除不存在的主机不报错（幂等）
	r.Delete("missing")
}

// TestDiffDiagSnapshot 差值计算：三指标 cur-prev；任一侧未采集（零值）差值恒 0
func TestDiffDiagSnapshot(t *testing.T) {
	prev := store.DiagSnapshot{DiskAvailMB: 20480, MemUsedMB: 3072, Load1: 0.25}
	cur := store.DiagSnapshot{DiskAvailMB: 19456, MemUsedMB: 3200, Load1: 0.5}

	d := store.DiffDiagSnapshot(prev, cur)
	if d.DiskAvailMB != -1024 {
		t.Errorf("disk delta: expected -1024, got %d", d.DiskAvailMB)
	}
	if d.MemUsedMB != 128 {
		t.Errorf("mem delta: expected 128, got %d", d.MemUsedMB)
	}
	if d.Load1 != 0.25 {
		t.Errorf("load delta: expected 0.25, got %v", d.Load1)
	}

	// prev 磁盘未采集 → 磁盘差值 0，其余照算
	d2 := store.DiffDiagSnapshot(store.DiagSnapshot{MemUsedMB: 3072}, cur)
	if d2.DiskAvailMB != 0 || d2.MemUsedMB != 128 {
		t.Errorf("expected disk zeroed, mem computed, got %+v", d2)
	}

	// cur 负载未采集 → 负载差值 0
	d3 := store.DiffDiagSnapshot(prev, store.DiagSnapshot{DiskAvailMB: 20480, MemUsedMB: 3072})
	if d3.Load1 != 0 || d3.DiskAvailMB != 0 || d3.MemUsedMB != 0 {
		t.Errorf("expected all zero when cur empty, got %+v", d3)
	}
}
