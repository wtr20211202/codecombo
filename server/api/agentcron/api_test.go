package agentcron

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 保存口校验单测（P-20261003-124）：依赖链字段的归一、父存在性、环拒绝、
// 有子任务拒删。存储用真实 filestore（读改写路径一并覆盖），gin 用测试
// 上下文直驱 handler（不经路由表，鉴权由中间件层另行负责）

func newAPIEnv(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
}

// call 以 JSON 体直驱单个 handler；id 非空时注入 :id 参数
func call(t *testing.T, handler gin.HandlerFunc, method, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	if body != "" {
		c.Request = httptest.NewRequest(method, "/api/agent-crons", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
	} else {
		c.Request = httptest.NewRequest(method, "/api/agent-crons", nil)
	}
	if id != "" {
		c.Params = gin.Params{{Key: "id", Value: id}}
	}
	handler(c)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response: %v\nbody: %s", err, w.Body.String())
	}
	return m
}

const baseCron = `{"name":"t","hour":2,"minute":0,"prompt":"p","enabled":true`

func TestCreateCron_TriggerValidation(t *testing.T) {
	newAPIEnv(t)

	// 非法触发类型 / 非法档位 / after 缺父：一律 400 且不落库
	for _, tc := range []struct {
		body, wantMsg string
	}{
		{baseCron + `,"trigger":"bogus"}`, "unknown trigger type"},
		{baseCron + `,"trigger":"after"}`, "parent cron is required"},
		{baseCron + `,"trigger":"after","afterCronId":"sc_cron_x","afterMode":"bogus"}`, "unknown after mode"},
	} {
		w := call(t, CreateCron, http.MethodPost, "", tc.body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", tc.body, w.Code)
		}
		if msg, _ := decode(t, w)["error"].(string); !strings.Contains(msg, tc.wantMsg) {
			t.Fatalf("body %s: error = %q, want contains %q", tc.body, msg, tc.wantMsg)
		}
	}
	if items, _ := store.Get().AgentCron.List(); len(items) != 0 {
		t.Fatalf("rejected payloads must not persist, got %d", len(items))
	}

	// 父不存在：400 parent cron not found
	w := call(t, CreateCron, http.MethodPost, "", baseCron+`,"trigger":"after","afterCronId":"sc_cron_missing"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing parent: status = %d, want 400", w.Code)
	}
	if msg, _ := decode(t, w)["error"].(string); !strings.Contains(msg, "parent cron not found") {
		t.Fatalf("error = %q", msg)
	}
}

func TestCreateCron_AfterTriggerHappyPath(t *testing.T) {
	newAPIEnv(t)
	parent := call(t, CreateCron, http.MethodPost, "", baseCron+`}`)
	if parent.Code != http.StatusCreated {
		t.Fatalf("parent create: %d", parent.Code)
	}
	pid := decode(t, parent)["data"].(map[string]any)["id"].(string)

	// after 子任务：档位缺省归一为 success；无「下次运行」预览（事件驱动无时刻概念）
	w := call(t, CreateCron, http.MethodPost, "",
		baseCron+`,"name":"child","trigger":"after","afterCronId":"`+pid+`"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("child create: %d body=%s", w.Code, w.Body.String())
	}
	data := decode(t, w)["data"].(map[string]any)
	if data["trigger"] != store.CronTriggerAfter || data["afterMode"] != store.CronAfterSuccess {
		t.Fatalf("trigger/mode = %v/%v, want after/success", data["trigger"], data["afterMode"])
	}
	if next, ok := data["nextRunAt"]; !ok || next != nil {
		t.Fatalf("after task nextRunAt = %v (ok=%v), want null", next, ok)
	}

	// 定时任务归一：显式 schedule，依赖字段清空（类型切换不留脏指向）
	w = call(t, CreateCron, http.MethodPost, "",
		baseCron+`,"name":"sched","afterCronId":"`+pid+`","afterMode":"always"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("schedule create: %d", w.Code)
	}
	data = decode(t, w)["data"].(map[string]any)
	if data["trigger"] != store.CronTriggerSchedule || data["afterCronId"] != nil || data["afterMode"] != nil {
		t.Fatalf("schedule task should clear dependency fields, got %v/%v/%v",
			data["trigger"], data["afterCronId"], data["afterMode"])
	}
}

func TestUpdateCron_RejectsCycle(t *testing.T) {
	newAPIEnv(t)
	a := call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"a"}`)
	b := call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"b"}`)
	ida := decode(t, a)["data"].(map[string]any)["id"].(string)
	idb := decode(t, b)["data"].(map[string]any)["id"].(string)

	// A 依赖 B：合法
	w := call(t, UpdateCron, http.MethodPut, ida, baseCron+`,"name":"a","trigger":"after","afterCronId":"`+idb+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("a→b update: %d body=%s", w.Code, w.Body.String())
	}

	// B 改为依赖 A：A 的链已指向 B，成环 → 400
	w = call(t, UpdateCron, http.MethodPut, idb, baseCron+`,"name":"b","trigger":"after","afterCronId":"`+ida+`"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cycle update should be 400, got %d", w.Code)
	}
	if msg, _ := decode(t, w)["error"].(string); !strings.Contains(msg, "cycle") {
		t.Fatalf("error = %q, want cycle marker", msg)
	}
	// B 的坏请求未落库：仍是无依赖定时任务
	if got, _ := store.Get().AgentCron.Get(idb); got.IsAfterTrigger() {
		t.Fatalf("rejected cycle must not persist, got %+v", got)
	}
}

func TestDeleteCron_RejectsWhenDependents(t *testing.T) {
	newAPIEnv(t)
	a := call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"a"}`)
	ida := decode(t, a)["data"].(map[string]any)["id"].(string)
	call(t, CreateCron, http.MethodPost, "",
		baseCron+`,"name":"child","trigger":"after","afterCronId":"`+ida+`"}`)

	// 有子任务：删除拒绝（409），先解除或删除子任务
	w := call(t, DeleteCron, http.MethodDelete, ida, "")
	if w.Code != http.StatusConflict {
		t.Fatalf("delete with dependents = %d, want 409", w.Code)
	}
	if _, err := store.Get().AgentCron.Get(ida); err != nil {
		t.Fatalf("parent must survive rejected delete: %v", err)
	}
}

