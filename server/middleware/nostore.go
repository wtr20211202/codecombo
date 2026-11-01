package middleware

import "github.com/gin-gonic/gin"

// noStoreHeaders 私有内容响应的缓存头（P-20261002-121）：头名 → 值。
//   - Cache-Control: no-store——浏览器与共享缓存对响应零落盘零存储：
//     项目文件内容/分享访客面在共享或公共设备上浏览后不在本地缓存
//     留下可回读的痕迹（本地留痕防线的最后一环）
//   - Pragma: no-cache——HTTP/1.0 旧代理兜底（不识别 Cache-Control 时
//     强制回源再验证；现代链路上冗余，只为老中间盒保留）
//
// 与 securityBaseline（P-20261002-42）同族但施加形态不同：基线是全局
// 中间件，本头对是路由级中间件——静态资源/公共资源的缓存策略
// （app.go 的 immutable/no-cache 分级）不得被覆盖。
var noStoreHeaders = map[string]string{
	"Cache-Control": "no-store",
	"Pragma":        "no-cache",
}

// NoStore 路由级中间件：私有内容端点禁止一切缓存。
// 作用域纪律：只挂私有内容读取面（当前为 files 域 file-policy / file /
// file/download 三端点，router.go）——绝不上挂全局：SPA 静态资源依赖
// app.go 的 immutable/no-cache 分级策略，端口预览反代透传被代理应用
// 自身的缓存语义，公共 API 无内容外发，均不经本中间件。
// 分享访客子服务（独立 http.Server，不经主引擎中间件链）在
// server/share Handler() 入口自带同值头。
func NoStore() gin.HandlerFunc {
	return func(c *gin.Context) {
		for name, v := range noStoreHeaders {
			c.Header(name, v)
		}
		c.Next()
	}
}
