package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// cronmetric 单测（P-20261005-237）：环形保留/时间倒序/limit 截尾/删除级联，
// diaghist 同族仓储同套锚点

func newCronMetricTestStore(t *testing.T) store.CronMetricStore {
	t.Helper()
	return store.NewCronMetricRepo(filestore.New(filepath.Join(t.TempDir(), "data")))
}

// TestCronMetric_AppendAndOrder 追加即落盘；History 时间倒序（最新在前）
func TestCronMetric_AppendAndOrder(t *testing.T) {
	r := newCronMetricTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		r.Append("c1", store.CronMetricPoint{
			At:    base.Add(time.Duration(i) * time.Minute),
			Value: float64(10 + i),
		})
	}

	hist := r.History("c1", 0)
	if len(hist) != 3 {
		t.Fatalf("expected 3 points, got %d", len(hist))
	}
	if hist[0].Value != 12 || hist[2].Value != 10 {
		t.Errorf("expected newest-first order, got %v..%v", hist[0].Value, hist[2].Value)
	}
	// 按任务隔离
	if h := r.History("c2", 0); len(h) != 0 {
		t.Errorf("expected no history for c2, got %+v", h)
	}
}

// TestCronMetric_RingRetention 环形保留：超过 CronMetricMax 裁最旧
func TestCronMetric_RingRetention(t *testing.T) {
	r := newCronMetricTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < store.CronMetricMax+5; i++ {
		r.Append("c1", store.CronMetricPoint{
			At:    base.Add(time.Duration(i) * time.Minute),
			Value: float64(100 + i), // 递增序列可校验被裁掉的是最旧的
		})
	}

	hist := r.History("c1", 0)
	if len(hist) != store.CronMetricMax {
		t.Fatalf("expected ring capped at %d, got %d", store.CronMetricMax, len(hist))
	}
	if hist[0].Value != 100+store.CronMetricMax+4 {
		t.Errorf("expected newest kept, got %v", hist[0].Value)
	}
	if hist[len(hist)-1].Value != 105 {
		t.Errorf("expected oldest trimmed at 105, got %v", hist[len(hist)-1].Value)
	}
}

// TestCronMetric_HistoryLimit limit 截尾（列表侧趋势只需保留窗全量或最近几条）
func TestCronMetric_HistoryLimit(t *testing.T) {
	r := newCronMetricTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 4; i++ {
		r.Append("c1", store.CronMetricPoint{At: base.Add(time.Duration(i) * time.Minute), Value: float64(i)})
	}

	top2 := r.History("c1", 2)
	if len(top2) != 2 || top2[0].Value != 3 || top2[1].Value != 2 {
		t.Errorf("expected latest 2 [3 2], got %+v", top2)
	}
}

// TestCronMetric_Delete 任务删除级联清理；删除不存在任务幂等
func TestCronMetric_Delete(t *testing.T) {
	r := newCronMetricTestStore(t)

	r.Append("c1", store.CronMetricPoint{Value: 3.5})
	r.Delete("c1")
	if h := r.History("c1", 0); len(h) != 0 {
		t.Errorf("expected no history after Delete, got %+v", h)
	}
	r.Delete("missing") // 幂等不报错
}

// TestCronMetric_EmptyCronIDIgnored 空 cronID 拒绝（防御：无主点位不落）
func TestCronMetric_EmptyCronIDIgnored(t *testing.T) {
	r := newCronMetricTestStore(t)
	r.Append("", store.CronMetricPoint{Value: 1})
	if h := r.History("", 0); len(h) != 0 {
		t.Errorf("empty cronID must not persist, got %+v", h)
	}
}