// relayFrom 保存口校验（P-20261005-207）：latest/显式会话 id/空均合法落库；
// 超长 400；归一化 trim；不做源会话存在性校验（触发期降级兜底）
func TestCreateCron_RelayFromValidation(t *testing.T) {
	newAPIEnv(t)

	w := call(t, CreateCron, http.MethodPost, "", baseCron+`,"relayFrom":"`+strings.Repeat("x", 200)+`"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("over-length relayFrom: status = %d, want 400", w.Code)
	}
	if msg, _ := decode(t, w)["error"].(string); !strings.Contains(msg, "relayFrom too long") {
		t.Fatalf("error = %q", msg)
	}

	// latest 形态 + 前后空白归一
	w = call(t, CreateCron, http.MethodPost, "", baseCron+`,"relayFrom":" latest "}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("latest relayFrom: status = %d, want 201: %s", w.Code, w.Body.String())
	}
	item, _ := store.Get().AgentCron.List()
	if len(item) != 1 || item[0].RelayFrom != store.CronRelayLatest {
		t.Fatalf("relayFrom should persist trimmed, got %+v", item)
	}

	// 显式会话 id 不做存在性校验（源可晚于任务创建，失效由触发期降级兜底）
	w = call(t, CreateCron, http.MethodPost, "", baseCron+`,"relayFrom":"no-such-session"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("explicit id: status = %d, want 201", w.Code)
	}
}

// extract 保存口校验（P-20261005-237）：坏规则 400 不落库；合法规则 trim 落库
func TestCreateCron_ExtractValidation(t *testing.T) {
	newAPIEnv(t)

	for _, body := range []string{
		baseCron + `,"extract":"(?P<sec>[0-9.]+"}`,                  // 编译失败
		baseCron + `,"extract":"build ([0-9.]+)s"}`,                 // 无命名组
		baseCron + `,"extract":"json:"}`,                            // 空路径
		baseCron + `,"extract":"json:a..b"}`,                        // 空段
		baseCron + `,"extract":"` + strings.Repeat("a", 300) + `"}`, // 超长
	} {
		w := call(t, CreateCron, http.MethodPost, "", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
	if items, _ := store.Get().AgentCron.List(); len(items) != 0 {
		t.Fatalf("rejected extract rules must not persist, got %d", len(items))
	}

	// 合法规则归一 trim 落库
	w := call(t, CreateCron, http.MethodPost, "", baseCron+`,"extract":" (?P<sec>[0-9.]+)s "}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("valid extract: status = %d, want 201: %s", w.Code, w.Body.String())
	}
	items, _ := store.Get().AgentCron.List()
	if len(items) != 1 || items[0].Extract != `(?P<sec>[0-9.]+)s` {
		t.Fatalf("extract should persist trimmed, got %+v", items)
	}

	// 空规则 = 关闭（存量零迁移形态）
	w = call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"no-extract","extract":""}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("empty extract: status = %d, want 201", w.Code)
	}
}

