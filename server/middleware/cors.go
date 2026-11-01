package middleware

import (
	"net/http"

	"codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// CORS 中间件：同源策略——仅当请求 Origin 与 Host 匹配时才回显 CORS 头，
// 跨源请求不授予跨域读取权限。浏览器同源请求本就不需要 CORS 头；
// 外部 agent / curl 不执行 CORS 策略，不受影响。
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		if shared.SameOrigin(c.Request) {
			if origin := c.Request.Header.Get("Origin"); origin != "" {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
			}
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
			c.Header("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization, X-Lock-Token")
			c.Header("Access-Control-Max-Age", "86400")
		}

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
