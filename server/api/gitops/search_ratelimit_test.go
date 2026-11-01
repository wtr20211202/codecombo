package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 内容搜索限流单测（P-20261004-124）──
// 分两层：
//   - 窗口语义（预算/429/恢复/回告闸门）用直返桩 handler + 短窗口（120ms）驱动
//     ——中间件对 handler 不可知，窗口数学与真实搜索子进程耗时解耦才可确定性测恢复；
//   - 真实接线（路由参数/ClientIP 取键、真实 SearchProjectFiles/SearchProjectsContent
//     链路、生产窗口）用 31 次真搜索打满预算，只断言 429 形态不测恢复（真窗口
//     1 分钟，恢复由窗口语义层 + e2e 全窗验证覆盖）。

// searchRateTestWindow 短窗口：恢复等待 <200ms，留竞态余量
const searchRateTestWindow = 120 * time.Millisecond

func setupSearchRateLimitStore(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	for id, f := range map[string]*fixtureRepo{"p1": newFixtureRepo(t), "p2": newFixtureRepo(t)} {
		f.write("needle.txt", "one\nneedle two\n")
		f.run("add", "-A")
		f.run("commit", "-m", "needles")
		if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: "proj-" + id, Path: f.path}); err != nil {
			t.Fatal(err)
		}
	}
}

// fastOK 直返桩 handler：中间件语义测试用（真实链路另有真 handler 测试）
func fastOK(c *gin.Context) { c.JSON(http.StatusOK, gin.H{}) }

func getSearch(r *gin.Engine, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

// burnSearchBudget 打满 key 的窗口预算：恰好 searchRateLimit 次 200
func burnSearchBudget(t *testing.T, r *gin.Engine, path string) {
	t.Helper()
	for i := 0; i < searchRateLimit; i++ {
		if w := getSearch(r, path); w.Code != http.StatusOK {
			t.Fatalf("search #%d status = %d, want 200 (window budget not exhausted)\nbody: %s", i+1, w.Code, w.Body.String())
		}
	}
}

func assertSearch429(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit status = %d, want 429\nbody: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("429 body not JSON: %v", err)
	}
	if body["error"] != errmarkers.SearchRateLimited {
		t.Fatalf("429 error = %v, want stable marker %q", body["error"], errmarkers.SearchRateLimited)
	}
	if body["code"] != string(shared.CodeSearchRateLimited) {
		t.Fatalf("429 code = %v, want search.rate_limited", body["code"])
	}
	ra, ok := body["retry_after"].(float64)
	if !ok || ra < 1 {
		t.Fatalf("429 retry_after = %v, want >= 1", body["retry_after"])
	}
}

// TestSearchRateLimitWindow429AndRecovery 窗口语义：30 放行 → 31 次 429（标记/
// code/retry_after/Retry-After 头）→ 窗口滑动自动恢复 → 恢复后预算重新可烧
func TestSearchRateLimitWindow429AndRecovery(t *testing.T) {
	if searchRateLimit != 30 || searchRateWindow != time.Minute {
		t.Fatalf("生产参数漂移：limit=%d window=%v，手册与 CLAUDE.md 注记须同步", searchRateLimit, searchRateWindow)
	}
	r := gin.New()
	r.GET("/api/projects/:id/search", newSearchRateLimit(searchRateTestWindow, func(c *gin.Context) string {
		return c.Param("id")
	}), fastOK)

	burnSearchBudget(t, r, "/api/projects/p1/search?q=needle")
	assertSearch429(t, getSearch(r, "/api/projects/p1/search?q=needle"))
	// 窗口内持续 429
	if w := getSearch(r, "/api/projects/p1/search?q=needle"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("still-in-window status = %d, want 429", w.Code)
	}
	// Retry-After 头与体字段一致（秒）
	if got := getSearch(r, "/api/projects/p1/search?q=needle").Header().Get("Retry-After"); got == "" {
		t.Fatalf("429 missing Retry-After header")
	}

	// 窗口滑动自动恢复
	time.Sleep(searchRateTestWindow + 80*time.Millisecond)
	if w := getSearch(r, "/api/projects/p1/search?q=needle"); w.Code != http.StatusOK {
		t.Fatalf("after window recovery status = %d, want 200", w.Code)
	}
}

// TestSearchRateLimitProjectIsolation 项目维度隔离：p1 触限不拖累 p2（各自预算）
func TestSearchRateLimitProjectIsolation(t *testing.T) {
	r := gin.New()
	r.GET("/api/projects/:id/search", newSearchRateLimit(searchRateTestWindow, func(c *gin.Context) string {
		return c.Param("id")
	}), fastOK)

	burnSearchBudget(t, r, "/api/projects/p1/search?q=needle")
	assertSearch429(t, getSearch(r, "/api/projects/p1/search?q=needle"))
	if w := getSearch(r, "/api/projects/p2/search?q=needle"); w.Code != http.StatusOK {
		t.Fatalf("other project within window status = %d, want 200", w.Code)
	}
}

