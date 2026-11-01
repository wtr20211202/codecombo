package share

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"codecombo/server/store"
)

// 访客访问审计（P-20261003-257）：recordView 只攒内存、FlushViewAudits 批量
// 入账——访客响应路径零磁盘 I/O 的前提与 HitCounter 同锚；Detail 含链接 id
// 是「谁看了哪个链接」的对账判据

// dirShareSvc 建一个目录分享 + 独立服务（留痕口径用例共用）
func dirShareSvc(t *testing.T) (*Service, *httptest.Server, string) {
	t.Helper()
	root := fixture(t)
	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return svc, srv, token
}

// drainViews 冲刷留痕并返回入账事件（apply 捕获面）
func drainViews(svc *Service) []store.AuditEvent {
	var got []store.AuditEvent
	svc.FlushViewAudits(func(e store.AuditEvent) {
		got = append(got, e)
	})
	return got
}

// 端到端（HTTP 面）：页面打开与下载启动各留痕一条，Detail 含链接 id +
// 展示名 + IP；未知短链与子资源取数不留痕（口径 = 计数同款，防回归）
func TestServiceAuditsViewOnPageAndDownload(t *testing.T) {
	svc, srv, token := dirShareSvc(t)

	getOK := func(url string) {
		t.Helper()
		resp := get(t, url)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s -> %d (body=%s)", url, resp.StatusCode, body)
		}
	}
	// 页面打开带显式 UA：留痕的 UA 简要应逐字捕获（e2e 环境客户端 UA 不可控，
	// 精确断言归单测）
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/s/"+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", "viewaudit-unit/1.0")
	if resp, err := http.DefaultClient.Do(req); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("page open -> %d", resp.StatusCode)
		}
	}
	getOK(srv.URL + "/s/" + token + "/download?path=readme.md") // 下载启动 +1
	// 子资源取数不留痕（一次浏览连发多请求，逐请求留痕会虚高数倍）
	getOK(srv.URL + "/s/" + token + "/meta")
	getOK(srv.URL + "/s/" + token + "/raw?path=readme.md")
	// 未知短链不留痕（链接 id 以解析到的记录为准）
	resp := get(t, srv.URL+"/s/aaaaaaaaaaaaaaaa")
	resp.Body.Close()

	events := drainViews(svc)
	if len(events) != 2 {
		t.Fatalf("audit events = %d, want 2 (page + download)", len(events))
	}
	// 事件按入账序：[0]=页面打开（显式 UA 逐字进 Detail）、[1]=下载
	if !strings.Contains(events[0].Detail, "viewaudit-unit/1.0") {
		t.Errorf("page-open detail %q missing explicit ua", events[0].Detail)
	}
	if strings.Contains(events[1].Detail, "viewaudit-unit/1.0") {
		t.Error("download detail leaked page-open ua (event order broken)")
	}
	for _, e := range events {
		if e.Action != store.AuditShareView {
			t.Errorf("action = %q, want %q", e.Action, store.AuditShareView)
		}
		if e.Result != store.AuditResultSuccess {
			t.Errorf("result = %q, want %q", e.Result, store.AuditResultSuccess)
		}
		// 判据：Detail 含链接 id（token）；展示名同账可读
		if !strings.Contains(e.Detail, token) {
			t.Errorf("detail %q missing link id %q", e.Detail, token)
		}
		if !strings.Contains(e.Detail, "docs") {
			t.Errorf("detail %q missing share name", e.Detail)
		}
		if e.Time.IsZero() {
			t.Error("event time is zero")
		}
		if e.IP == "" {
			t.Error("event ip is empty")
		}
	}

	// 冲刷取走即清：二次冲刷零事件（不回灌，HitCounter.Flush 同款）
	if again := drainViews(svc); len(again) != 0 {
		t.Fatalf("second flush returned %d events, want 0", len(again))
	}
}

