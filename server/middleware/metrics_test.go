package middleware

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/metrics"
)

func TestMetricsMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	metrics.ResetForTesting()

	r := gin.New()
	r.Use(Metrics())
	r.GET("/ping/:id", func(c *gin.Context) { c.String(200, "pong") })

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/ping/42", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
	}

	out := metrics.Render()
	if !strings.Contains(out, `sc_http_requests_total{method="GET",route="/ping/:id",status="200"} 3`) {
		t.Errorf("expected request counter with route pattern, got:\n%s", out)
	}
	if !strings.Contains(out, `sc_http_request_duration_us_total{route="/ping/:id"} `) {
		t.Errorf("expected duration counter, got:\n%s", out)
	}
	// 请求结束后 in-flight 应回落为 0
	if !strings.Contains(out, "sc_http_inflight 0") {
		t.Errorf("expected inflight gauge back to 0, got:\n%s", out)
	}
}
