package middleware

import (
	"context"
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

// 审计中央收口（P-20261006-53）：helper 从 gin context 注入请求关联 ID 到
// Rid 结构化字段；无 RequestID 中间件（裸测试 context）时空串零值；与裸
// Append 双口并存——后台路径直接 store.Get().Audit.Append 不经本口。

// setupAuditStore 独立临时数据面 + store（auditarchive_test 同款隔离惯例）
func setupAuditStore(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// auditEvents 读回全部审计条目（测试辅助）
func auditEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	return events
}

// 有 RequestID 中间件在前的请求：helper 注入 rid，且与响应头/上下文同值
// （与访问日志 rid= 同源对齐的契约面）
func TestAuditAppend_InjectsRequestID(t *testing.T) {
	setupAuditStore(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID())
	var seenRid string
	r.GET("/do", func(c *gin.Context) {
		AuditAppend(c, store.AuditEvent{Action: "t.action", Result: store.AuditResultSuccess})
		seenRid = RequestIDFromGin(c)
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/do", nil))

	events := auditEvents(t)
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Rid == "" || events[0].Rid != seenRid {
		t.Fatalf("event rid = %q, want context rid %q", events[0].Rid, seenRid)
	}
	if !hexIDRe.MatchString(events[0].Rid) {
		t.Fatalf("rid = %q, want 16 hex short code", events[0].Rid)
	}
}

// 裸测试 context（无 RequestID 中间件）：helper 容忍 rid 缺席，Rid 零值且
// JSON 序列化省略该键（omitempty）——存量消费者与旧记录零感知
func TestAuditAppend_ToleratesMissingRequestID(t *testing.T) {
	setupAuditStore(t)
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	AuditAppend(c, store.AuditEvent{Action: "t.action", Result: store.AuditResultSuccess})

	events := auditEvents(t)
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Rid != "" {
		t.Fatalf("rid = %q, want empty without RequestID middleware", events[0].Rid)
	}
	raw, err := json.Marshal(events[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), `"rid"`) {
		t.Fatalf("json = %s, want no rid key when empty", raw)
	}
}

// 双口并存：后台路径（无 gin context）直接裸 Append，Rid 留零值——与 helper
// 写入的条目在同一台账共存，各自适用面互不干扰
func TestAuditAppend_BareAppendCoexists(t *testing.T) {
	setupAuditStore(t)

	store.Get().Audit.Append(store.AuditEvent{
		Action: store.AuditLogPrune, Result: store.AuditResultSuccess,
		Detail: "pruned=1 max=2", // 后台巡更条目：无 IP 无 rid（audit.prune 同形态）
	})
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil).
		WithContext(context.WithValue(context.Background(), ctxKeyRequestID{}, "ab12cd34ab12cd34"))
	// 直读上下文键的请求（模拟 gin 中间件已写入的形态）也应被 helper 取到：
	// RequestIDFromGin 读 gin context，这里走 Set 同款路径
	c.Set(GinKeyRequestID, "ab12cd34ab12cd34")
	AuditAppend(c, store.AuditEvent{Action: "t.action", Result: store.AuditResultSuccess})

	events := auditEvents(t)
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
	if events[0].Action != "t.action" || events[0].Rid != "ab12cd34ab12cd34" {
		t.Fatalf("helper entry = %+v, want rid injected", events[0])
	}
	if events[1].Action != store.AuditLogPrune || events[1].Rid != "" {
		t.Fatalf("bare entry = %+v, want empty rid", events[1])
	}
}

// 升级兼容（零迁移承诺）：无 rid 键的存量记录 JSON 反序列化回 AuditEvent，
// Rid 零值、其余字段不丢——旧数据面 + 新二进制形态
func TestAuditEvent_OldRecordWithoutRidUnmarshals(t *testing.T) {
	old := `{"id":"x","time":"2026-01-02T03:04:05Z","action":"lock.unlock","result":"failure","ip":"1.2.3.4","detail":"wrong password"}`
	var e store.AuditEvent
	if err := json.Unmarshal([]byte(old), &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if e.Rid != "" || e.Action != "lock.unlock" || e.IP != "1.2.3.4" || e.Detail != "wrong password" {
		t.Fatalf("round trip = %+v", e)
	}
	if e.Time.Equal(time.Time{}) {
		t.Fatal("time lost in round trip")
	}
}