// UA 简要：控制字符折叠单行（审计面注入防线）+ rune 截断 + 空值占位
func TestUABriefSanitized(t *testing.T) {
	got := uaBrief("Malicious/1.0\r\nX-Injected: yes\ttab")
	if strings.ContainsAny(got, "\r\n\t") {
		t.Errorf("ua brief %q still contains control chars", got)
	}
	long := strings.Repeat("长", viewUAMaxRunes+10)
	trimmed := uaBrief(long)
	// 截断保留 viewUAMaxRunes 个 rune + 一个省略号 rune
	if want := viewUAMaxRunes + 1; len([]rune(trimmed)) != want {
		t.Errorf("truncated rune count = %d, want %d", len([]rune(trimmed)), want)
	}
	if got := uaBrief("   "); got != "-" {
		t.Errorf("blank ua = %q, want \"-\"", got)
	}
	if got := uaBrief("curl/8.0"); got != "curl/8.0" {
		t.Errorf("normal ua mangled: %q", got)
	}
}

// 攒批封顶逐出最旧 + dropped 计数随冲刷取走（访客风暴的内存护栏，有损降级
// 必须留痕）；nil 缓冲各方法安全直通
func TestViewAuditBufferCapAndNilSafe(t *testing.T) {
	v := &ViewAuditBuffer{}
	for i := 0; i < viewAuditMaxPending+3; i++ {
		v.Add(store.AuditEvent{Action: store.AuditShareView, Detail: strings.Repeat("x", i)})
	}
	events, dropped := v.Drain()
	if dropped != 3 {
		t.Fatalf("dropped = %d, want 3 (oldest evicted)", dropped)
	}
	if len(events) != viewAuditMaxPending {
		t.Fatalf("pending = %d, want %d", len(events), viewAuditMaxPending)
	}
	// 最旧的 3 条被逐出：幸存集里不再有前 3 条的特征宽度
	if len(events[0].Detail) != 3 {
		t.Errorf("oldest survivor width = %d, want 3", len(events[0].Detail))
	}
	// dropped 随 Drain 取走即清
	if _, d2 := v.Drain(); d2 != 0 {
		t.Errorf("dropped not reset after drain: %d", d2)
	}

	var nilBuf *ViewAuditBuffer
	nilBuf.Add(store.AuditEvent{Action: store.AuditShareView}) // 不 panic
	if evs, d := nilBuf.Drain(); evs != nil || d != 0 {
		t.Errorf("nil buffer drain = %v/%d, want empty", evs, d)
	}
}

// nil apply（测试/关停场景）：取走即清空不调用——与 FlushHits 的 apply=nil
// 语义同款（Append 尽力而为在 store 层，本层无失败回灌路径）
func TestFlushViewAuditsNilApply(t *testing.T) {
	svc, srv, token := dirShareSvc(t)
	resp := get(t, srv.URL+"/s/"+token)
	resp.Body.Close()

	if n := svc.FlushViewAudits(nil); n != 1 {
		t.Fatalf("nil apply flush = %d, want 1 (event discarded)", n)
	}
	if again := drainViews(svc); len(again) != 0 {
		t.Fatalf("requeued after nil apply: %d events", len(again))
	}
}

// 并发 Add 与 Drain：锁下不丢账不重账（容量语义内守恒——上限内的总量恰好
// 入账一次；go test -race 验证内存安全）
func TestViewAuditBufferConcurrentAddDrain(t *testing.T) {
	v := &ViewAuditBuffer{}
	const workers, per = 8, 200
	var wg sync.WaitGroup
	total := 0
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < per; j++ {
				v.Add(store.AuditEvent{Action: store.AuditShareView})
			}
		}()
	}
	wg.Wait()
	for {
		evs, _ := v.Drain()
		total += len(evs)
		if len(evs) == 0 {
			break
		}
	}
	// 1600 条 > 封顶 512：幸存集恰为一条满容量批（逐出是有意语义，不是丢锁）
	if total != viewAuditMaxPending {
		t.Fatalf("drained total = %d, want %d (capped survivors)", total, viewAuditMaxPending)
	}
}
