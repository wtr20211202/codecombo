package system

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/metrics"
	"codecombo/server/store"
)

// ── 实例健康摘要（P-20261003-28） ──
// 覆盖：响应形状（四项齐备、非负正值语义）、wsClients 取 metrics 注册值聚合
// （跨 endpoint 序列求和）、进程采样面合理性（uptime ≥ 0 / heap > 0 / goroutine ≥ 1）；
// P-20261003-205 起含审计写失败计数两字段（成功面恒 0/空串，注入失败后如实反映）

func healthRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/system/health", InstanceHealth)
	return r
}

// failCreateDoc 仅 Create 恒败的 DocumentStore 假件（内嵌真实 filestore 兜底
// 读路径）——模拟数据目录不可写，驱动审计 Append 失败计数
type failCreateDoc struct {
	store.DocumentStore
}

func (f failCreateDoc) Create(kind, key string, data []byte) error {
	return errors.New("disk full (injected)")
}

// seedAuditStore 装配只含 Audit 仓储的全局 Store（InstanceHealth 只读 Audit
// 面），测试结束还原
func seedAuditStore(t *testing.T, doc store.DocumentStore) {
	t.Helper()
	store.SetDefault(&store.Store{Audit: store.NewAuditLogRepo(doc)})
	t.Cleanup(func() { store.SetDefault(nil) })
}

func TestInstanceHealth_Shape(t *testing.T) {
	seedAuditStore(t, filestore.New(t.TempDir()))
	w := httptest.NewRecorder()
	healthRouter().ServeHTTP(w, httptest.NewRequest("GET", "/api/system/health", nil))
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var data map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatalf("response not json: %v body=%s", err, w.Body.String())
	}
	for _, key := range []string{"uptime", "heapAlloc", "goroutines", "wsClients"} {
		v, ok := data[key].(float64)
		if !ok {
			t.Errorf("missing/invalid %q in %v", key, data)
			continue
		}
		if v < 0 {
			t.Errorf("%q must be >= 0, got %v", key, v)
		}
	}
	if v, ok := data["goroutines"].(float64); !ok || v < 1 {
		t.Errorf("running process must report >= 1 goroutine, got %v", data["goroutines"])
	}
	if v, ok := data["heapAlloc"].(float64); !ok || v <= 0 {
		t.Errorf("live heap must be > 0, got %v", data["heapAlloc"])
	}
	// 审计写失败计数（P-20261003-205）：健康实例恒 0 失败 / 从未失败空串
	if v, ok := data["auditWriteFails"].(float64); !ok || v != 0 {
		t.Errorf("healthy instance must report auditWriteFails=0, got %v (%v)", data["auditWriteFails"], ok)
	}
	if v, ok := data["auditLastWriteFail"].(string); !ok || v != "" {
		t.Errorf("healthy instance must report empty auditLastWriteFail, got %q (%v)", data["auditLastWriteFail"], ok)
	}
}

func TestInstanceHealth_WsClientsAggregatesRegistry(t *testing.T) {
	metrics.ResetForTesting()
	defer metrics.ResetForTesting()
	// 模拟两个 WS 端点各持连接（与 notification/ws.go、opschannel 同款记账）
	metrics.AddGauge("sc_ws_connections", 2, "endpoint", "notifications")
	metrics.AddGauge("sc_ws_connections", 3, "endpoint", "ops-channel")
	// 其他名字的 gauge 不得计入
	metrics.SetGauge("sc_http_inflight", 7)

	snap := metrics.Snapshot()
	if snap.WSClients != 5 {
		t.Errorf("wsClients should sum sc_ws_connections series across endpoints, want 5 got %d", snap.WSClients)
	}
	if snap.UptimeSeconds < 0 || snap.HeapAllocBytes <= 0 || snap.Goroutines < 1 {
		t.Errorf("unexpected process sampling: %+v", snap)
	}
}

// TestInstanceHealth_AuditWriteFails 审计写失败计数透传（P-20261003-205）：
// 注入 Create 恒败的仓储后，健康摘要如实反映累计条数与最近失败时刻
// （RFC3339 文本、落在测试窗口内）——审计链断裂在健康面可见
func TestInstanceHealth_AuditWriteFails(t *testing.T) {
	seedAuditStore(t, failCreateDoc{DocumentStore: filestore.New(t.TempDir())})
	audit := store.Get().Audit

	before := time.Now().Add(-time.Second)
	audit.Append(store.AuditEvent{Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	audit.Append(store.AuditEvent{Action: store.AuditTokenCreate, Result: store.AuditResultSuccess})

	w := httptest.NewRecorder()
	healthRouter().ServeHTTP(w, httptest.NewRequest("GET", "/api/system/health", nil))
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var data struct {
		AuditWriteFails    int64  `json:"auditWriteFails"`
		AuditLastWriteFail string `json:"auditLastWriteFail"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatalf("response not json: %v body=%s", err, w.Body.String())
	}
	if data.AuditWriteFails != 2 {
		t.Errorf("expected auditWriteFails=2, got %d", data.AuditWriteFails)
	}
	last, err := time.Parse(time.RFC3339, data.AuditLastWriteFail)
	if err != nil {
		t.Fatalf("auditLastWriteFail not RFC3339: %q err=%v", data.AuditLastWriteFail, err)
	}
	if last.Before(before) || last.After(time.Now()) {
		t.Errorf("last failure %v outside test window [%v, now]", last, before)
	}
}
