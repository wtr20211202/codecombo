package system

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 联邦活动热力（P-20261004-98）──
// 覆盖：聚合（本机直读 + 对端拉取）、失败隔离（死对端行不可达不影响他行）、
// 404 降级（旧对端行标 unsupported）、TTL 缓存（窗口内重复调用零对端扇出）、
// days 参数透传与钳制、本机行兜底合成（本地条目未落库时恒在）。

// matrixPeer 模拟对端实例：记录 activity 拉取次数与最后一次 days query
type matrixPeer struct {
	gotDays  atomic.Value
	hits     atomic.Int64
	behavior string // ok / old（activity 端点 404）
}

func (p *matrixPeer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/reports/activity" {
			p.hits.Add(1)
			p.gotDays.Store(r.URL.Query().Get("days"))
			if p.behavior == "old" {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"404 page not found"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			// 两天序列（date 升序），形状与 server/api/report.ListActivity 同 envelope
			_, _ = fmt.Fprintf(w, `{"data":[{"date":"2026-10-17","commits":2,"sessions":1,"commands":3},{"date":"2026-10-18","commits":4,"sessions":2,"commands":5}]}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not the endpoint the matrix hits"))
	})
}

// matrixRouter 装配 store + SC_DATA_DIR + 矩阵路由的最小引擎（fleet_test 同款）
func matrixRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })
	invalidateActivityMatrixCache()
	t.Cleanup(invalidateActivityMatrixCache)

	r := gin.New()
	r.GET("/api/instances/activity-matrix", InstanceActivityMatrix)
	return r
}

// registerMatrixPeer 注册一条远程实例配置（dispatch_test 同款），返回实例 id
func registerMatrixPeer(t *testing.T, name, url, token string) string {
	t.Helper()
	inst := store.Get().Instance.NewRemote(name, url, token)
	if err := store.Get().Instance.Save(inst); err != nil {
		t.Fatal(err)
	}
	return inst.ID
}

type matrixResp struct {
	Data struct {
		Days int                 `json:"days"`
		Rows []activityMatrixRow `json:"rows"`
	} `json:"data"`
}

func matrixGet(t *testing.T, r *gin.Engine, query string) matrixResp {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/instances/activity-matrix"+query, nil))
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var resp matrixResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not matrix envelope: %v body=%s", err, w.Body.String())
	}
	return resp
}

// seedLocalActivity 给本地仓储落两天序列（本机行数据源）
func seedLocalActivity(t *testing.T) {
	t.Helper()
	today := time.Now().Format("2006-01-02")
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	for _, d := range []store.ActivityDay{
		{Date: yesterday, Commits: 1, Sessions: 1, Commands: 2},
		{Date: today, Commits: 3, Sessions: 2, Commands: 4},
	} {
		if err := store.Get().ActivityDay.Save(d); err != nil {
			t.Fatal(err)
		}
	}
}

func TestActivityMatrix_AggregationAndIsolation(t *testing.T) {
	r := matrixRouter(t)
	seedLocalActivity(t)

	okPeer := &matrixPeer{behavior: "ok"}
	okSrv := httptest.NewServer(okPeer.handler())
	t.Cleanup(okSrv.Close)
	oldPeer := &matrixPeer{behavior: "old"}
	oldSrv := httptest.NewServer(oldPeer.handler())
	t.Cleanup(oldSrv.Close)

	registerMatrixPeer(t, "e2e-ok", okSrv.URL, "sc_token_ok")
	registerMatrixPeer(t, "e2e-old", oldSrv.URL, "")
	// 死对端：连接拒绝即时失败（无须等超时）
	dead := closedPort(t)
	registerMatrixPeer(t, "e2e-dead", "http://127.0.0.1:"+fmt.Sprint(dead), "")

	resp := matrixGet(t, r, "")
	if resp.Data.Days != activityMatrixDaysDefault {
		t.Fatalf("default days should be %d, got %d", activityMatrixDaysDefault, resp.Data.Days)
	}
	// 本机行恒排最前 + 三对端行失败隔离齐全
	rows := resp.Data.Rows
	if len(rows) != 4 {
		t.Fatalf("expected 4 rows (self + 3 peers), got %d: %+v", len(rows), rows)
	}
	self := rows[0]
	if !self.Self || self.Status != matrixStatusOK {
		t.Fatalf("first row should be self ok, got %+v", self)
	}
	// 本机行兜底合成：本地条目未落库时 instanceId 恒为 local、命名与 GetLocal 同源
	if self.InstanceID != "local" || self.Name != "本机" {
		t.Fatalf("synthesized self row should be local/本机, got %+v", self)
	}
	if len(self.Series) != 2 || self.Totals.Commits != 4 || self.Totals.Sessions != 3 || self.Totals.Commands != 6 {
		t.Fatalf("self row should aggregate 2 seeded days, got %+v", self)
	}

	var okRow, oldRow, deadRow *activityMatrixRow
	for i := range rows {
		switch rows[i].Name {
		case "e2e-ok":
			okRow = &rows[i]
		case "e2e-old":
			oldRow = &rows[i]
		case "e2e-dead":
			deadRow = &rows[i]
		}
	}
	if okRow == nil || oldRow == nil || deadRow == nil {
		t.Fatalf("peer rows missing: %+v", rows)
	}
	if okRow.Status != matrixStatusOK || len(okRow.Series) != 2 || okRow.Series[0].Date != "2026-10-17" {
		t.Fatalf("ok peer row should carry series, got %+v", okRow)
	}
	if okRow.Totals.Commits != 6 || okRow.Totals.Sessions != 3 || okRow.Totals.Commands != 8 {
		t.Fatalf("ok peer totals wrong: %+v", okRow.Totals)
	}
	if oldRow.Status != matrixStatusUnsupported || oldRow.Series != nil {
		t.Fatalf("old peer should be unsupported without series, got %+v", oldRow)
	}
	if deadRow.Status != matrixStatusUnreachable || deadRow.Series != nil {
		t.Fatalf("dead peer should be unreachable without series, got %+v", deadRow)
	}
	// 拉取形态：Bearer 令牌透传 + days query 缺省 14
	if okPeer.gotDays.Load() != "14" {
		t.Fatalf("ok peer should receive days=14, got %v", okPeer.gotDays.Load())
	}
}

func TestActivityMatrix_BearerTokenSent(t *testing.T) {
	r := matrixRouter(t)
	var gotAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth.Store(req.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(srv.Close)
	registerMatrixPeer(t, "e2e-tokened", srv.URL, "sc_matrix_secret")

	resp := matrixGet(t, r, "?days=7")
	if resp.Data.Days != 7 {
		t.Fatalf("days param should pass through, got %d", resp.Data.Days)
	}
	if resp.Data.Rows[1].Status != matrixStatusOK {
		t.Fatalf("peer row should be ok, got %+v", resp.Data.Rows[1])
	}
	if gotAuth.Load() != "Bearer sc_matrix_secret" {
		t.Fatalf("peer should receive bearer token, got %v", gotAuth.Load())
	}
	// 空序列（新装对端常态）：totals 全零即口径正确；series 键允许缺席
	//（omitempty 下空切片不占响应体，消费者按缺省空序列读）
	if resp.Data.Rows[1].Totals != (activityTotals{}) {
		t.Fatalf("empty series should yield zero totals, got %+v", resp.Data.Rows[1].Totals)
	}
}

func TestActivityMatrix_MalformedPeerEnvelope(t *testing.T) {
	r := matrixRouter(t)
	// 2xx 但不是本应用 envelope（反代/SPA fallback/JSON 错误体）：必须按
	// unreachable 隔离，不能误读成「该实例零活动」的 ok 空序列
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"maintenance in progress"}`))
	}))
	t.Cleanup(srv.Close)
	registerMatrixPeer(t, "e2e-garbage", srv.URL, "")

	resp := matrixGet(t, r, "")
	if len(resp.Data.Rows) != 2 {
		t.Fatalf("expected self + one peer row, got %+v", resp.Data.Rows)
	}
	if row := resp.Data.Rows[1]; row.Status != matrixStatusUnreachable || row.Series != nil {
		t.Fatalf("non-envelope 2xx should be unreachable without series, got %+v", row)
	}
}

