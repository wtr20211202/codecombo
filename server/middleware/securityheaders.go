package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// 主应用安全响应头基线（P-20261002-42）：头名 → 基线值。
// 分享访客子服务（server/share）自带更严的头（no-referrer + CSP frame-ancestors
// 'none'），dsh 反代/端口预览为使 iframe 可用而剥帧头（设计使然），主 SPA 与
// API 响应此前四无——本基线补齐三个零风险头：
//   - X-Content-Type-Options: nosniff——禁止浏览器对响应做 MIME 嗅探
//   - Referrer-Policy: strict-origin-when-cross-origin——跨源只发 origin，
//     URL 里的项目路径不随 Referer 外泄给外链
//   - X-Frame-Options: SAMEORIGIN——只允许同源 iframe 嵌入，锁屏界面不可被
//     第三方站点 overlay clickjacking。全仓自嵌场景已核实不受影响：preview
//     面板 iframe 走主引擎同源路径；dsh 反代是独立端口的独立 http.Server，
//     不经本中间件
//
// 完整 CSP（P-20261002-42 明示的后续独立件）自 P-20261007-6 起以
// Content-Security-Policy-Report-Only 观察期形态增量落地（见下方
// cspReportOnlyPolicy）；本轮不切 enforcing、不收紧任何指令——先收集真实
// 使用与 e2e 全量的违规面，再按报告数据逐指令拍板。
var securityBaseline = map[string]string{
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy":        "strict-origin-when-cross-origin",
	"X-Frame-Options":        "SAMEORIGIN",
}

const (
	// HeaderCSPReportOnly CSP 观察期头名（P-20261007-6）。单独常量供转发方
	// （/proxy）与测试复用，避免多处拼字面量。
	HeaderCSPReportOnly = "Content-Security-Policy-Report-Only"
	// HeaderReportingEndpoints Reporting API 的端点表头（P-20261007-6）：
	// CSP 的 report-to 指令按组名引用这里声明的 URL；现代 Chrome 优先走
	// report-to，report-uri 作为全浏览器兜底并存。
	HeaderReportingEndpoints = "Reporting-Endpoints"
	// cspReportPath CSP 违规报告收集端点（公开、限流，见 api/system/cspreport.go）
	cspReportPath = "/api/csp-report"
	// cspReportGroup Reporting API 中指向 cspReportPath 的组名
	cspReportGroup = "csp-endpoint"
)

// cspReportOnlyPolicy 主应用初版 CSP 策略（Report-Only 观察期，P-20261007-6）。
//
// 资产清点（Vite prod bundle + 运行时依赖，写死前的粗清点结论）：
//   - script：Vite 产物全部同源带哈希 chunk（'self'）；index.html 无内联脚本。
//     开发构建（version=dev，常配 Vite HMR / Vue devtools）需要 'unsafe-eval'，
//     生产构建不放行。注意 Vite dev server（:5173）伺服文档时不经过 Go 中间件，
//     本分叉覆盖本地 Go 直接伺服嵌入产物的开发形态，并作为 dev 头下发的单一入口。
//   - style：naive-ui 的 CSS-in-JS 与 Vue :style 绑定在运行时注入内联样式，
//     style-src 必须保留 'unsafe-inline'（如实保留，收紧列远期注记，不在本阶段）。
//   - img：markdown 预览的外链图、粘贴图 data:/blob:、下载预览 blob:——起步从宽。
//   - connect：API 与全部 WS 均同源（/api、/ws/*、/proxy/<id>/*）；ws:/wss: 显式
//     列出是 CSP 的 'self' 对 WS scheme 匹配的历史差异兜底，从宽起步避免漏报。
//   - frame：preview 面板 /preview/:port 与 dsh 控制台均为同源 iframe。
//   - worker：Monaco 语言 worker 由 Vite 产出同源 chunk，内部再用 blob: 引导。
//   - font：@fontsource 字体随 bundle 同源伺服（woff2），data: 兜底旧浏览器内联。
//   - object/base/form：零风险指令本可立即 enforcing（拆解计划第 3 步），本轮
//     仍随 Report-Only 观察，不产生拦截。
//
// frame-ancestors 在 Report-Only 下按规范不生效（浏览器忽略），同源嵌入防线
// 当前仍由 enforcing 的 X-Frame-Options: SAMEORIGIN 承担；切 enforcing 时本
// 指令自然接管。报告通道 report-uri（全浏览器兜底）+ report-to（Reporting API
// 组名）双写，端点见 cspReportPath。
func cspReportOnlyPolicy(dev bool) string {
	scriptSrc := "'self'"
	if dev {
		scriptSrc += " 'unsafe-eval'"
	}
	directives := []string{
		"default-src 'self'",
		"script-src " + scriptSrc,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https: http:",
		"font-src 'self' data:",
		"media-src 'self' data: blob:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self' blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'self'",
		"report-uri " + cspReportPath,
		"report-to " + cspReportGroup,
	}
	return strings.Join(directives, "; ")
}

// SecurityHeaders 中间件：给全部主应用响应施加上述基线 + CSP Report-Only。
// Set 语义写入在中间件链最前，下游 handler 仍可按需覆盖（如未来某端点需要
// 更严的 DENY）。dev 可选参数仅切换 CSP 的 dev 分支（'unsafe-eval'），既有
// 无参调用语义不变；装配点按 build version 传入（server/app/app.go）。
func SecurityHeaders(dev ...bool) gin.HandlerFunc {
	policy := cspReportOnlyPolicy(len(dev) > 0 && dev[0])
	reportingEndpoints := cspReportGroup + `="` + cspReportPath + `"`
	return func(c *gin.Context) {
		for h, v := range securityBaseline {
			c.Header(h, v)
		}
		c.Header(HeaderCSPReportOnly, policy)
		c.Header(HeaderReportingEndpoints, reportingEndpoints)
		c.Next()
	}
}

// SecurityBaselineHeaders 基线头名清单（包级派生，调用方不得修改）：供响应
// 转发方（中央代理 /proxy）在复制上游响应头前剥除同值冗余头——基线由全局
// 中间件统一施加，转发响应以本地为准（CSP Report-Only 与 Reporting-Endpoints
// 同属全局施加面，一并剥除防止远端旧策略拼成重复头）
var SecurityBaselineHeaders = func() []string {
	names := make([]string, 0, len(securityBaseline)+2)
	for h := range securityBaseline {
		names = append(names, h)
	}
	names = append(names, HeaderCSPReportOnly, HeaderReportingEndpoints)
	return names
}()
