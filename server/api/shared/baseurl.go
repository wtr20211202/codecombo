package shared

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// RequestBaseURL 组装对外文档（/ops-manual、SKILL.md 及后续同类）示例用的
// baseURL（scheme://host）。三态判定（P-20261004-129）：
//
//  1. 反代形态：直连对端属于可信代理（server.trustedProxies，P-20261020-1）
//     且 X-Forwarded-Proto 与 X-Forwarded-Host 双在场 → 用转发值
//     （反代终止 TLS 时后端看不见 Request.TLS，转发头是唯一线索；不看不发
//     手册就会把 agent 教去 http 入口，撞重定向/混合内容失败）。链式代理的
//     多段值（"https, http"）取首段——首段即客户端实际入口；proto 仅认
//     https/http，其余值按 http 兜底（坏值产出 ftp:// 这类垃圾示例不如回常规）
//  2. 直连 TLS：Request.TLS 非空（--tls 自带证书形态）→ https + Host
//  3. 缺省：http + Host（明文回环直连现状，行为不变）
//
// 信任注记（P-20261020-1）：转发头可被任意客户端伪造——若直连对端不在
// server.trustedProxies 内，XFP/XFH 一律忽略并回落直连判定。本值只进手册
// 示例文本（{{BASE}} 展开），不参与鉴权/重定向/回调决策，但对外示例的
// scheme/host 被伪造仍会误导 agent 连接攻击者地址，故与 ClientIP 同边界收口。
func RequestBaseURL(c *gin.Context) string {
	if IsTrustedProxyRequest(c) {
		proto := firstForwardedValue(c.GetHeader("X-Forwarded-Proto"))
		host := firstForwardedValue(c.GetHeader("X-Forwarded-Host"))
		if proto != "" && host != "" {
			if proto != "https" && proto != "http" {
				proto = "http"
			}
			return proto + "://" + host
		}
	}
	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + c.Request.Host
}

// firstForwardedValue 取 X-Forwarded-* 头的首段值（去空白、小写化）。多段值
// 语义：链式代理逐跳追加，首段是最靠近客户端的一跳即真实入口。空串 = 头不在场
func firstForwardedValue(h string) string {
	if i := strings.IndexByte(h, ','); i >= 0 {
		h = h[:i]
	}
	return strings.ToLower(strings.TrimSpace(h))
}
