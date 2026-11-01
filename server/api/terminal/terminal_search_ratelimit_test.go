package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/gitops"
	"codecombo/server/api/opschannel"
	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"

	"github.com/gin-gonic/gin"
)

// ── 终端输出检索限流单测（P-20261005-158）──
// 分层同 gitops search_ratelimit_test.go（共用实现）：
//   - 窗口语义（预算/429/恢复/键链隔离/回告维度推导）用直返桩 handler + 短窗口
//     驱动——中间件对 handler 不可知，窗口数学与真实扫描耗时解耦才可确定性测恢复
//     （窗口数学本体已由 gitops 包对同一实现覆盖，此处守终端侧的键链与参数接线）；
//   - 真实接线（生产窗口 + 真 SearchTerminalOutput 链路）只断言 429 形态不测恢复
//     （真窗口 1 分钟，恢复由窗口语义层覆盖）。

// terminalSearchTestWindow 短窗口：恢复等待 <200ms，留竞态余量
const terminalSearchTestWindow = 120 * time.Millisecond

// fastOK 直返桩 handler：中间件语义测试用（真实链路另有真 handler 测试）
func fastOK(c *gin.Context) { c.JSON(http.StatusOK, gin.H{}) }

func getTerminalSearch(r *gin.Engine, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

// burnTerminalSearchBudget 打满 key 的窗口预算：恰好 terminalSearchRateLimit 次 200
func burnTerminalSearchBudget(t *testing.T, r *gin.Engine, path string) {
	t.Helper()
	for i := 0; i < terminalSearchRateLimit; i++ {
		if w := getTerminalSearch(r, path); w.Code != http.StatusOK {
			t.Fatalf("search #%d status = %d, want 200 (window budget not exhausted)\nbody: %s", i+1, w.Code, w.Body.String())
		}
	}
}

func assertTerminalSearch429(t *testing.T, w *httptest.ResponseRecorder) *httptest.ResponseRecorder {
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
	if ra, ok := body["retry_after"].(float64); !ok || ra < 1 {
		t.Fatalf("429 retry_after = %v, want >= 1", body["retry_after"])
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatalf("429 missing Retry-After header")
	}
	return w
}

// TestTerminalSearchRateLimitWindow429AndRecovery 窗口语义：30 放行 → 31 次 429
// （标记/code/retry_after/Retry-After 头）→ 窗口滑动自动恢复 → 预算重新可烧
func TestTerminalSearchRateLimitWindow429AndRecovery(t *testing.T) {
	if terminalSearchRateLimit != 30 || terminalSearchWindow != time.Minute {
		t.Fatalf("生产参数漂移：limit=%d window=%v，手册与 CLAUDE.md 注记须同步", terminalSearchRateLimit, terminalSearchWindow)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/search", gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchTestWindow, "ip", terminalSearchRateKey), fastOK)

	path := "/api/terminals/search?q=needle"
	burnTerminalSearchBudget(t, r, path)
	assertTerminalSearch429(t, getTerminalSearch(r, path))
	// 窗口内持续 429
	if w := getTerminalSearch(r, path); w.Code != http.StatusTooManyRequests {
		t.Fatalf("still-in-window status = %d, want 429", w.Code)
	}

	// 窗口滑动自动恢复
	time.Sleep(terminalSearchTestWindow + 80*time.Millisecond)
	if w := getTerminalSearch(r, path); w.Code != http.StatusOK {
		t.Fatalf("after window recovery status = %d, want 200", w.Code)
	}
}

// TestTerminalSearchRateLimitKeyIsolation 键链隔离：sid 打满不拖累其他 sid /
// 令牌 / IP 桶；X-Session-ID 优先于 tokenID（ops-notify opsNotifyRateKey 同序）
func TestTerminalSearchRateLimitKeyIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/search", gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchTestWindow, "ip", terminalSearchRateKey), fastOK)

	// sid:s-A 桶打满
	for i := 0; i < terminalSearchRateLimit; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
		req.Header.Set("X-Session-ID", "s-A")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("sid:s-A search #%d status = %d, want 200", i+1, w.Code)
		}
	}
	// 同 sid 超限 429
	req429 := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
	req429.Header.Set("X-Session-ID", "s-A")
	w429 := httptest.NewRecorder()
	r.ServeHTTP(w429, req429)
	assertTerminalSearch429(t, w429)

	// 其他 sid / 令牌 / 无头（IP 桶）各自预算不受扰
	if w := getTerminalSearch(r, "/api/terminals/search?q=needle"); w.Code != http.StatusOK {
		t.Fatalf("ip-bucket after sid:s-A exhaust status = %d, want 200", w.Code)
	}
	reqSidB := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
	reqSidB.Header.Set("X-Session-ID", "s-B")
	wSidB := httptest.NewRecorder()
	r.ServeHTTP(wSidB, reqSidB)
	if wSidB.Code != http.StatusOK {
		t.Fatalf("sid:s-B status = %d, want 200 (per-key budget)", wSidB.Code)
	}

	// token 桶独立：tokenID 注入（桩中间件模拟鉴权注入）+ 无 sid 头 → tok:s-X 桶
	rToken := gin.New()
	rToken.Use(func(c *gin.Context) { c.Set("tokenID", "s-X"); c.Next() })
	rToken.GET("/api/terminals/search", gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchTestWindow, "ip", terminalSearchRateKey), fastOK)
	for i := 0; i < terminalSearchRateLimit; i++ {
		if w := getTerminalSearch(rToken, "/api/terminals/search?q=needle"); w.Code != http.StatusOK {
			t.Fatalf("tok:s-X search #%d status = %d, want 200", i+1, w.Code)
		}
	}
	assertTerminalSearch429(t, getTerminalSearch(rToken, "/api/terminals/search?q=needle"))

	// 键优先序：有 sid 头时即便 tokenID 也在场，烧的是 sid 桶（新引擎避免共桶串扰）
	rBoth := gin.New()
	rBoth.Use(func(c *gin.Context) { c.Set("tokenID", "s-X"); c.Next() })
	rBoth.GET("/api/terminals/search", gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchTestWindow, "ip", terminalSearchRateKey), fastOK)
	for i := 0; i < terminalSearchRateLimit; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
		req.Header.Set("X-Session-ID", "s-pri")
		w := httptest.NewRecorder()
		rBoth.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("sid:s-pri search #%d status = %d, want 200", i+1, w.Code)
		}
	}
	// 同 sid 已满 → 429；去头（同 tokenID）→ 走 tok:s-X 桶仍 200
	reqPri := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
	reqPri.Header.Set("X-Session-ID", "s-pri")
	wPri := httptest.NewRecorder()
	rBoth.ServeHTTP(wPri, reqPri)
	assertTerminalSearch429(t, wPri)
	if w := getTerminalSearch(rBoth, "/api/terminals/search?q=needle"); w.Code != http.StatusOK {
		t.Fatalf("tok:s-X after sid:s-pri exhaust status = %d, want 200 (sid takes precedence)", w.Code)
	}
}

