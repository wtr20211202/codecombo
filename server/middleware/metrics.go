package middleware

import (
	"strconv"
	"time"

	"codecombo/server/metrics"

	"github.com/gin-gonic/gin"
)

// Metrics 请求级指标中间件：总数（method/route/status 标签）+ 时长累计 + in-flight。
// route 取路由模式（c.FullPath()），避免 :id 实例值撑爆标签基数
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		metrics.AddGauge("sc_http_inflight", 1)
		defer metrics.AddGauge("sc_http_inflight", -1)

		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		metrics.IncCounter("sc_http_requests_total",
			"method", c.Request.Method,
			"route", route,
			"status", strconv.Itoa(c.Writer.Status()),
		)
		metrics.AddCounter("sc_http_request_duration_us_total", time.Since(start).Microseconds(),
			"route", route)
	}
}
