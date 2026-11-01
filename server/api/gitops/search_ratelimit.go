package gitops

import (
	"strconv"
	"strings"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	mw "codecombo/server/middleware"

	"github.com/gin-gonic/gin"
)

// ── 内容搜索限流（P-20261004-124）──
//
// 动机：内容搜索端点每查询起 rg/git grep 子进程，此前零限流——失控脚本/
// 前端防抖失效循环/agent 误用循环 = 子进程风暴（CPU 饱和 + 进程表膨胀）。
// 复用 oauth poll 同款基建（middleware.RateLimiter 固定窗口，RateLimitMiddleware
// 同一核心），但不用其裸 429 响应：搜索超限走稳定标记 429（errmarkers.
// SearchRateLimited + code search.rate_limited，agent 按 code 自纠降频），并按
// ops-notify/opsmessage 同款惯例每窗口回告一条 system:rate-limited 事件
//（agent 批量检索超限的 ops-channel 感知面，载荷 opschannel.RateLimitedNotice）。
//
// P-20261005-158 起构造器泛化为搜索族共用单一 helper：终端输出检索
// GET /api/terminals/search（terminal.SearchOutputRateLimit）复用同一实现，
// 勿在终端包再抄一份。终端侧键带 ops-notify opsNotifyRateKey 同款前缀
//（sid:/tok:/ip:），回告维度按前缀推导（session/token/ip）；gitops 侧无前缀
// 键回落 fallbackDimension——既有回告载荷（dimension "project"/键原文）零变化。

const (
	// searchRateLimit 每窗口每 key 允许的搜索请求数。保守标定：人工检索 300ms
	// 防抖 + 选项切换重搜（ProjectSearch.vue 实测形态）远低于此；agent 批量
	// 检索超过此频次应触发 search.rate_limited 自纠降频，而不是烧满 CPU
	searchRateLimit = 30
	// searchRateWindow 限流窗口长度（固定窗口，到期滑动自动恢复）
	searchRateWindow = time.Minute
)

// SearchProjectRateLimit 单项目内容搜索限流（GET /api/projects/:id/search）：
// 按项目 id 维度——agent 在单项目内循环检索只烧该项目的预算，不拖累其他项目
// 的人工检索（本机部署全回环，IP 维度会把人与 agent 耦合进同一桶）。
// 路由注册期构造一次（每路由独立 limiter/闸门实例，oauth poll 同款）
func SearchProjectRateLimit() gin.HandlerFunc {
	return newSearchRateLimit(searchRateWindow, func(c *gin.Context) string {
		return c.Param("id")
	})
}

// BatchSearchRateLimit 跨项目批量搜索限流（GET /api/search/projects）：按客户端
// IP 维度——单请求即并发扇出至多 50 项目（maxBatchSearchProjects × 单仓池），
// 按 ids 组合做 key 会被「滑窗换组合」的循环绕开；该端点 web 前端不用（agent
// 原语），回环部署下 IP ≈ 调用方机器
func BatchSearchRateLimit() gin.HandlerFunc {
	return newSearchRateLimit(searchRateWindow, func(c *gin.Context) string {
		return c.ClientIP()
	})
}

// SearchRateLimit 搜索族限流中间件构造（P-20261004-124 落地、P-20261005-158 起
// 泛化为搜索族单一实现）：窗内放行；超限 429（errmarkers.SearchRateLimited
// 稳定标记 + code search.rate_limited + Retry-After 头与体字段——查询端点不
// 静默丢弃，用户在等结果）并经闸门每 key 每窗口回告一条 system:rate-limited。
//
// 参数：
//   - limit：每窗口每 key 放行上限
//   - window：窗口长度（生产路径固定 time.Minute；单测注入短窗口驱动恢复，
//     中间件对 handler 不可知，窗口数学与真实搜索耗时解耦才可确定性测恢复）
//   - fallbackDimension：回告维度名，键无 ops-notify 惯例前缀时使用
//     （gitops project/ip 裸键 → "project"；带前缀键按前缀推导 session/token/ip）
//   - keyFn：限流维度键；返回空跳过限流（与 RateLimitMiddleware 同语义：
//     无效请求由 handler 校验拒绝）
//
// 落位 server/api 层而非 middleware 包：回告广播依赖 opschannel，而 opschannel
// 反向依赖 middleware（广播基建），middleware 包收会被 import 环挡死；放 gitops
// （搜索限流发源地）由 terminal 跨包复用——api handler 包互依有先例
// （project→gitops、system→terminal）
func SearchRateLimit(limit int, window time.Duration, fallbackDimension string, keyFn func(*gin.Context) string) gin.HandlerFunc {
	limiter := mw.NewRateLimiter(limit, window)
	// 回告节流闸门：每 key 每窗口仅放行 1 条 system:rate-limited，
	// 防回告自身变成新的广播源（ops-notify opsNotifyFeedbackGate 同款）
	gate := mw.NewRateLimiter(1, window)

	return func(c *gin.Context) {
		key := keyFn(c)
		if key == "" {
			c.Next()
			return
		}
		count := limiter.Hit(key)
		if count > limit {
			notifySearchLimited(gate, key, count, limit, window, fallbackDimension)
			retryAfter := int(time.Until(limiter.ExpireAt(key)).Seconds())
			if retryAfter < 1 {
				retryAfter = 1 // 窗口边界竞态下不为 0（Retry-After: 0 对客户端无意义）
			}
			c.Header("Retry-After", strconv.Itoa(retryAfter))
			shared.AbortWithCode(c, shared.CodeSearchRateLimited, gin.H{
				"error":       errmarkers.SearchRateLimited,
				"retry_after": retryAfter,
			})
			return
		}
		c.Next()
	}
}

// newSearchRateLimit gitops 两个生产端点的包装（上限/回告维度固定为本包常量
// 与 "project"——批量端点历史回告载荷即 dimension "project"，保持零变化；
// 既有单测按此签名直调注入短窗口）
func newSearchRateLimit(window time.Duration, keyFn func(*gin.Context) string) gin.HandlerFunc {
	return SearchRateLimit(searchRateLimit, window, "project", keyFn)
}

// notifySearchLimited 超限回告：经闸门每 key 每窗口 1 条进 ops-channel 广播流
// （429 已是触限方的直接回执，本事件是给操作面/观察者的「有调用方在猛打搜索」
// 感知面——与 429 响应互不替代）。维度按 ops-notify 惯例前缀推导（sid:/tok:/ip:
// → session/token/ip，键值剥前缀，notifyOpsNotifyLimited 同款 switch），无前缀
// 键回落 fallbackDimension 原样做键——gitops 既有 project/ip 裸键的线上载荷不变
func notifySearchLimited(gate *mw.RateLimiter, key string, count, limit int, window time.Duration, fallbackDimension string) {
	if gate.Hit(key) != 1 {
		return
	}
	dimension, identity := fallbackDimension, key
	switch {
	case strings.HasPrefix(key, "sid:"):
		dimension, identity = "session", strings.TrimPrefix(key, "sid:")
	case strings.HasPrefix(key, "tok:"):
		dimension, identity = "token", strings.TrimPrefix(key, "tok:")
	case strings.HasPrefix(key, "ip:"):
		dimension, identity = "ip", strings.TrimPrefix(key, "ip:")
	}
	opschannel.BroadcastEvent(opschannel.EventRateLimited, opschannel.RateLimitedNotice{
		Dimension: dimension,
		Key:       identity,
		Dropped:   count - limit, // Hit 恒递增：窗口累计命中数 − 上限 = 已拒绝
		Limit:     limit,
		WindowSec: int(window / time.Second),
	})
}
