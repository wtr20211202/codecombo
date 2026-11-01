package report

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/store"
)

// TestListActivityPort 活动序列口（P-20261003-37）：date 升序、days 截断取
// 最新段、缺省全量；空库返回空列表非错误
func TestListActivityPort(t *testing.T) {
	r := setupReportTest(t)
	s := store.Get()
	for _, d := range []struct {
		date          string
		commits, cmds int
	}{{"2026-09-28", 1, 2}, {"2026-10-01", 3, 4}, {"2026-10-02", 5, 6}} {
		if err := s.ActivityDay.Save(store.ActivityDay{
			Date: d.date, Commits: d.commits, Commands: d.cmds, Sessions: 1,
		}); err != nil {
			t.Fatalf("seed %s: %v", d.date, err)
		}
	}

	// 缺省：升序全量
	req := httptest.NewRequest(http.MethodGet, "/api/reports/activity", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var res struct {
		Data []store.ActivityDay `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Data) != 3 || res.Data[0].Date != "2026-09-28" || res.Data[2].Date != "2026-10-02" {
		t.Fatalf("list = %+v, want 3 行升序", res.Data)
	}
	if res.Data[2].Commits != 5 || res.Data[2].Sessions != 1 || res.Data[2].Commands != 6 {
		t.Fatalf("row = %+v, want 5/1/6", res.Data[2])
	}

	// days 截断取最新段（升序尾部）
	req = httptest.NewRequest(http.MethodGet, "/api/reports/activity?days=2", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	res.Data = nil
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Data) != 2 || res.Data[0].Date != "2026-10-01" || res.Data[1].Date != "2026-10-02" {
		t.Fatalf("days=2 → %+v, want 最新两行", res.Data)
	}

	// 空库：200 + 空列表（新装实例常态）
	req = httptest.NewRequest(http.MethodGet, "/api/reports/activity", nil)
	w = httptest.NewRecorder()
	setupReportTest(t).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("empty status = %d", w.Code)
	}
	res.Data = nil
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || len(res.Data) != 0 {
		t.Fatalf("empty list = %+v, %v; want 空+nil", res.Data, err)
	}
}
