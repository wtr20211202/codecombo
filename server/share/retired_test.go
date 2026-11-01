package share

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 退役短链命中观测的访客面行为（P-20261008-2）：响应语义零变化（仍 404）、
// 审计留痕攒批、通知首报+去抖、HEAD 豁免、非退役 token 零副作用。

// retiredFakeShares 带退役反查能力的测试桩（生产装配 shareLookup→ShareStore
// 的镜像面；不含 FindRetired 的桩走 optional 断言跳过路径）
type retiredFakeShares struct {
	fakeShares
	retired map[string]*store.Share // retired token → 宿主记录
}

func (f *retiredFakeShares) FindRetired(retiredToken string) (*store.Share, bool) {
	h, ok := f.retired[retiredToken]
	return h, ok
}

func newRetiredTestServer(t *testing.T) (*httptest.Server, *retiredFakeShares, *Service) {
	t.Helper()
	root := fixture(t)
	live := fixedToken("live")
	old := fixedToken("old")
	shares := &retiredFakeShares{
		fakeShares: fakeShares{live: {
			Token: live, ProjectID: "p1", ProjectName: "proj", Name: "docs",
			Path: "docs", IsDir: true,
		}},
		retired: map[string]*store.Share{
			// 退役台账挂宿主（当前代际记录）：rotate 后旧 token 的观测锚
			old: {
				Token: live, ProjectID: "p1", ProjectName: "proj", Name: "docs",
				Path: "docs", IsDir: true,
				RetiredTokens: []store.RetiredToken{{Token: old, RetiredAt: time.Now().Add(-time.Hour)}},
			},
		},
	}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, shares, svc
}

// TestRetiredHitResponseUnchanged 响应语义零变化：命中退役 token 的访客
// 响应仍是原有 404（与「从未存在」同观感——存在性信号不得因观测面而可探测，
// 任务书③「告警不改变静默撤销语义」在实况 404 上的镜像）
func TestRetiredHitResponseUnchanged(t *testing.T) {
	srv, _, _ := newRetiredTestServer(t)
	resp := get(t, srv.URL+"/s/"+fixedToken("old"))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("retired token page status = %d, want 404 (unchanged)", resp.StatusCode)
	}
	// JSON 端点同语义
	resp2 := get(t, srv.URL+"/s/"+fixedToken("old")+"/meta")
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("retired token meta status = %d, want 404", resp2.StatusCode)
	}
}

// TestRetiredHitObserved 命中 → 审计留痕 + 计数攒批 + 通知首报；
// 非 retired token 的 404 零副作用
func TestRetiredHitObserved(t *testing.T) {
	srv, _, svc := newRetiredTestServer(t)
	old := fixedToken("old")

	// 访客 GET（页面）：命中退役台账
	resp := get(t, srv.URL+"/s/"+old)
	_ = resp.Body.Close()

	// 审计留痕（攒批取出）：share.retiredHit、Detail 含展示名/退役 token/累计命中
	events, dropped := svc.views.Drain()
	if dropped != 0 {
		t.Fatalf("unexpected audit drops: %d", dropped)
	}
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(events))
	}
	e := events[0]
	if e.Action != store.AuditShareRetiredHit {
		t.Fatalf("audit action = %s, want %s", e.Action, store.AuditShareRetiredHit)
	}
	for _, want := range []string{"docs", "(retired " + old + ")", "hits: 1", "ua: "} {
		if !strings.Contains(e.Detail, want) {
			t.Fatalf("audit detail %q missing %q", e.Detail, want)
		}
	}
	if e.IP == "" {
		t.Fatal("audit ip must be recorded (clientIPOf)")
	}

	// 通知首报：warning + share-manager 直达
	notes, droppedNotes := svc.notes.Drain()
	if droppedNotes != 0 || len(notes) != 1 {
		t.Fatalf("notifications = %d (dropped %d), want exactly the first alert", len(notes), droppedNotes)
	}
	if notes[0].Type != "warning" || notes[0].ActionPayload != "share-manager" {
		t.Fatalf("alert shape = %+v", notes[0])
	}
	if !strings.Contains(notes[0].Body, "docs") {
		t.Fatalf("alert body must name the share: %q", notes[0].Body)
	}

	// 非 retired 的未知 token 404：零审计零通知（漫扫不触发外泄告警——
	// 本观测只认台账内 token）
	get(t, srv.URL+"/s/"+fixedToken("junk")).Body.Close()
	events, _ = svc.views.Drain()
	notes, _ = svc.notes.Drain()
	if len(events) != 0 || len(notes) != 0 {
		t.Fatalf("plain 404 must be silent, got %d audits / %d notes", len(events), len(notes))
	}
}