// TestTerminalSearchRateLimitedNoticeGate 回告闸门与维度推导：sid/tok 前缀键的
// system:rate-limited 维度按前缀推导（session/token，键剥前缀），同 key 每窗口
// 恰 1 条（notifyOpsNotifyLimited 同款 switch，经 gitops.SearchRateLimit 共用）
func TestTerminalSearchRateLimitedNoticeGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("tokenID", "tok-B"); c.Next() })
	r.GET("/api/terminals/search", gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchTestWindow, "ip", terminalSearchRateKey), fastOK)

	env := &terminalNoticeEnv{}
	orig := opschannel.AddObserver(func(ev opschannel.Event) {
		env.mu.Lock()
		env.events = append(env.events, ev)
		env.mu.Unlock()
	})
	t.Cleanup(orig)

	// sid:s-A 桶打满 + 超限 2 次 → 该 key 回告恰 1 条，dimension=session key=s-A
	for i := 0; i < terminalSearchRateLimit; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
		req.Header.Set("X-Session-ID", "s-A")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("sid:s-A search #%d status = %d, want 200", i+1, w.Code)
		}
	}
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=needle", nil)
		req.Header.Set("X-Session-ID", "s-A")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("sid:s-A over-limit #%d status = %d, want 429", i+1, w.Code)
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
	if pl["dimension"] != "session" || pl["key"] != "s-A" || pl["dropped"] != float64(1) || pl["limit"] != float64(terminalSearchRateLimit) {
		t.Fatalf("sid notice payload = %+v", pl)
	}

	// tok:tok-B 桶打满 + 超限 → 独立闸门额度，dimension=token key=tok-B（剥前缀）
	for i := 0; i < terminalSearchRateLimit; i++ {
		if w := getTerminalSearch(r, "/api/terminals/search?q=needle"); w.Code != http.StatusOK {
			t.Fatalf("tok:tok-B search #%d status = %d, want 200", i+1, w.Code)
		}
	}
	if w := getTerminalSearch(r, "/api/terminals/search?q=needle"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("tok:tok-B over-limit status = %d, want 429", w.Code)
	}
	notices = env.of(opschannel.EventRateLimited)
	if len(notices) != 2 {
		t.Fatalf("notices after tok over-limit = %d, want 2 (per-key gates)", len(notices))
	}
	raw, _ = json.Marshal(notices[1].Payload)
	var pl2 map[string]any
	if json.Unmarshal(raw, &pl2) != nil {
		t.Fatalf("notice payload not JSON-object: %+v", notices[1].Payload)
	}
	if pl2["dimension"] != "token" || pl2["key"] != "tok-B" {
		t.Fatalf("token notice payload = %+v", pl2)
	}
}

// TestTerminalSearchRateLimit429RealWiring 真实接线：生产窗口 + 真
// SearchTerminalOutput 链路（DefaultManager 无会话 → 命中恒空，扫描零负担）
// 只断言 429 形态与 Retry-After ∈ [1,60]（生产窗口 1 分钟），不测恢复
func TestTerminalSearchRateLimit429RealWiring(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/search", SearchOutputRateLimit(), SearchTerminalOutput)

	path := "/api/terminals/search?q=needle"
	burnTerminalSearchBudget(t, r, path)
	w := assertTerminalSearch429(t, getTerminalSearch(r, path))
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if ra := body["retry_after"].(float64); ra > 60 {
		t.Fatalf("429 retry_after = %v, want <= 60 (production window)", ra)
	}
}

// terminalNoticeEnv 测试观察者捕获面（gitops searchNoticeEnv 同款形态）
type terminalNoticeEnv struct {
	events []opschannel.Event
	mu     sync.Mutex
}

func (env *terminalNoticeEnv) of(typ string) []opschannel.Event {
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
