package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 本机体检趋势历史单测（P-20261005-169）：环形入账/裁剪与差值语义是体检面板
// 「与上次」趋势条与 agent 跨天自算的数据契约，在此固化（diaghist 同族纪律）。

// newSelfCheckTestStore 构造基于临时目录的独立体检趋势仓储（不污染全局 Store）
func newSelfCheckTestStore(t *testing.T) store.SelfCheckHistStore {
	t.Helper()
	return store.NewSelfCheckHistRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestSelfCheckHist_AppendAndOrder 追加即落盘；History 时间倒序（最新在前）
func TestSelfCheckHist_AppendAndOrder(t *testing.T) {
	r := newSelfCheckTestStore(t)

	base := time.Now().Add(-48 * time.Hour)
	for i := 0; i < 3; i++ {
		r.Append(store.SelfCheckSnapshot{
			Time:        base.Add(time.Duration(i) * time.Hour),
			DiskAvailMB: int64(20000 + i),
			Terminals:   2 + i,
		})
	}

	hist := r.History(0)
	if len(hist) != 3 {
		t.Fatalf("expected 3 items, got %d", len(hist))
	}
	if hist[0].DiskAvailMB != 20002 || hist[2].DiskAvailMB != 20000 {
		t.Errorf("expected newest-first order, got avail %d..%d", hist[0].DiskAvailMB, hist[2].DiskAvailMB)
	}
	latest, ok := r.Latest()
	if !ok || latest.Terminals != 4 {
		t.Errorf("Latest: ok=%v snap=%+v", ok, latest)
	}
}

// TestSelfCheckHist_RingRetention 环形保留：超过 SelfCheckHistMax 裁最旧
func TestSelfCheckHist_RingRetention(t *testing.T) {
	r := newSelfCheckTestStore(t)

	base := time.Now().Add(-72 * time.Hour)
	for i := 0; i < store.SelfCheckHistMax+5; i++ {
		r.Append(store.SelfCheckSnapshot{
			Time:      base.Add(time.Duration(i) * time.Hour),
			MemUsedMB: int64(100 + i), // 递增序列可校验被裁掉的是最旧的
		})
	}
	hist := r.History(0)
	if len(hist) != store.SelfCheckHistMax {
		t.Fatalf("expected ring capped at %d, got %d", store.SelfCheckHistMax, len(hist))
	}
	if hist[0].MemUsedMB != 100+store.SelfCheckHistMax+4 {
		t.Errorf("expected newest kept, got %d", hist[0].MemUsedMB)
	}
	if hist[len(hist)-1].MemUsedMB != 105 {
		t.Errorf("expected oldest five trimmed, got %d", hist[len(hist)-1].MemUsedMB)
	}
}

// TestDiffSelfCheckSnapshot 差值：磁盘/内存/活跃会话零值哨兵（任一侧未采集
// 差值恒 0），终端数恒真实（0-0=0 也照算，不减半隐藏）
func TestDiffSelfCheckSnapshot(t *testing.T) {
	prev := store.SelfCheckSnapshot{DiskAvailMB: 20480, MemUsedMB: 512, ActiveSessions: 2, Terminals: 3}
	cur := store.SelfCheckSnapshot{DiskAvailMB: 19456, MemUsedMB: 640, ActiveSessions: 3, Terminals: 5}

	d := store.DiffSelfCheckSnapshot(prev, cur)
	if d.DiskAvailMB != -1024 {
		t.Errorf("disk delta: expected -1024, got %d", d.DiskAvailMB)
	}
	if d.MemUsedMB != 128 {
		t.Errorf("mem delta: expected 128, got %d", d.MemUsedMB)
	}
	if d.ActiveSessions != 1 || d.Terminals != 2 {
		t.Errorf("session/terminal delta: expected +1/+2, got %+v", d)
	}

	// prev 内存未采集 → 内存差值 0，磁盘照算
	d2 := store.DiffSelfCheckSnapshot(store.SelfCheckSnapshot{DiskAvailMB: 20480, Terminals: 3}, cur)
	if d2.MemUsedMB != 0 || d2.DiskAvailMB != -1024 {
		t.Errorf("expected mem zeroed, disk computed, got %+v", d2)
	}

	// cur 全未采集（除终端恒真实）→ 哨兵指标全 0、终端差值照算
	d3 := store.DiffSelfCheckSnapshot(prev, store.SelfCheckSnapshot{Terminals: 1})
	if d3.DiskAvailMB != 0 || d3.MemUsedMB != 0 || d3.ActiveSessions != 0 {
		t.Errorf("expected sentinel metrics zeroed, got %+v", d3)
	}
	if d3.Terminals != -2 {
		t.Errorf("terminals always comparable: expected -2, got %d", d3.Terminals)
	}
}
