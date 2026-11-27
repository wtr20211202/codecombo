package middleware

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"codecombo/server/diagnostics"

	"github.com/gin-gonic/gin"
)

// 请求时间线记录中间件（P-20261124-1 S1①②）。
//
// 挂载位置（app.go）——必须在 gin.Recovery 之内、gin.Logger 之外：
//
//	Recovery → RequestTimeline → Logger → RequestID → …路由
//
// 为什么不是「Metrics 那样全量计时」：请求环只收慢/异常样本（见
// diagnostics.RecordRequest 的阈值），稳态零分配；in-flight 复用 Metrics 的
// 既有 gauge，不新造计数面。
//
// 为什么在 Logger 之外、Recovery 之内：
//   - 在 Logger 之外：gin.Logger 在 c.Next() 返回后才写访问日志行，只有外层
//     defer 能看到这次写盘是否真的发生（silent 判定）；也是接收 Logger 之后
//     状态码的唯一位置。
//   - 在 Recovery 之内：defer 先于 Recovery 的 recover 执行，能拿到 panic 值
//     （panic 后 Logger 不会写行，silent=true 正是「日志里查不到这条请求」）；
//     记录后原样 re-panic，500 响应仍由 Recovery 统一写出，行为不变。
//
// panic 摘要只留类型 + 截断文本（≤200 字符），不带栈；导出时再过 Redactor。

// RequestTimeline 请求时间线记录
func RequestTimeline() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		logSeq := diagnostics.LogWriteSequence()
		defer func() {
			p := recover()
			end := time.Now()
			status := c.Writer.Status()
			if p != nil {
				status = http.StatusInternalServerError
			}
			route := c.FullPath()
			if route == "" {
				// 未匹配路由绝不写原始路径：分享短链/回调 token 就在路径段里
				route = "unmatched"
			}
			rec := diagnostics.RequestRecord{
				StartedAt:   start.Format("2006-01-02T15:04:05.000Z07:00"),
				CompletedAt: end.Format("2006-01-02T15:04:05.000Z07:00"),
				DurationMS:  end.Sub(start).Milliseconds(),
				Method:      c.Request.Method,
				Route:       route,
				Status:      status,
				RID:         RequestIDFromGin(c),
				ClientIP:    c.ClientIP(),
				WS:          strings.EqualFold(c.GetHeader("Upgrade"), "websocket"),
				Probe:       isProbeRoute(route),
				Silent:      diagnostics.LogWriteSequence() == logSeq,
			}
			if p != nil {
				rec.Panic = true
				rec.PanicSummary = panicSummary(p)
			}
			diagnostics.RecordRequest(rec)
			// 路由级热点聚合（P-20261126-3 S4）：复用上面同一次耗时读取，不新造
			// 计时中间件（P-20261124-1 S1① 中间件顺序不动）；WS 只计次不计时长
			diagnostics.RecordRouteSample(route, c.Request.URL.Path, int64(status), rec.DurationMS, rec.WS)
			if p != nil {
				panic(p) // Recovery 照旧写 500 并收尾
			}
		}()
		c.Next()
	}
}

// isProbeRoute 探活/指标类路由：慢探活是「服务卡死」的第一信号，单列标记
func isProbeRoute(route string) bool {
	switch route {
	case "/api/health", "/api/healthz", "/api/metrics", "/api/system/health":
		return true
	}
	return false
}

// panicSummary panic 值摘要：类型名 + 截断文本（不含栈）
func panicSummary(p any) string {
	var s string
	switch v := p.(type) {
	case error:
		s = fmt.Sprintf("%T: %v", p, v)
	case string:
		s = "string: " + v
	default:
		s = fmt.Sprintf("%T: %v", p, v)
	}
	if len(s) > diagnostics.PanicSummaryMax {
		s = s[:diagnostics.PanicSummaryMax] + "…"
	}
	return s
}
