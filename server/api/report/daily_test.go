package report

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

// setupReportTest 独立 filestore + 全局 Store 装配 + 裸 gin（只挂被测路由，
// 不污染全局状态）
func setupReportTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	g := r.Group("/api/reports")
	g.GET("/daily", ListDailyReports)
	g.GET("/daily/:date", DailyReportDetail)
	g.POST("/daily/run", RunDailyReport)
	g.GET("/activity", ListActivity)
	return r
}

// seedArchive 经仓储直落一份存档（端口读路径的播种面）
func seedArchive(t *testing.T, date, projectID string, commits int) {
	t.Helper()
	if err := store.Get().DailyReport.Save(store.DailyReport{
		ProjectID: projectID, ProjectName: "p-" + projectID, Date: date, Commits: commits,
	}); err != nil {
		t.Fatalf("seed archive: %v", err)
	}
}

// TestListDailyReportsPort 列表口：倒序返回 + limit 透传；空库返回空列表非错误
func TestListDailyReportsPort(t *testing.T) {
	r := setupReportTest(t)
	seedArchive(t, "2026-09-30", "pb", 1)
	seedArchive(t, "2026-10-02", "pa", 2)

	req := httptest.NewRequest(http.MethodGet, "/api/reports/daily", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var res struct {
		Data []store.DailyReport `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Data) != 2 || res.Data[0].Date != "2026-10-02" || res.Data[1].Date != "2026-09-30" {
		t.Fatalf("list = %+v, want 倒序两条", res.Data)
	}

	// limit 透传
	req = httptest.NewRequest(http.MethodGet, "/api/reports/daily?limit=1", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	res.Data = nil
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || len(res.Data) != 1 {
		t.Fatalf("limit=1 → %v, %v; want 1 条", res.Data, err)
	}
}

// TestDailyReportDetailPort 单日详情口：该日全部项目；畸形日期 400；无档日
// 200 空列表（回看空日是常态）
func TestDailyReportDetailPort(t *testing.T) {
	r := setupReportTest(t)
	seedArchive(t, "2026-10-02", "pa", 2)
	seedArchive(t, "2026-10-02", "pb", 3)

	req := httptest.NewRequest(http.MethodGet, "/api/reports/daily/2026-10-02", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var res struct {
		Data []store.DailyReport `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Data) != 2 || res.Data[0].ProjectID != "pa" || res.Data[1].ProjectID != "pb" {
		t.Fatalf("detail = %+v, want 该日两条按项目升序", res.Data)
	}

	// 无档日：200 + 空列表
	req = httptest.NewRequest(http.MethodGet, "/api/reports/daily/2026-09-01", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("empty day status = %d, want 200", w.Code)
	}

	// 畸形日期：400
	req = httptest.NewRequest(http.MethodGet, "/api/reports/daily/not-a-date", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus date status = %d, want 400", w.Code)
	}
}

// TestRunDailyReportPort 触发口：畸形日期 400；合法日期 200 并回报日期。
// 聚合/落档语义在 report 包单测锁定（此处无项目种子，sent=0 即无副作用验证）
func TestRunDailyReportPort(t *testing.T) {
	r := setupReportTest(t)

	// 畸形日期 400
	req := httptest.NewRequest(http.MethodPost, "/api/reports/daily/run",
		strings.NewReader(`{"date":"2026/10/02"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus date status = %d, want 400", w.Code)
	}

	// 合法历史日（空库 → sent 0，不报错）
	req = httptest.NewRequest(http.MethodPost, "/api/reports/daily/run",
		strings.NewReader(`{"date":"2026-09-20"}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("run status = %d, body %s", w.Code, w.Body.String())
	}
	var res struct {
		Sent int    `json:"sent"`
		Date string `json:"date"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Sent != 0 || res.Date != time.Now().Format("2006-01-02") {
		t.Fatalf("run res = %+v, want sent 0 + 今日日期", res)
	}

	// 空请求体 = 今天，同样可用
	req = httptest.NewRequest(http.MethodPost, "/api/reports/daily/run", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("empty body run status = %d", w.Code)
	}
}
