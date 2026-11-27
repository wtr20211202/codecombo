package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"codecombo/server/diagnostics"

	"github.com/gin-gonic/gin"
)

// P-20261124-1 S1①②：recorder 在 Recovery 之内、Logger 之外——panic 仍写 500，
// 同时进请求环（panic=true），慢请求入环、快请求不入
func TestRequestTimelineRecordsPanicAndSlow(t *testing.T) {
	diagnostics.ResetTimelineForTesting()
	t.Cleanup(diagnostics.ResetTimelineForTesting)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(RequestTimeline())
	r.Use(RequestID())
	r.GET("/fast", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/slow", func(c *gin.Context) {
		time.Sleep(1050 * time.Millisecond)
		c.Status(http.StatusOK)
	})
	r.GET("/panic", func(c *gin.Context) { panic("boom-timeline-test") })

	serve := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		r.ServeHTTP(w, req)
		return w
	}
	if w := serve("/fast"); w.Code != http.StatusOK {
		t.Fatalf("fast status = %d", w.Code)
	}
	if w := serve("/slow"); w.Code != http.StatusOK {
		t.Fatalf("slow status = %d", w.Code)
	}
	if w := serve("/panic"); w.Code != http.StatusInternalServerError {
		t.Fatalf("panic must still be answered 500 by Recovery, got %d", w.Code)
	}

	recs := diagnostics.RequestsSnapshot()
	var slow, panicked bool
	for _, rec := range recs {
		switch rec.Route {
		case "/fast":
			t.Fatal("fast request must not be recorded")
		case "/slow":
			slow = true
			if rec.DurationMS < 1000 {
				t.Fatalf("slow duration = %dms", rec.DurationMS)
			}
		case "/panic":
			panicked = true
			if !rec.Panic || rec.Status != 500 {
				t.Fatalf("panic record = %+v", rec)
			}
		}
	}
	if !slow || !panicked {
		t.Fatalf("ring missing records: slow=%t panic=%t (%+v)", slow, panicked, recs)
	}
}
