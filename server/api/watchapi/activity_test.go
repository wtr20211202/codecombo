package watchapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/kernel"
)

// resetActivity 环与退订函数复位（测试间互不渗透；dropped 累计不可复位，
// 断言一律取差值）
func resetActivity(t *testing.T) {
	t.Helper()
	if activityUnsub != nil {
		activityUnsub()
		activityUnsub = nil
	}
	activity = &activityRing{buf: make([]activityEntry, activityRingCap)}
	t.Cleanup(func() {
		if activityUnsub != nil {
			activityUnsub()
			activityUnsub = nil
		}
	})
}

// TestRingAddSnapshotOrder 顺序入环 → 快照自新向旧；容量内全量返回
func TestRingAddSnapshotOrder(t *testing.T) {
	resetActivity(t)
	for i := 0; i < 5; i++ {
		activity.add(activityEntry{TS: int64(1000 + i), ProjectID: "p", Path: "f.go"})
	}
	got, _ := activity.snapshot(0, 10)
	if len(got) != 5 || got[0].TS != 1004 || got[4].TS != 1000 {
		t.Fatalf("snapshot order wrong: %+v", got)
	}
}

// TestRingEvictDropsOldest 容量封顶最旧逐出 + dropped 递增（差值口径）
func TestRingEvictDropsOldest(t *testing.T) {
	resetActivity(t)
	_, dropped0 := activity.snapshot(0, activityMaxLimit)
	for i := 0; i < activityRingCap+7; i++ {
		activity.add(activityEntry{TS: int64(i), ProjectID: "p", Path: "f.go"})
	}
	got, dropped1 := activity.snapshot(0, activityMaxLimit)
	if len(got) != activityRingCap {
		t.Fatalf("len = %d, want cap %d", len(got), activityRingCap)
	}
	if got[0].TS != activityRingCap+6 { // 最新一条在
		t.Fatalf("newest missing: %d", got[0].TS)
	}
	if got[activityRingCap-1].TS != 7 { // 最旧 7 条（0..6）被逐出
		t.Fatalf("oldest kept wrong: %d", got[activityRingCap-1].TS)
	}
	if dropped1-dropped0 != 7 {
		t.Fatalf("dropped delta = %d, want 7", dropped1-dropped0)
	}
}

// TestSnapshotSinceLimit 增量（since 过滤）与 limit 截断
func TestSnapshotSinceLimit(t *testing.T) {
	resetActivity(t)
	for i := 0; i < 10; i++ {
		activity.add(activityEntry{TS: int64(i), ProjectID: "p", Path: "f.go"})
	}
	got, _ := activity.snapshot(5, activityMaxLimit)
	if len(got) != 4 || got[0].TS != 9 || got[3].TS != 6 {
		t.Fatalf("since filter wrong: %+v", got)
	}
	got, _ = activity.snapshot(0, 2)
	if len(got) != 2 || got[0].TS != 9 {
		t.Fatalf("limit wrong: %+v", got)
	}
}

// publishFileChanged 走真实总线发布（含 Publish 侧 TS 零值补齐路径）
func publishFileChanged(t *testing.T, projectID string, payload any) {
	t.Helper()
	k := kernel.New(slog.Default())
	WireActivityRecorder(k)
	k.Events().Publish(kernel.Envelope{Topic: "file.changed", ProjectID: projectID, Payload: payload})
}

// callActivity 直调 handler（路由挂载面由 router 对账测试守卫，此处锁契约）
func callActivity(t *testing.T, query string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/watch/activity"+query, nil)
	GetActivity(c)
	return w
}

// TestWireRecorderEndToEnd 总线 file.changed → 环 → handler JSON 契约。
// 载荷形态三源：watcher 广播的真实形态 map[string]string{"path":...}、
// map[string]any、字符串 JSON（降级轮询演化兼容）；坏载荷一律丢弃
func TestWireRecorderEndToEnd(t *testing.T) {
	resetActivity(t)
	publishFileChanged(t, "proj-a", map[string]string{"path": "D:/ws/a/main.go"})
	publishFileChanged(t, "proj-b", map[string]any{"path": "D:/ws/b/index.ts"})
	publishFileChanged(t, "proj-c", `{"path":"D:/ws/c/x.go"}`)
	publishFileChanged(t, "proj-d", map[string]string{}) // 空 path 丢弃
	publishFileChanged(t, "proj-e", "not-json")          // 坏串丢弃
	publishFileChanged(t, "proj-f", 42)                  // 无法解码丢弃

	got, _ := activity.snapshot(0, activityMaxLimit)
	if len(got) != 3 {
		t.Fatalf("entries = %d, want 3 (malformed payloads must be dropped)", len(got))
	}
	if got[0].ProjectID != "proj-c" || got[2].ProjectID != "proj-a" {
		t.Fatalf("order/attribution wrong: %+v", got)
	}

	// handler 响应契约：data.events / data.dropped，字段名冻结（前端镜像）
	w := callActivity(t, "?limit=2")
	var body struct {
		Data struct {
			Events  []activityEntry `json:"events"`
			Dropped int64           `json:"dropped"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if len(body.Data.Events) != 2 || body.Data.Events[0].ProjectID != "proj-c" {
		t.Fatalf("handler events wrong: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"projectId"`) || !strings.Contains(w.Body.String(), `"path"`) {
		t.Fatalf("wire field name drifted: %s", w.Body.String())
	}
}

// TestGetActivity_Idle 零事件：200 空集（读宽容，未接线同形态）
func TestGetActivity_Idle(t *testing.T) {
	resetActivity(t)
	w := callActivity(t, "")
	if !strings.Contains(w.Body.String(), `"events":[]`) {
		t.Fatalf("idle body = %s, want empty events", w.Body.String())
	}
}

// TestGetActivity_BadQuery 非法 limit/since 宽容回缺省（不 4xx——观测面）
func TestGetActivity_BadQuery(t *testing.T) {
	resetActivity(t)
	publishFileChanged(t, "p", map[string]string{"path": "x.go"})
	for _, q := range []string{"?limit=abc", "?limit=-5", "?limit=999999", "?since=xyz"} {
		w := callActivity(t, q)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"path":"x.go"`) {
			t.Fatalf("query %s resp = %d %s", q, w.Code, w.Body.String())
		}
	}
}
