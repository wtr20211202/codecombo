package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// notify.persist 通知入账原语（P-20261007-10）单测：
// 发布口载荷校验（title/level/action 白名单/actionPayload 形态）/ 服务端入账
// （遮蔽 + level 映射 + 偏好过滤）/ 限流共享预算。

// setupPersistTest 入账测试装配（与 setupNotifyTest 同构 + 限流器复位）
func setupPersistTest(t *testing.T) *gin.Engine {
	t.Helper()
	r := setupNotifyTest(t)
	resetRateLimiters(t)
	return r
}

// persistedNotifications 读测试 store 的通知全量（入账断言用）
func persistedNotifications(t *testing.T) []notification.Notification {
	t.Helper()
	return store.Get().Notification.List(0)
}

func TestOpsNotify_NotifyPersistPayload(t *testing.T) {
	r := setupPersistTest(t)

	valid := []string{
		`{"type":"notify.persist","payload":{"title":"构建完成"}}`,
		`{"type":"notify.persist","payload":{"title":" 回归测试通过 ","body":"42 个用例全绿","level":"success"}}`,
		`{"type":"notify.persist","payload":{"title":"t","level":"warning"}}`,
		`{"type":"notify.persist","payload":{"title":"t","level":"error"}}`,
		`{"type":"notify.persist","payload":{"title":"t","action":"terminal","actionPayload":"tm-123"}}`,
		`{"type":"notify.persist","payload":{"title":"t","action":"panel","actionPayload":"git"}}`,
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"https://ci.example.com/run/42"}}`,
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"http://localhost:3000/report"}}`,
		`{"type":"notify.persist","payload":{"title":"t","action":"preview","actionPayload":"3000"}}`,
		// 恰在 title 边界：200 rune 合法（多字节 rune 按 rune 计）
		`{"type":"notify.persist","payload":{"title":"` + strings.Repeat("标", 200) + `"}}`,
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"notify.persist"}`,                                                                              // 缺 payload → title 空
		`{"type":"notify.persist","payload":{}}`,                                                                 // 缺 title
		`{"type":"notify.persist","payload":{"title":"  "}}`,                                                     // 空白 title
		`{"type":"notify.persist","payload":{"title":"` + strings.Repeat("标", 201) + `"}}`,                       // 超 200 rune
		`{"type":"notify.persist","payload":{"title":"t","level":"critical"}}`,                                   // level 越枚举
		`{"type":"notify.persist","payload":{"title":"t","level":3}}`,                                            // level 非字符串
		`{"type":"notify.persist","payload":{"title":"t","action":"agent-fix","actionPayload":"dt1"}}`,           // 人裁决面动作不对 agent 开放
		`{"type":"notify.persist","payload":{"title":"t","action":"watch-fallback"}}`,                            // 白名单外
		`{"type":"notify.persist","payload":{"title":"t","action":"terminal"}}`,                                  // 缺 actionPayload
		`{"type":"notify.persist","payload":{"title":"t","actionPayload":"tm-1"}}`,                               // 载荷无主（缺 action）
		`{"type":"notify.persist","payload":{"title":"t","action":"terminal","actionPayload":"a b"}}`,            // 会话 id 含空白
		`{"type":"notify.persist","payload":{"title":"t","action":"panel","actionPayload":"Git"}}`,               // 面板名越字符集
		`{"type":"notify.persist","payload":{"title":"t","action":"panel","actionPayload":"a_b"}}`,               // 面板名越字符集
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"javascript:alert(1)"}}`, // 伪协议
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"//evil.com/x"}}`,        // 协议相对外链
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"/relative/path"}}`,      // 非绝对外链
		`{"type":"notify.persist","payload":{"title":"t","action":"url","actionPayload":"https://a b.com/"}}`,    // url 含空白
		`{"type":"notify.persist","payload":{"title":"t","action":"preview","actionPayload":"80"}}`,              // 特权段
		`{"type":"notify.persist","payload":{"title":"t","action":"preview","actionPayload":"65536"}}`,           // 越上界
		`{"type":"notify.persist","payload":{"title":"t","action":"preview","actionPayload":"3000.5"}}`,          // 非整数
		`{"type":"notify.persist","payload":{"title":"t","action":"preview","actionPayload":"abc"}}`,             // 非数字
		`{"type":"notify.persist","payload":{"title":123}}`,                                                      // title 非字符串
		`{"type":"notify.persist","payload":["t"]}`,                                                              // 载荷非对象
		`{"type":"notify.persist","payload":"title"}`,                                                            // 载荷非对象（标量）
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid notify.persist payload") {
			t.Fatalf("%s expect invalid payload message, got %s", body, w.Body.String())
		}
	}

	// 坏载荷不占用限流预算（校验在限流前），合法载荷随后照常发布
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"notify.persist","payload":{"title":"still fine"}}`); w.Code != http.StatusOK {
		t.Fatalf("post-invalid valid expect 200, got %d", w.Code)
	}
}

// TestOpsNotify_NotifyPersistNormalized 合法载荷经校验规整后广播：level 缺省
// 规整 info、title/body 遮蔽后原值进广播流（前端弹面与入账同源）
func TestOpsNotify_NotifyPersistNormalized(t *testing.T) {
	r := setupPersistTest(t)
	rec := recordEvents(t)

	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"notify.persist","payload":{"title":"部署完成 token=sk-abc123def","body":"见 https://example.com","level":"success","action":"url","actionPayload":"https://example.com/r/1"}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	evs := rec.of("notify.persist")
	if len(evs) != 1 {
		t.Fatalf("expect 1 broadcast, got %d", len(evs))
	}
	p, ok := evs[0].Payload.(agentops.NotifyPersistPayload)
	if !ok {
		t.Fatalf("payload type = %T, want agentops.NotifyPersistPayload", evs[0].Payload)
	}
	// 遮蔽：sc?_/赋值形态整段 ***（此处 token= 赋值形态命中）
	if strings.Contains(p.Title, "sk-abc123def") {
		t.Fatalf("title must be masked at ingest, got %q", p.Title)
	}
	if !strings.Contains(p.Title, "***") {
		t.Fatalf("title expect mask marker, got %q", p.Title)
	}
	if p.Level != "success" || p.Action != "url" || p.ActionPayload != "https://example.com/r/1" {
		t.Fatalf("fields expect passthrough, got %+v", p)
	}

	// level 缺省规整 info
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"notify.persist","payload":{"title":"no level"}}`); w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	evs = rec.of("notify.persist")
	last := evs[len(evs)-1].Payload.(agentops.NotifyPersistPayload)
	if last.Level != "info" {
		t.Fatalf("default level expect info, got %q", last.Level)
	}
}

