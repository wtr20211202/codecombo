package system

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/kernel"
)

// ── Scheduler 后台任务清单（P-20261003-276） ──
// 覆盖：响应形状（data 数组、name/intervalMs/lastRun 三字段、任务名升序）、
// 未到点 lastRun 空串哨兵、调度器引用未注入（模块 Init 前的窗口）返回空清单
// 而非 null/5xx、lastRun 触发后盖章为窗口内 RFC3339

func schedulerRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/system/scheduler", SchedulerJobs)
	return r
}

type schedulerJobWire struct {
	Name     string `json:"name"`
	Interval int64  `json:"intervalMs"`
	LastRun  string `json:"lastRun"`
}

func getSchedulerJobs(t *testing.T) []schedulerJobWire {
	t.Helper()
	w := httptest.NewRecorder()
	schedulerRouter().ServeHTTP(w, httptest.NewRequest("GET", "/api/system/scheduler", nil))
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data []schedulerJobWire `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not json: %v body=%s", err, w.Body.String())
	}
	return body.Data
}

func TestSchedulerJobs_Shape(t *testing.T) {
	s := kernel.NewScheduler(nil)
	defer s.Stop()
	SetSchedulerSource(s)
	t.Cleanup(func() { SetSchedulerSource(nil) })

	if !s.AddTicker("zz-cleanup", 24*time.Hour, func(context.Context) {}) {
		t.Fatal("AddTicker zz-cleanup should succeed")
	}
	if !s.AddTicker("aa-watch", 30*time.Second, func(context.Context) {}) {
		t.Fatal("AddTicker aa-watch should succeed")
	}

	jobs := getSchedulerJobs(t)
	if len(jobs) != 2 {
		t.Fatalf("jobs len = %d, want 2", len(jobs))
	}
	if jobs[0].Name != "aa-watch" || jobs[1].Name != "zz-cleanup" {
		t.Fatalf("jobs not sorted by name: %q, %q", jobs[0].Name, jobs[1].Name)
	}
	if jobs[0].Interval != 30_000 {
		t.Errorf("aa-watch intervalMs = %d, want 30000", jobs[0].Interval)
	}
	// 未到点：lastRun 空串（零值哨兵，前端「未运行」判据）
	for _, j := range jobs {
		if j.LastRun != "" {
			t.Errorf("job %q lastRun = %q before first tick, want empty", j.Name, j.LastRun)
		}
	}
}

// TestSchedulerJobs_LastRunRFC3339 到点执行后 lastRun 为窗口内 RFC3339 文本
func TestSchedulerJobs_LastRunRFC3339(t *testing.T) {
	s := kernel.NewScheduler(nil)
	defer s.Stop()
	SetSchedulerSource(s)
	t.Cleanup(func() { SetSchedulerSource(nil) })

	ran := make(chan struct{}, 1)
	if !s.AddTicker("fast-probe", 5*time.Millisecond, func(context.Context) {
		select {
		case ran <- struct{}{}:
		default:
		}
	}) {
		t.Fatal("AddTicker should succeed")
	}
	before := time.Now().Add(-time.Second)
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("fast-probe never ran")
	}

	jobs := getSchedulerJobs(t)
	if len(jobs) != 1 {
		t.Fatalf("jobs len = %d, want 1", len(jobs))
	}
	if jobs[0].Name != "fast-probe" {
		t.Fatalf("unexpected job %q", jobs[0].Name)
	}
	last, err := time.Parse(time.RFC3339, jobs[0].LastRun)
	if err != nil {
		t.Fatalf("lastRun not RFC3339: %q err=%v", jobs[0].LastRun, err)
	}
	if last.Before(before) || last.After(time.Now()) {
		t.Fatalf("lastRun %v outside test window [%v, now]", last, before)
	}
}

// TestSchedulerJobs_UnwiredEmptyList 调度器引用未注入（模块 Init 前窗口/裸路由
// 单测）返回空清单而非报错——响应形状恒稳定，消费方无需区分「未就绪/无任务」
func TestSchedulerJobs_UnwiredEmptyList(t *testing.T) {
	SetSchedulerSource(nil)
	jobs := getSchedulerJobs(t)
	if len(jobs) != 0 {
		t.Fatalf("unwired scheduler should yield empty list, got %d jobs", len(jobs))
	}
}