// TestRetiredHitNotifyCadence 通知去抖：首次即发 + 此后每 10 次一发
// （1、11、21）；HEAD 一律不计（探测不是「被看」，P-14 口径）
func TestRetiredHitNotifyCadence(t *testing.T) {
	srv, _, svc := newRetiredTestServer(t)
	old := fixedToken("old")
	hit := func() { _ = get(t, srv.URL+"/s/"+old).Body.Close() }

	hit() // 1 → 首发
	notes, _ := svc.notes.Drain()
	if len(notes) != 1 {
		t.Fatalf("first hit must alert once, got %d", len(notes))
	}
	// 首发批的未落盘增量先冲清（装配层 3s tick 的模拟）——后续节拍断言
	// 从干净基线起算
	if batch := svc.retired.FlushPending(); batch[old] != 1 {
		t.Fatalf("first flush = %d, want 1", batch[old])
	}

	// HEAD 探测不计（节拍与计数都不动）
	headResp, err := http.Head(srv.URL + "/s/" + old)
	if err != nil {
		t.Fatal(err)
	}
	_ = headResp.Body.Close()
	if notes, _ := svc.notes.Drain(); len(notes) != 0 {
		t.Fatalf("HEAD must not count, got %d notes", len(notes))
	}
	if batch := svc.retired.FlushPending(); len(batch) != 0 {
		t.Fatalf("HEAD must not count, pending = %v", batch)
	}

	// 2..10 静默（累计 9 次刷新后仍不发——第 11 次才汇总）
	for i := 0; i < 9; i++ {
		hit()
	}
	if notes, _ := svc.notes.Drain(); len(notes) != 0 {
		t.Fatalf("hits 2..10 must stay silent, got %d notes", len(notes))
	}
	hit() // 11 → 汇总一条
	notes, _ = svc.notes.Drain()
	if len(notes) != 1 {
		t.Fatalf("hit 11 must summarize once, got %d", len(notes))
	}

	// 冲刷计数：首发批已冲清，2..11 共 10 次命中（HEAD 不计）批量落盘
	batch := svc.retired.FlushPending()
	if batch[old] != 10 {
		t.Fatalf("pending flush = %d, want 10", batch[old])
	}
	if batch := svc.retired.FlushPending(); batch != nil {
		t.Fatalf("second flush must be empty, got %v", batch)
	}
}

// TestRetiredHitFlushSkipsDeadHost 冲刷时宿主已消亡 → apply 失败被丢弃
// 不回灌（观测随宿主消亡；RecordHits 同一取舍——flush 端不预知宿主存亡，
// 存储侧 ErrNotFound 即终态，pending 已清不再重试）
func TestRetiredHitFlushSkipsDeadHost(t *testing.T) {
	srv, shares, svc := newRetiredTestServer(t)
	old := fixedToken("old")
	_ = get(t, srv.URL+"/s/"+old).Body.Close()

	// 宿主被撤销（retired 桩清空 = 记录消亡）：落盘侧返回 ErrNotFound
	shares.retired = nil
	applied := svc.FlushRetiredHits(func(token string, n int64, at time.Time) error {
		if token != old || n != 1 {
			t.Fatalf("unexpected batch: %s n=%d", token, n)
		}
		return store.ErrNotFound
	})
	if applied != 0 {
		t.Fatalf("applied = %d, want 0", applied)
	}
	// 不回灌：下一轮冲刷为空（存储故障时回灌会让内存无界增长）
	if batch := svc.retired.FlushPending(); batch != nil {
		t.Fatalf("failed batch must not be requeued, got %v", batch)
	}
}
