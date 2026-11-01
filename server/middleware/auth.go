package middleware

import (
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/store"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ipLimiter 按 IP 维度限流：每分钟 maxFailures 次失败后封禁 60s
//
// 语义（修正后）：仅校验失败计数（recordFailure 递增），成功请求不计数。
// 旧行为是"每次请求都递增"——实例代理场景（所有请求带 token 且同源 IP）
// 每分钟 10 个请求后必然 429，远程实例功能整体不可用，故修正为仅失败计数。
//
// 与原 sync.Map 实现相比：
//   - 复用 ratelimit.go 共用的 RateLimiter / rateLimitEntry 类型（去重）
//   - GC goroutine 由 RateLimiter 内部管理（去重）
var ipLimiter = NewRateLimiter(maxFailures, rateLimitWindow)

const (
	// maxFailures 每分钟最大失败次数
	maxFailures = 10
	// rateLimitWindow 限流时间窗口
	rateLimitWindow = time.Minute
)

// checkRateLimit 检查指定 IP 是否超出限流阈值
//
// 行为：纯查询（不递增计数），返 true 表示已封禁（应返 429）。
// 计数只由 recordFailure（校验失败路径）递增——若每次请求都计数，
// 实例代理（所有请求带 token 且同源 IP）在每分钟 10 个请求后必然被 429，
// 远程实例功能整体不可用。
func checkRateLimit(ip string) bool {
	return ipLimiter.IsLimited(ip)
}

// recordFailure 记录一次验证失败
//
// 行为：递增 IP 计数（不返值）。与原实现一致。
// 调用方：validateBearerToken 内 password / token 校验失败时调用。
func recordFailure(ip string) {
	ipLimiter.Hit(ip)
}

// validateBearerToken 解析并验证 Bearer Token，返回验证结果
// 成功时返回 tokenConfig，失败时已自动写入错误响应并返回 nil
func validateBearerToken(c *gin.Context, trackFailure bool) *config.TokenConfig {
	authHeader := c.GetHeader("Authorization")
	clientIP := c.ClientIP()

	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		if trackFailure {
			recordFailure(clientIP)
		}
		// 401 原文是前端 KNOWN_ERROR_I18N 匹配契约，收口 errmarkers（P-20261004-29）
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": errmarkers.AuthHeaderInvalid})
		return nil
	}

	token := strings.TrimSpace(parts[1])
	if !strings.HasPrefix(token, "sc_") {
		if trackFailure {
			recordFailure(clientIP)
		}
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token format"})
		return nil
	}

	tokenCfg, err := store.Get().Token.Validate(token)
	if err != nil {
		if trackFailure {
			recordFailure(clientIP)
		}
		slog.Warn("token validation failed", "ip", clientIP, "err", err)
		// 401 原文是前端匹配契约 + 实例探活的远端 401 识别串（system/instance.go），
		// 收口 errmarkers（P-20261004-29）
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": errmarkers.AuthenticationFailed})
		return nil
	}

	c.Set("tokenID", tokenCfg.ID)
	// Debug：每个携带 token 的请求都打 Info 会成日志热点（×双 sink×全局互斥），
	// 成功认证是常态不是事件，降为 Debug 供排查开启
	slog.Debug("token authenticated", "id", tokenCfg.ID, "ip", clientIP)
	return tokenCfg
}

// TokenAuthMiddleware 可选 Token 认证：无 header 时放行
func TokenAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.Next()
			return
		}

		clientIP := c.ClientIP()
		if checkRateLimit(clientIP) {
			slog.Warn("rate limited", "ip", clientIP)
			// 429 原文是前端匹配契约，收口 errmarkers（P-20261004-29）
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": errmarkers.TooManyAuthFailures})
			return
		}

		validateBearerToken(c, true)
	}
}

// hasValidAccessToken 纯校验请求是否携带有效 access token（无副作用，不写响应）。
// 供 LockMiddleware 豁免机器间调用使用——失败时静默返回 false，由调用方继续原流程
func hasValidAccessToken(c *gin.Context) bool {
	return hasValidAccessTokenRequest(c.Request)
}

// hasValidAccessTokenRequest 基于 http.Request 的 access token 校验。
// HTTP 中间件与 WS 握手期校验（ValidateLockTokenForWS）共用，保证两条路径信任语义一致
func hasValidAccessTokenRequest(r *http.Request) bool {
	ah := r.Header.Get("Authorization")
	parts := strings.SplitN(ah, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	token := strings.TrimSpace(parts[1])
	if !strings.HasPrefix(token, "sc_") {
		return false
	}
	_, err := store.Get().Token.Validate(token)
	return err == nil
}

// RequireTokenAuthMiddleware 强制 Token 认证：无 Token 配置时跳过
//
// 本机 UI 直连路径豁免：UI 请求从不携带 Authorization（远程代理路径才由
// proxy 注入），若本机配了任意 API Token，UI 自身对 apply-from-center /
// apply / serve-binary 这类强制认证端点的调用会全部 401。因此当请求携带
// 有效解锁令牌（X-Lock-Token，已解锁会话的凭证）时视为已认证——持有解锁
// 令牌即已通过系统解锁，信任语义与 LockMiddleware 的令牌校验一致
func RequireTokenAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !store.Get().Token.HasAny() {
			c.Next()
			return
		}

		if c.GetHeader("Authorization") != "" {
			validateBearerToken(c, false)
			return
		}

		// 本机 UI 直连路径豁免（续）：解锁令牌头载体优先；P-20261019-2 起浏览器侧
		// 令牌改 HttpOnly cookie 载体（刷新后的页面内存无 token，无头可带），
		// cookie 载体与 LockMiddleware 同语义放行——校验器同一套，不新增信任边界
		if t := c.GetHeader(LockHeaderName); t != "" &&
			(store.Get().Lock.ValidateToken(t) || store.Get().AgentToken.Validate(t)) {
			c.Next()
			return
		}
		if t, _ := c.Cookie(LockCookieName); t != "" &&
			(store.Get().Lock.ValidateToken(t) || store.Get().AgentToken.Validate(t)) {
			c.Next()
			return
		}

		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
	}
}