// timezone 保存口校验（P-20261005-217）：IANA 名前置 LoadLocation——非法名
// 400 不落库、超长 400；合法名 trim 落库；空 = 服务器本地（存量语义）。
// 列表响应携 server 段（服务器时区名/当前时刻/数字偏移）供前端对表标注
func TestCreateCron_TimezoneValidation(t *testing.T) {
	newAPIEnv(t)

	for _, body := range []string{
		baseCron + `,"timezone":"Not/AZone"}`,                        // LoadLocation 失败
		baseCron + `,"timezone":"Asia/Shanghai/../.."}`,              // 路径穿越形态同样拒绝（LoadLocation 不认）
		baseCron + `,"timezone":"` + strings.Repeat("A", 100) + `"}`, // 超长
	} {
		w := call(t, CreateCron, http.MethodPost, "", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
	if items, _ := store.Get().AgentCron.List(); len(items) != 0 {
		t.Fatalf("rejected timezones must not persist, got %d", len(items))
	}

	// 合法 IANA 名归一 trim 落库
	w := call(t, CreateCron, http.MethodPost, "", baseCron+`,"timezone":" Asia/Tokyo "}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("valid timezone: status = %d, want 201: %s", w.Code, w.Body.String())
	}
	items, _ := store.Get().AgentCron.List()
	if len(items) != 1 || items[0].Timezone != "Asia/Tokyo" {
		t.Fatalf("timezone should persist trimmed, got %+v", items)
	}

	// 空 = 服务器本地（omitempty 序列化下键缺席），存量语义不变
	w = call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"local-tz","timezone":""}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("empty timezone: status = %d, want 201", w.Code)
	}

	// 列表响应 server 段：三键齐备，now 自带数字偏移
	list := call(t, ListCrons, http.MethodGet, "", "")
	server, ok := decode(t, list)["server"].(map[string]any)
	if !ok {
		t.Fatalf("list response should carry server timezone info, got %s", list.Body.String())
	}
	for _, k := range []string{"name", "now", "utcOffset"} {
		if v, _ := server[k].(string); v == "" {
			t.Fatalf("server.%s missing/empty: %v", k, server)
		}
	}
	if off, _ := server["utcOffset"].(string); len(off) != 6 || (off[0] != '+' && off[0] != '-') {
		t.Fatalf("utcOffset = %q, want ±HH:MM form", off)
	}
}

// 指标时序随列表 API 透出（P-20261005-237）：有点位才带 metric 键（无数据 =
// 键缺席，不以空数组冒充），name 由规则派生、points 时间升序；任务删除级联
// 清理时序文档
func TestListCrons_MetricExposureAndDeleteCascade(t *testing.T) {
	newAPIEnv(t)

	w := call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"m","extract":"(?P<sec>[0-9.]+)s"}`)
	id := decode(t, w)["data"].(map[string]any)["id"].(string)
	call(t, CreateCron, http.MethodPost, "", baseCron+`,"name":"plain"}`)

	// 无点位：两任务都不带 metric 键
	listResp := call(t, ListCrons, http.MethodGet, "", "")
	items := decode(t, listResp)["data"].([]any)
	for _, it := range items {
		if _, has := it.(map[string]any)["metric"]; has {
			t.Fatalf("no points yet, metric key must be absent: %v", it)
		}
	}

	// 落两个点位（append 顺序 = 时间升序）
	store.Get().CronMetric.Append(id, store.CronMetricPoint{At: time.Now().Add(-time.Minute), Value: 3.5})
	store.Get().CronMetric.Append(id, store.CronMetricPoint{At: time.Now(), Value: 4})

	listResp = call(t, ListCrons, http.MethodGet, "", "")
	items = decode(t, listResp)["data"].([]any)
	var metric map[string]any
	for _, it := range items {
		m := it.(map[string]any)
		if m["name"] == "m" {
			metric, _ = m["metric"].(map[string]any)
		}
	}
	if metric == nil {
		t.Fatal("task with points should expose metric series")
	}
	if metric["name"] != "sec" {
		t.Fatalf("metric name = %v, want sec (regex group)", metric["name"])
	}
	pts, _ := metric["points"].([]any)
	if len(pts) != 2 {
		t.Fatalf("points = %v, want 2", pts)
	}
	first := pts[0].(map[string]any)
	if first["value"].(float64) != 3.5 {
		t.Fatalf("points must be time-ascending (oldest first), got %v", pts)
	}

	// 无规则任务仍无 metric 键（并存对照）
	for _, it := range items {
		m := it.(map[string]any)
		if m["name"] == "plain" {
			if _, has := m["metric"]; has {
				t.Fatal("task without extract must not carry metric")
			}
		}
	}

	// 删除级联：时序文档随任务清理
	if w := call(t, DeleteCron, http.MethodDelete, id, ""); w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	if h := store.Get().CronMetric.History(id, 0); len(h) != 0 {
		t.Fatalf("metric history should cascade-delete with the task, got %+v", h)
	}
}
