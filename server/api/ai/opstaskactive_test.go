package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// resetLastProgressForTest 清空包级缓存（用例间隔离；包级单点同
// opsNotifyLimiter 的测试复位纪律）
func resetLastProgressForTest(t *testing.T) {
	t.Helper()
	lastProgressMu.Lock()
	lastProgressBySid = map[string]lastProgressEntry{}
	lastProgressMu.Unlock()
	t.Cleanup(func() {
		lastProgressMu.Lock()
		lastProgressBySid = map[string]lastProgressEntry{}
		lastProgressMu.Unlock()
	})
}

// setupActiveTest 上报 + 查询两路由的本组装配（与 setupNotifyTest 同构）
func setupActiveTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	resetLastProgressForTest(t)
	r := gin.New()
	r.POST("/api/ops-notify", OpsNotify)
	r.GET("/api/ops-tasks/active", ActiveOpsTasks)
	return r
}

// activeTasks 拉取快照并解码（测试断言辅助）
func activeTasks(t *testing.T, r *gin.Engine) []map[string]interface{} {
	t.Helper()
	w := doJSON(r, http.MethodGet, "/api/ops-tasks/active", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET active expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Tasks      []map[string]interface{} `json:"tasks"`
			ServerTime int64                    `json:"serverTime"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v body=%s", err, w.Body.String())
	}
	if body.Data.ServerTime <= 0 {
		t.Fatalf("serverTime 应为正的 unix 毫秒，got %d", body.Data.ServerTime)
	}
	return body.Data.Tasks
}

// doJSONHeaders doJSON 的带头变体（X-Session-ID 等归属头测试需要）
func doJSONHeaders(r *gin.Engine, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// reportProgress 经真实发布口上报一条 task.progress（headers 可带 X-Session-ID）
func reportProgress(t *testing.T, r *gin.Engine, headers map[string]string, payload string) {
	t.Helper()
	h := map[string]string{}
	for k, v := range headers {
		h[k] = v
	}
	w := doJSONHeaders(r, http.MethodPost, "/api/ops-notify", `{"type":"task.progress","payload":`+payload+`}`, h)
	if w.Code != http.StatusOK {
		t.Fatalf("report expect 200, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestActiveOpsTasks_SeedAndQuery(t *testing.T) {
	r := setupActiveTest(t)

	// 无上报时空快照
	if tasks := activeTasks(t, r); len(tasks) != 0 {
		t.Fatalf("空态应无条目, got %v", tasks)
	}

	reportProgress(t, r, map[string]string{"X-Session-ID": "term-a"},
		`{"task":"切换主题","status":"running","step":"写入设置","steps":[{"name":"读取","done":true}]}`)
	reportProgress(t, r, nil,
		`{"task":"派发任务","status":"running","step":"编译","terminalId":"term-b"}`)

	tasks := activeTasks(t, r)
	if len(tasks) != 2 {
		t.Fatalf("应有两个会话条目, got %v", tasks)
	}
	// 归属：头优先、载荷 terminalId 兜底
	bySid := map[string]map[string]interface{}{}
	for _, task := range tasks {
		sid, _ := task["sessionId"].(string)
		bySid[sid] = task
	}
	if bySid["term-a"] == nil || bySid["term-b"] == nil {
		t.Fatalf("会话归属缺失（头优先/terminalId 兜底）, got %v", tasks)
	}
	for sid, task := range bySid {
		payload, ok := task["payload"].(map[string]interface{})
		if !ok {
			t.Fatalf("%s payload 应为对象, got %v", sid, task["payload"])
		}
		if payload["task"] == "" {
			t.Fatalf("%s payload.task 不应为空", sid)
		}
		if ts, _ := task["receivedAt"].(float64); ts <= 0 {
			t.Fatalf("%s receivedAt 应为正的 unix 毫秒, got %v", sid, task["receivedAt"])
		}
	}
	// 同会话重报 = 覆盖（每会话至多一条）
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-a"}, `{"task":"第二任务","status":"running"}`)
	tasks = activeTasks(t, r)
	if len(tasks) != 2 {
		t.Fatalf("重报应覆盖不新增, got %d 条", len(tasks))
	}
	for _, task := range tasks {
		if task["sessionId"] == "term-a" {
			payload := task["payload"].(map[string]interface{})
			if payload["task"] != "第二任务" {
				t.Fatalf("重报应整条覆盖, got %v", payload)
			}
		}
	}
}

func TestActiveOpsTasks_NoSessionNotCached(t *testing.T) {
	r := setupActiveTest(t)
	// 无头且载荷无归属：不缓存（挂不到会话 = 等不到「会话关闭即摘除」的幽灵）
	reportProgress(t, r, nil, `{"task":"无归属","status":"running"}`)
	if tasks := activeTasks(t, r); len(tasks) != 0 {
		t.Fatalf("无归属上报不应入缓存, got %v", tasks)
	}
}

func TestActiveOpsTasks_RateLimitedDropNotCached(t *testing.T) {
	r := setupActiveTest(t)
	// 限流面与缓存面对齐：超限丢弃的上报不进广播流，也不入缓存。
	// 上限取常量 opsNotifyRateLimit（判定式 count > 常量，换限流器不生效——
	// 既有 ratelimit 用例同口径），首条入缓存，第 N+1 条被丢不得覆盖
	oldLimiter, oldGate := opsNotifyLimiter, opsNotifyFeedbackGate
	opsNotifyLimiter = middleware.NewRateLimiter(opsNotifyRateLimit, opsNotifyWindow)
	opsNotifyFeedbackGate = middleware.NewRateLimiter(1, opsNotifyWindow)
	t.Cleanup(func() { opsNotifyLimiter, opsNotifyFeedbackGate = oldLimiter, oldGate })

	reportProgress(t, r, map[string]string{"X-Session-ID": "term-rl"}, `{"task":"首条","status":"running"}`)
	for i := 0; i < opsNotifyRateLimit; i++ {
		reportProgress(t, r, map[string]string{"X-Session-ID": "term-rl"}, `{"task":"预算内","status":"running"}`)
	}
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-rl"}, `{"task":"超限被丢","status":"running"}`)

	tasks := activeTasks(t, r)
	if len(tasks) != 1 {
		t.Fatalf("限流后仍应只有一条, got %v", tasks)
	}
	payload := tasks[0]["payload"].(map[string]interface{})
	if payload["task"] != "预算内" {
		t.Fatalf("被限流丢弃的上报不应覆盖缓存, got %v", payload)
	}
}

func TestPruneLastProgressObserver(t *testing.T) {
	r := setupActiveTest(t)
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-live"}, `{"task":"存活","status":"running"}`)
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-dead"}, `{"task":"将死","status":"running"}`)
	observe := PruneLastProgressObserver()

	// 快照只含存活会话：死会话条目摘除
	observe(opschannel.Event{Type: opschannel.EventTerminalsChanged,
		Payload: gin.H{"sessions": []gin.H{{"id": "term-live"}}}})
	tasks := activeTasks(t, r)
	if len(tasks) != 1 || tasks[0]["sessionId"] != "term-live" {
		t.Fatalf("死会话条目应被摘除, got %v", tasks)
	}

	// 空数组 = 全部关闭的真快照：全清
	observe(opschannel.Event{Type: opschannel.EventTerminalsChanged, Payload: gin.H{"sessions": []gin.H{}}})
	if tasks := activeTasks(t, r); len(tasks) != 0 {
		t.Fatalf("空快照应清空缓存, got %v", tasks)
	}

	// sessions 键缺席（读不懂的对账单）不动缓存
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-x"}, `{"task":"保留","status":"running"}`)
	observe(opschannel.Event{Type: opschannel.EventTerminalsChanged, Payload: gin.H{"other": 1}})
	if tasks := activeTasks(t, r); len(tasks) != 1 {
		t.Fatalf("畸形快照不应动缓存, got %v", tasks)
	}

	// 非 terminals.changed 事件不触发清理
	observe(opschannel.Event{Type: opschannel.EventTaskProgress, Payload: gin.H{"sessions": []gin.H{}}})
	if tasks := activeTasks(t, r); len(tasks) != 1 {
		t.Fatalf("非快照事件不应清缓存, got %v", tasks)
	}
}

func TestActiveOpsTasks_SortedByReceivedAtAsc(t *testing.T) {
	r := setupActiveTest(t)
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-1"}, `{"task":"一","status":"running"}`)
	// 时间序以 receivedAt 为准：同毫秒内不保证稳定，这里只验证升序不变式
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-2"}, `{"task":"二","status":"running"}`)
	reportProgress(t, r, map[string]string{"X-Session-ID": "term-3"}, `{"task":"三","status":"running"}`)

	tasks := activeTasks(t, r)
	var last time.Time
	for i, task := range tasks {
		ms, _ := task["receivedAt"].(float64)
		ts := time.UnixMilli(int64(ms))
		if i > 0 && ts.Before(last) {
			t.Fatalf("快照应 receivedAt 升序, index %d out of order: %v", i, tasks)
		}
		last = ts
	}
	if len(tasks) != 3 {
		t.Fatalf("应有三条, got %d", len(tasks))
	}
}
