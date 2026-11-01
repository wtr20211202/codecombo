package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/shared"
)

// LockCSRF cookie 载体引入后的跨站写防护（P-20261019-2 ④）。
//
// 背景：解锁令牌改 HttpOnly cookie 后成为浏览器自动携带的环境凭据，写方法
// 多出 CSRF 面。SameSite=Strict 挡住了跨「站」请求，但 cookie 的站判定不含
// 端口——同主机另一端口（dsh 控制台/端口预览页面等，正是本提案要收口的
// 威胁面）对浏览器而言是 same-site，Strict cookie 照常携带。故写方法必须
// 按源（host:port）校验，与 ws.SameOrigin 的 WS 劫持防线同一条信任线：
//   - Origin 头存在时其 host:port 必须与请求 Host 一致（scheme 不限，兼容
//     反代终止 TLS 的部署）；缺失放行（curl/agent 等非浏览器客户端没有
//     Origin，UI 同源 XHR 的 PUT/DELETE 在个别内核也可能省略——从严只判
//     「存在即须同源」，缺失一律信任，不把机器间调用挡在门外）；
//   - Sec-Fetch-Site 存在且为 cross-site / same-site 时拒绝：现代内核对
//     跨源 fetch 会附带该头，same-site（同主机不同端口）恰是本提案威胁面，
//     只认 same-origin / none（地址栏直达等用户发起导航）。
//
// 只约束写方法（POST/PUT/DELETE/PATCH）：读面已由 CORS 的同源开关闭合
// （mw.CORS 只对 SameOrigin 请求回 CORS 头，异源页面读不到响应）。
// 挂在全部锁保护组（/api、/proxy、/preview、/metrics）最前——cookie 是否
// 参与鉴权由锁配置决定，本中间件不读锁状态：锁关闭时无环境凭据本就无 CSRF
// 面，同源校验对合法流量恒真，常开零误伤且不随锁开关漂移。
func LockCSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		default:
			c.Next()
			return
		}
		if !shared.SameOrigin(c.Request) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"err": "crossOriginWriteRejected",
				"msg": "cross-origin write is rejected (lock token cookie CSRF guard)",
			})
			return
		}
		switch c.Request.Header.Get("Sec-Fetch-Site") {
		case "cross-site", "same-site":
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"err": "crossOriginWriteRejected",
				"msg": "cross-site write is rejected (lock token cookie CSRF guard)",
			})
			return
		}
		c.Next()
	}
}