// TestOpsNotify_NotifyPersistPersists 服务端入账：与系统通知同库（category=task、
// type=level、动作透传），通知中心/webhook 链由 store.Add 出站口驱动
func TestOpsNotify_NotifyPersistPersists(t *testing.T) {
	r := setupPersistTest(t)

	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"notify.persist","payload":{"title":"任务收尾","body":"结论摘要","level":"error","action":"terminal","actionPayload":"tm-42"}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	list := persistedNotifications(t)
	if len(list) != 1 {
		t.Fatalf("expect 1 persisted notification, got %d", len(list))
	}
	n := list[0]
	if n.Category != notification.CategoryTask {
		t.Fatalf("category expect task, got %q", n.Category)
	}
	if n.Type != "error" {
		t.Fatalf("type expect error (level passthrough), got %q", n.Type)
	}
	if n.Title != "任务收尾" || n.Body != "结论摘要" {
		t.Fatalf("title/body expect passthrough, got %q / %q", n.Title, n.Body)
	}
	if n.Action != "terminal" || n.ActionPayload != "tm-42" {
		t.Fatalf("action expect passthrough, got %q / %q", n.Action, n.ActionPayload)
	}

	// 类别静音（任务子开关关）：不入账也不广播实时弹面，响应仍 200 静默
	prefs := store.Get().Notification.GetPrefs()
	prefs.Enabled[notification.CategoryTask] = false
	if err := store.Get().Notification.SavePrefs(prefs); err != nil {
		t.Fatalf("save prefs: %v", err)
	}
	before := len(persistedNotifications(t))
	rec := recordEvents(t)
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"notify.persist","payload":{"title":"muted"}}`); w.Code != http.StatusOK {
		t.Fatalf("muted persist expect silent 200, got %d", w.Code)
	}
	if got := len(persistedNotifications(t)); got != before {
		t.Fatalf("muted persist must not file, before=%d after=%d", before, got)
	}
	if got := len(rec.of("notify.persist")); got != 0 {
		t.Fatalf("muted persist must not broadcast, got %d", got)
	}
}

// TestOpsNotify_NotifyPersist_RateLimitShared 入账与广播同预算：notify.persist
// 与其他事件共享 ops-notify 60 条/分钟维度限流，超限静默丢弃不入账
func TestOpsNotify_NotifyPersist_RateLimitShared(t *testing.T) {
	r := setupPersistTest(t)

	body := `{"type":"notify.persist","payload":{"title":"rl"}}`
	for i := 0; i < opsNotifyRateLimit; i++ {
		if w := doJSON(r, http.MethodPost, "/api/ops-notify", body); w.Code != http.StatusOK {
			t.Fatalf("in-budget #%d expect 200, got %d", i, w.Code)
		}
	}
	// 第 61 条：静默 200 但不入账（入账与广播面同预算，风暴打不穿通知中心）
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", body); w.Code != http.StatusOK {
		t.Fatalf("over-limit expect silent 200, got %d", w.Code)
	}
	if got := len(persistedNotifications(t)); got != opsNotifyRateLimit {
		t.Fatalf("persisted = %d, want %d (over-limit dropped)", got, opsNotifyRateLimit)
	}
}

// TestOpsNotify_NotifyPersistDoesNotAffectOtherTypes 校验仅作用于 notify.persist：
// 相似名自定义事件不受新分支影响，载荷原样透传（开放词表零变化）
func TestOpsNotify_NotifyPersistDoesNotAffectOtherTypes(t *testing.T) {
	r := setupPersistTest(t)

	var seenPayload interface{}
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "notify.persists" {
			seenPayload = ev.Payload
		}
	})
	defer unsub()

	w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"notify.persists","payload":{"title":""}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("similar type expect 200 (no validation), got %d", w.Code)
	}
	m, ok := seenPayload.(map[string]interface{})
	if !ok || m["title"] != "" {
		t.Fatalf("similar type payload should pass through untouched, got %#v", seenPayload)
	}
}

// 广播 json 形态核对：缺省 body/action 不携带空键（omitempty 语义，前端
// detail 无多余键）
func TestOpsNotify_NotifyPersistBroadcastJSON(t *testing.T) {
	r := setupPersistTest(t)

	var raw json.RawMessage
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type != "notify.persist" {
			return
		}
		if b, err := json.Marshal(ev.Payload); err == nil {
			raw = b
		}
	})
	defer unsub()

	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"notify.persist","payload":{"title":"bare"}}`); w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	out := string(raw)
	if strings.Contains(out, `"body"`) || strings.Contains(out, `"action"`) {
		t.Fatalf("broadcast json expect no empty body/action keys, got %s", out)
	}
	if !strings.Contains(out, `"title":"bare"`) || !strings.Contains(out, `"level":"info"`) {
		t.Fatalf("broadcast json expect title/level, got %s", out)
	}
}