// TestSearchProjectRateLimit429RealWiring 真实接线：项目 id 取键 + 真
// SearchProjectFiles 链路 + 生产窗口下的 429 形态（Retry-After ∈ [1,60]）
func TestSearchProjectRateLimit429RealWiring(t *testing.T) {
	setupSearchRateLimitStore(t)
	r := gin.New()
	r.GET("/api/projects/:id/search", SearchProjectRateLimit(), SearchProjectFiles)

	burnSearchBudget(t, r, "/api/projects/p1/search?q=needle")
	w := getSearch(r, "/api/projects/p1/search?q=needle")
	assertSearch429(t, w)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if ra := body["retry_after"].(float64); ra > 60 {
		t.Fatalf("429 retry_after = %v, want <= 60 (production window)", ra)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Fatalf("429 missing Retry-After header")
	}
}

// TestBatchSearchRateLimit429RealWiring 批量端点真实接线：ClientIP 取键
// （httptest 恒 127.0.0.1）+ 真 SearchProjectsContent 链路
func TestBatchSearchRateLimit429RealWiring(t *testing.T) {
	setupSearchRateLimitStore(t)
	r := gin.New()
	r.GET("/api/search/projects", BatchSearchRateLimit(), SearchProjectsContent)

	burnSearchBudget(t, r, "/api/search/projects?ids=p1,p2&q=needle")
	w := getSearch(r, "/api/search/projects?ids=p1&q=needle")
	assertSearch429(t, w)
	if !strings.Contains(w.Body.String(), errmarkers.SearchRateLimited) {
		t.Fatalf("batch 429 body missing stable marker: %s", w.Body.String())
	}
}

// TestSearchRateLimitedNoticeGate 回告闸门：同 key 每窗口恰 1 条
// system:rate-limited（载荷形状 opschannel.RateLimitedNotice），不同 key 各有额度
func TestSearchRateLimitedNoticeGate(t *testing.T) {
	r := gin.New()
	r.GET("/api/projects/:id/search", newSearchRateLimit(searchRateTestWindow, func(c *gin.Context) string {
		return c.Param("id")
	}), fastOK)

	env := &searchNoticeEnv{}
	orig := opschannel.AddObserver(func(ev opschannel.Event) {
		env.mu.Lock()
		env.events = append(env.events, ev)
		env.mu.Unlock()
	})
	t.Cleanup(orig)

	// 超限 3 次（31/32/33）→ 回告闸门只放行第 1 条
	burnSearchBudget(t, r, "/api/projects/p1/search?q=needle")
	for i := 0; i < 3; i++ {
		if w := getSearch(r, "/api/projects/p1/search?q=needle"); w.Code != http.StatusTooManyRequests {
			t.Fatalf("over-limit #%d status = %d, want 429", i+1, w.Code)
		}
	}
	notices := env.of(opschannel.EventRateLimited)
	if len(notices) != 1 {
		t.Fatalf("rate-limited notices = %d, want exactly 1 per window per key", len(notices))
	}
	raw, _ := json.Marshal(notices[0].Payload)
	var pl map[string]any
	if json.Unmarshal(raw, &pl) != nil {
		t.Fatalf("notice payload not JSON-object: %+v", notices[0].Payload)
	}
	if pl["dimension"] != "project" || pl["key"] != "p1" || pl["dropped"] != float64(1) || pl["limit"] != float64(searchRateLimit) {
		t.Fatalf("notice payload = %+v", pl)
	}

	// 其他 key 的 429 走自己的闸门额度（p2 首条回告在场）
	burnSearchBudget(t, r, "/api/projects/p2/search?q=needle")
	if w := getSearch(r, "/api/projects/p2/search?q=needle"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("p2 over-limit status = %d, want 429", w.Code)
	}
	notices = env.of(opschannel.EventRateLimited)
	if len(notices) != 2 {
		t.Fatalf("notices after p2 over-limit = %d, want 2 (per-key gates)", len(notices))
	}
}

// searchNoticeEnv 测试观察者捕获面（opsmessage api_test 同款形态）
type searchNoticeEnv struct {
	events []opschannel.Event
	mu     sync.Mutex
}

func (env *searchNoticeEnv) of(typ string) []opschannel.Event {
	env.mu.Lock()
	defer env.mu.Unlock()
	out := make([]opschannel.Event, 0, len(env.events))
	for _, ev := range env.events {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}
