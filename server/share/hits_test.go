package share

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"codecombo/server/store"
)

// 访问计数（P-20261002-14）：Count 只攒内存、Flush 批量落盘——访客响应
// 路径零磁盘 I/O 的前提由这里锚定

func TestHitCounterAggregatesAndFlushes(t *testing.T) {
	h := NewHitCounter()
	// 同 token 多次命中攒成一条增量；flush 后 pending 清空
	h.Count("tok1")
	h.Count("tok1")
	h.Count("tok2")

	type call struct {
		token string
		n     int64
	}
	var got []call
	applied := h.Flush(func(token string, n int64, at time.Time) error {
		got = append(got, call{token, n})
		if at.IsZero() {
			t.Error("flush timestamp is zero")
		}
		return nil
	}, nil)
	if applied != 3 {
		t.Fatalf("applied = %d, want 3", applied)
	}
	byTok := map[string]int64{}
	for _, c := range got {
		byTok[c.token] += c.n
	}
	if byTok["tok1"] != 2 || byTok["tok2"] != 1 {
		t.Fatalf("batch = %v, want tok1:2 tok2:1", got)
	}

	// 二次冲刷：无攒量时零成本返回 0，且不再调用 apply
	calls := 0
	if n := h.Flush(func(string, int64, time.Time) error {
		calls++
		return nil
	}, nil); n != 0 || calls != 0 {
		t.Fatalf("second flush = %d (calls=%d), want 0/0", n, calls)
	}
}

func TestHitCounterDropsFailedRecords(t *testing.T) {
	h := NewHitCounter()
	h.Count("alive")
	h.Count("dead")
	applied := h.Flush(func(token string, _ int64, _ time.Time) error {
		if token == "dead" {
			return store.ErrNotFound // 已撤销/已轮换/已过期：记录已死，计数丢弃
		}
		return nil
	}, nil)
	if applied != 1 {
		t.Fatalf("applied = %d, want 1 (dead dropped)", applied)
	}
	// 失败条目不回灌：再冲刷仍为空（存储持续故障时内存不无界增长）
	if n := h.Flush(func(string, int64, time.Time) error { return nil }, nil); n != 0 {
		t.Fatalf("requeued after failure: applied = %d, want 0", n)
	}
}

func TestHitCounterConcurrentCountAndFlush(t *testing.T) {
	h := NewHitCounter()
	const workers, per = 8, 200
	var wg sync.WaitGroup
	var mu sync.Mutex
	total := 0
	// 冲刷与计数并发：flushMu 串行化保证不丢增量（每批落盘值累加 == 总命中数）
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
				n := h.Flush(func(_ string, n int64, _ time.Time) error {
					mu.Lock()
					total += int(n)
					mu.Unlock()
					return nil
				}, nil)
				mu.Lock()
				_ = n
				mu.Unlock()
			}
		}
	}()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < per; j++ {
				h.Count("hot")
			}
		}()
	}
	wg.Wait()
	close(stop)
	h.Flush(func(_ string, n int64, _ time.Time) error {
		mu.Lock()
		total += int(n)
		mu.Unlock()
		return nil
	}, nil)
	if total != workers*per {
		t.Fatalf("flushed total = %d, want %d (lost updates across concurrent flushes)", total, workers*per)
	}
}

func TestHitCounterNilSafe(t *testing.T) {
	var h *HitCounter
	h.Count("tok") // 不 panic
	if n := h.Flush(func(string, int64, time.Time) error { return errors.New("x") }, nil); n != 0 {
		t.Fatalf("nil counter flush = %d, want 0", n)
	}
}

// 端到端（HTTP 面）：页面打开 + 下载各计一次；未知短链不计
func TestServiceCountAccessOnPageAndDownload(t *testing.T) {
	root := fixture(t)
	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	getOK := func(url string) {
		t.Helper()
		resp := get(t, url)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s -> %d (body=%s)", url, resp.StatusCode, body)
		}
	}
	getOK(srv.URL + "/s/" + token)                              // 页面打开 +1
	getOK(srv.URL + "/s/" + token + "/download?path=readme.md") // 文件下载 +1
	getOK(srv.URL + "/s/" + token + "/download")                // 目录打包下载 +1
	resp := get(t, srv.URL+"/s/aaaaaaaaaaaaaaaa")               // 未知短链 404 不计
	resp.Body.Close()

	var hits int64
	svc.FlushHits(func(_ string, n int64, _ time.Time) error {
		hits += n
		return nil
	})
	if hits != 3 {
		t.Fatalf("hits = %d, want 3 (page + download + dl)", hits)
	}
}

// 子资源取数（meta/raw/render）不计：一次页面浏览会连发多个子请求，
// 逐请求计数会把访问次数虚高数倍（计数口径锚定，防回归）
func TestServiceSubresourceFetchNotCounted(t *testing.T) {
	root := fixture(t)
	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	for _, path := range []string{
		"/s/" + token + "/meta",
		"/s/" + token + "/list",
		"/s/" + token + "/raw?path=readme.md",
		"/s/" + token + "/render?path=readme.md",
	} {
		resp := get(t, srv.URL+path)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s -> %d (body=%s)", path, resp.StatusCode, body)
		}
	}
	if n := svc.FlushHits(func(string, int64, time.Time) error { return nil }); n != 0 {
		t.Fatalf("subresource fetches counted %d hits, want 0", n)
	}
}
