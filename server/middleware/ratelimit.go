package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// RateLimitMiddleware 通用限流中间件
//
// 参数：
//   - maxPerMinute：每分钟最大请求数
//   - keyFunc：决定限流维度（如同 device_code、IP 等）；返回空串时跳过限流
//
// 实现：
//   - 复用 ratelimit_core.go 的 RateLimiter（与 auth.go 的 IP 限流共用核心）
//   - 固定窗口算法（窗口过期自动重置）
//   - GC goroutine 由 RateLimiter 内部管理
//
// 使用示例：
//
//	oauth.GET("/poll", mw.RateLimitMiddleware(30, func(c *gin.Context) string {
//	    return c.Query("device_code")
//	}), admin.OAuthPoll)
func RateLimitMiddleware(maxPerMinute int, keyFunc func(c *gin.Context) string) gin.HandlerFunc {
	// 每个 middleware 实例独立一个 RateLimiter（entries map 隔离）
	// 与原实现等价：原代码用闭包内的 var entries = make(...)
	limiter := NewRateLimiter(maxPerMinute, time.Minute)

	return func(c *gin.Context) {
		key := keyFunc(c)
		// key 为空时跳过限流（如未提供 device_code 的请求）
		if key == "" {
			c.Next()
			return
		}

		count := limiter.Hit(key)
		if count > maxPerMinute {
			expireAt := limiter.ExpireAt(key)
			retryAfter := int(time.Until(expireAt).Seconds())
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "rate_limited",
				"msg":         "too many requests per minute",
				"retry_after": retryAfter,
			})
			return
		}
		c.Next()
	}
}
