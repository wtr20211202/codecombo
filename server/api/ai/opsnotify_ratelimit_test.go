package ai

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/metrics"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ops-notify 发布频率限制（P-20261002-91）单测：
// 窗口内放行上限 / 超限静默丢弃 + 回告节流 / 会话维度隔离 / 令牌维度回退。

// resetRateLimiters 换新包级限流器与回告闸门并还原：限流器窗口 1 分钟且跨
// 用例共享（同进程内所有 ai 包用例共用同一 map），不复位会互相污染计数——
// 与 opschannel.SetObserver 的测试复位同思路
func resetRateLimiters(t *testing.T) {
	t.Helper()
	oldLimiter, oldGate := opsNotifyLimiter, opsNotifyFeedbackGate
	opsNotifyLimiter = middleware.NewRateLimiter(opsNotifyRateLimit, opsNotifyWindow)
	opsNotifyFeedbackGate = middleware.NewRateLimiter(1, opsNotifyWindow)
	t.Cleanup(func() { opsNotifyLimiter, opsNotifyFeedbackGate = oldLimiter, oldGate })
}

// setupRateLimitTest 限流测试装配（与 setupNotifyTest 同构 + 限流器复位 +
// 指标复位）：独立 store + 本组路由
func setupRateLimitTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	resetRateLimiters(t)
	metrics.ResetForTesting()
	t.Cleanup(metrics.ResetForTesting)
	r := gin.New()
	r.POST("/api/ops-notify", OpsNotify)
	return r
}

// eventRecorder 广播事件收集器：观察者在请求 goroutine 内同步执行，用例串行
// 发请求，无需加锁
type eventRecorder struct{ events []opschannel.Event }

func (r *eventRecorder) of(eventType string) []opschannel.Event {
	var out []opschannel.Event
	for _, ev := range r.events {
		if ev.Type == eventType {
			out = append(out, ev)
		}
	}
	return out
}

// recordEvents 注入观察者收集广播流（含被限流器放行的回告事件），用例结束退订
func recordEvents(t *testing.T) *eventRecorder {
	t.Helper()
	rec := &eventRecorder{}
	unsub := opschannel.AddObserver(func(ev opschannel.Event) { rec.events = append(rec.events, ev) })
	t.Cleanup(unsub)
	return rec
}

