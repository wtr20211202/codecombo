package middleware

import (
	"codecombo/server/api/shared"
	"codecombo/server/config"

	"github.com/gin-gonic/gin"
)

// ApplyTrustedProxies 把 server.trustedProxies 配置同时装到两处转发头消费面
// （P-20261020-1）：
//
//   - gin.Engine.SetTrustedProxies：c.ClientIP() 的 X-Forwarded-For / X-Real-IP
//     信任边界——限流键与审计 IP 都吃它；
//   - shared.SetTrustedProxies：RequestBaseURL 的 X-Forwarded-Proto/Host
//     信任边界（不走 Gin ClientIP 的独立消费点）。
//
// 默认空清单 = 不信任任何转发头（Gin 内置默认是信任所有代理，必须显式覆盖）。
// 校验失败时两处都降级为「无信任」并返回错误（安全失败：宁可把直连 IP 当
// 客户端，也不让不可信条目放行伪造头）；调用方记录告警即可继续启动。
func ApplyTrustedProxies(r *gin.Engine, entries []string) error {
	normalized, err := config.NormalizeTrustedProxies(entries)
	if err != nil {
		disableTrustedProxies(r)
		return err
	}
	if err := r.SetTrustedProxies(normalized); err != nil {
		// 防御分支：normalized 已通过同一套 IP/CIDR 校验，理论上不会再失败；
		// 若 Gin 解析语义变化仍按无信任降级
		disableTrustedProxies(r)
		return err
	}
	if err := shared.SetTrustedProxies(normalized); err != nil {
		disableTrustedProxies(r)
		return err
	}
	return nil
}

// disableTrustedProxies 两处信任面同时清空（转发头一律忽略）
func disableTrustedProxies(r *gin.Engine) {
	_ = r.SetTrustedProxies(nil)
	_ = shared.SetTrustedProxies(nil)
}