func TestActivityMatrix_CachedWithinTTL(t *testing.T) {
	r := matrixRouter(t)
	peer := &matrixPeer{behavior: "ok"}
	srv := httptest.NewServer(peer.handler())
	t.Cleanup(srv.Close)
	registerMatrixPeer(t, "e2e-cached", srv.URL, "")

	matrixGet(t, r, "")
	first := peer.hits.Load()
	if first != 1 {
		t.Fatalf("first call should hit peer once, got %d", first)
	}
	matrixGet(t, r, "")
	if peer.hits.Load() != first {
		t.Fatalf("second call within TTL should be served from cache, hits=%d", peer.hits.Load())
	}
	// days 口径变化即换窗：不同 days 不复用旧快照
	matrixGet(t, r, "?days=30")
	if peer.hits.Load() != first+1 {
		t.Fatalf("different days must recompute, hits=%d", peer.hits.Load())
	}
}

func TestActivityMatrix_LocalEntryPresent(t *testing.T) {
	r := matrixRouter(t)
	seedLocalActivity(t)
	// 本地条目已落库（用户触碰过更新链的形态）：self 行沿用条目 id 与命名
	if err := store.Get().Instance.Save(config.InstanceConfig{
		ID: "local", Name: "开发机", IsLocal: true,
		CreatedAt: time.Now().Format(time.RFC3339), UpdatedAt: time.Now().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}

	resp := matrixGet(t, r, "")
	self := resp.Data.Rows[0]
	if !self.Self || self.InstanceID != "local" || self.Name != "开发机" {
		t.Fatalf("self row should use stored local entry, got %+v", self)
	}
	if self.Status != matrixStatusOK || len(self.Series) != 2 {
		t.Fatalf("self row should carry local series, got %+v", self)
	}
}

func TestActivityMatrix_ClampedDays(t *testing.T) {
	r := matrixRouter(t)
	// 超保留窗口钳到 365（与 ActivityDay.List 同口径，不透传超窗值给对端）
	resp := matrixGet(t, r, "?days=9999")
	if resp.Data.Days != activityMatrixDaysMax {
		t.Fatalf("days above retention should clamp to %d, got %d", activityMatrixDaysMax, resp.Data.Days)
	}
	// 非正数/非法值回落缺省（不透传 0/负数给对端）
	for _, q := range []string{"?days=0", "?days=-3", "?days=abc"} {
		resp = matrixGet(t, r, q)
		if resp.Data.Days != activityMatrixDaysDefault {
			t.Fatalf("%s should fall back to default, got %d", q, resp.Data.Days)
		}
	}
}
