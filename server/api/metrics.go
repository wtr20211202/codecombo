package api

import (
	"net/http"

	"codecombo/server/metrics"

	"github.com/gin-gonic/gin"
)

// HandleMetrics Prometheus 文本格式指标出口。
// 路由：GET /api/metrics（受 LockMiddleware 保护——路由名/计数属系统元数据）
// 指标面：HTTP 请求计数/时长/in-flight、WS 连接数、总线事件吞吐、进程级
// goroutine/heap/uptime；扩展时在目标位置调 metrics 包 API 注册即可
func HandleMetrics(c *gin.Context) {
	c.Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	c.String(http.StatusOK, metrics.Render())
}
