package terminal

import (
	"strings"
	"time"

	"codecombo/server/api/gitops"

	"github.com/gin-gonic/gin"
)

// ── 终端输出检索限流（P-20261005-158，搜索族限流面补全）──
//
// 动机：GET /api/terminals/search 单请求遍历活会话 × 各 2000 行内存剥离匹配
//（terminal_search.go，CPU 密集读端点），此前防线只有前端 300ms 防抖——agent
// 令牌/buggy 客户端高频打点 = 扫描风暴。与 git grep 内容搜索限流共用同一实现
//（gitops.SearchRateLimit 单一 helper 勿双实现，P-20261004-124 同族）：超限 429
// 走稳定标记 errmarkers.SearchRateLimited + code search.rate_limited +
// Retry-After（查询端点不静默丢弃——用户在等结果，与 ops-notify 的 200 丢弃
// 回告语义不同）；错误码复用 P-305 注册表既有 search.rate_limited（第三批已
// 登记，搜索族同码同自纠契约，无需新增）。429+Retry-After 即 agent 可程序化
// 退避的自纠信号（限流是协议面不是惩罚）。

const (
	// terminalSearchRateLimit 每窗口每 key 放行上限。与 git grep 内容搜索
	// 同族同参（30 次/分钟）：终端检索 e2e 的命中轮询单用例即可合法连打
	// ~20 次（terminal-sensitive-egress 的 500ms 轮询环），10 次/分钟会把
	// 既有确定性用例误伤；30 次对人工检索（前端 300ms 防抖 + 浮层逐词
	// 扩展重搜）仍有充分余量，agent 风暴循环依旧触限自纠
	terminalSearchRateLimit = 30
	// terminalSearchWindow 限流窗口长度（固定窗口，到期滑动自动恢复）
	terminalSearchWindow = time.Minute
)

// SearchOutputRateLimit 终端输出检索限流（GET /api/terminals/search）。
// 路由注册期构造一次（每路由独立 limiter/闸门实例，oauth poll 同款）
func SearchOutputRateLimit() gin.HandlerFunc {
	return gitops.SearchRateLimit(terminalSearchRateLimit, terminalSearchWindow, "ip", terminalSearchRateKey)
}

// terminalSearchRateKey 限流键（ops-notify opsNotifyRateKey 同款链，前缀供
// 回告维度推导）：X-Session-ID 头（操作手册建议 agent 全量携带——单会话风暴
// 只烧自己的预算）优先，再退调用令牌（鉴权中间件注入的 tokenID），兜底
// ClientIP（本机 UI 直连从不携带 Authorization，人工检索自然落 IP 桶——
// 回环部署下 IP ≈ 调用方机器；agent 令牌走 tok 桶，与人工预算互不耦合）
func terminalSearchRateKey(c *gin.Context) string {
	if sid := strings.TrimSpace(c.GetHeader("X-Session-ID")); sid != "" {
		return "sid:" + sid
	}
	if tok := strings.TrimSpace(c.GetString("tokenID")); tok != "" {
		return "tok:" + tok
	}
	return "ip:" + c.ClientIP()
}