// postSessionNotify 以指定会话发布一条 task.progress（头 + 载荷双标识）
func postSessionNotify(r *gin.Engine, session string) *httptest.ResponseRecorder {
	body := `{"type":"task.progress","payload":{"task":"rl","status":"running","step":"s","sessionId":"` + session + `"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/ops-notify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-ID", session)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestOpsNotify_RateLimit_DropsExcessWithSingleNotice 超限静默丢弃 + 回告节流：
// 窗口内前 60 条照常发布；超限部分不再广播但仍回 200（不诱发重试放大风暴）；
// 回告事件每维度每窗口仅放行一条，载荷携带维度/丢弃数/限流参数
func TestOpsNotify_RateLimit_DropsExcessWithSingleNotice(t *testing.T) {
	r := setupRateLimitTest(t)
	rec := recordEvents(t)

	const session = "rl-drop-1"
	// 前置一条坏类型请求：400 退回发生在限流之前，不占用发布预算
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid type expect 400, got %d", w.Code)
	}

	for i := 0; i < opsNotifyRateLimit; i++ {
		if w := postSessionNotify(r, session); w.Code != http.StatusOK {
			t.Fatalf("in-budget #%d expect 200, got %d body=%s", i, w.Code, w.Body.String())
		}
	}
	if got := len(rec.of("task.progress")); got != opsNotifyRateLimit {
		t.Fatalf("in-budget published = %d, want %d", got, opsNotifyRateLimit)
	}
	if got := len(rec.of("system:rate-limited")); got != 0 {
		t.Fatalf("budget boundary must not trigger notice, got %d", got)
	}

	// 超限 5 条：静默 200 但不广播，回告仅首次超限放行 1 条
	for i := 0; i < 5; i++ {
		w := postSessionNotify(r, session)
		if w.Code != http.StatusOK {
			t.Fatalf("over-limit must drop silently with 200, got %d body=%s", w.Code, w.Body.String())
		}
	}
	if got := len(rec.of("task.progress")); got != opsNotifyRateLimit {
		t.Fatalf("over-limit events must not broadcast, published = %d, want %d", got, opsNotifyRateLimit)
	}
	notices := rec.of("system:rate-limited")
	if len(notices) != 1 {
		t.Fatalf("expect exactly 1 rate-limited notice per window, got %d", len(notices))
	}
	if notices[0].Source != "system" {
		t.Fatalf("notice source = %q, want system", notices[0].Source)
	}
	p, ok := notices[0].Payload.(opschannel.RateLimitedNotice)
	if !ok {
		t.Fatalf("notice payload type = %T, want opschannel.RateLimitedNotice", notices[0].Payload)
	}
	if p.Dimension != "session" || p.Key != session || p.Dropped != 1 ||
		p.Limit != opsNotifyRateLimit || p.WindowSec != 60 {
		t.Fatalf("notice payload mismatch: %+v", p)
	}

	// 超限计数进 /api/metrics：5 次丢弃累计 5（观测面）
	if render := metrics.Render(); !strings.Contains(render, "sc_ops_notify_limited_total 5") {
		t.Fatalf("metrics expect sc_ops_notify_limited_total 5, got:\n%s", render)
	}
}

// TestOpsNotify_RateLimit_SessionIsolation 会话维度隔离：A 会话打满预算后，
// B 会话首条仍照常发布——单会话风暴不挤占他人预算
func TestOpsNotify_RateLimit_SessionIsolation(t *testing.T) {
	r := setupRateLimitTest(t)
	rec := recordEvents(t)

	for i := 0; i < opsNotifyRateLimit; i++ {
		if w := postSessionNotify(r, "rl-iso-a"); w.Code != http.StatusOK {
			t.Fatalf("session A #%d expect 200, got %d", i, w.Code)
		}
	}
	// A 恰好在预算边界（不超限）；B 全新预算
	if w := postSessionNotify(r, "rl-iso-b"); w.Code != http.StatusOK {
		t.Fatalf("session B first post expect 200, got %d", w.Code)
	}
	bPublished := 0
	for _, ev := range rec.of("task.progress") {
		if m, ok := ev.Payload.(map[string]interface{}); ok && m["sessionId"] == "rl-iso-b" {
			bPublished++
		}
	}
	if bPublished != 1 {
		t.Fatalf("session B must broadcast independently, published = %d", bPublished)
	}
	if got := len(rec.of("system:rate-limited")); got != 0 {
		t.Fatalf("boundary-filling session must not trigger notice, got %d", got)
	}
}

// TestOpsNotify_RateLimit_TokenFallback 无会话标识时回退调用令牌维度：
// 模拟鉴权中间件注入 tokenID，超限回告 dimension=token
func TestOpsNotify_RateLimit_TokenFallback(t *testing.T) {
	setupRateLimitTest(t)
	rec := recordEvents(t)

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("tokenID", "agent-tok-1"); c.Next() })
	r.POST("/api/ops-notify", OpsNotify)

	body := `{"type":"navigate","payload":{"path":"/project"}}`
	for i := 0; i < opsNotifyRateLimit; i++ {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("in-budget #%d expect 200, got %d", i, w.Code)
		}
	}
	// 第 61 条：载荷无 sessionId、无 X-Session-ID 头 → 退 token 维度，超限丢弃
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", body); w.Code != http.StatusOK {
		t.Fatalf("over-limit expect silent 200, got %d", w.Code)
	}
	if got := len(rec.of("navigate")); got != opsNotifyRateLimit {
		t.Fatalf("over-limit navigate must not broadcast, published = %d, want %d", got, opsNotifyRateLimit)
	}
	notices := rec.of("system:rate-limited")
	if len(notices) != 1 {
		t.Fatalf("expect exactly 1 rate-limited notice, got %d", len(notices))
	}
	p, ok := notices[0].Payload.(opschannel.RateLimitedNotice)
	if !ok {
		t.Fatalf("notice payload type = %T, want opschannel.RateLimitedNotice", notices[0].Payload)
	}
	if p.Dimension != "token" || p.Key != "agent-tok-1" || p.Dropped != 1 {
		t.Fatalf("token-dimension notice mismatch: %+v", p)
	}
}

// TestOpsNotify_RateLimit_PayloadSessionIdFallback 头缺失时退载荷 sessionId：
// 仅 task.progress 载荷携带 sessionId（无 X-Session-ID 头）同样按会话维度记账
func TestOpsNotify_RateLimit_PayloadSessionIdFallback(t *testing.T) {
	r := setupRateLimitTest(t)
	rec := recordEvents(t)

	body := `{"type":"task.progress","payload":{"task":"rl","status":"running","step":"s","sessionId":"rl-payload-only"}}`
	for i := 0; i < opsNotifyRateLimit+1; i++ {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("#%d expect 200, got %d", i, w.Code)
		}
	}
	if got := len(rec.of("task.progress")); got != opsNotifyRateLimit {
		t.Fatalf("payload-session dimension must cap at %d, got %d", opsNotifyRateLimit, got)
	}
	notices := rec.of("system:rate-limited")
	if len(notices) != 1 {
		t.Fatalf("expect exactly 1 rate-limited notice, got %d", len(notices))
	}
	p, ok := notices[0].Payload.(opschannel.RateLimitedNotice)
	if !ok {
		t.Fatalf("notice payload type = %T, want opschannel.RateLimitedNotice", notices[0].Payload)
	}
	if p.Dimension != "session" || p.Key != "rl-payload-only" {
		t.Fatalf("payload-session notice mismatch: %+v", p)
	}
}
