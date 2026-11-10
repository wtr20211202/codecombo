package system

import (
	shared "codecombo/server/api/shared"
	"log/slog"
	"net/http"
	"sync"

	mw "codecombo/server/middleware"

	"github.com/gin-gonic/gin"
)

// A8：cmdStop 直接 Kill 跳过优雅停机的修复配套。
// Windows 无 SIGTERM 可投递（跨进程 GenerateConsoleCtrlEvent 需共享控制台），
// HTTP 关机端点是唯一跨平台优雅停机通道：组合根注册 srv.Shutdown，本端点触发。

var (
	shutdownMu   sync.RWMutex
	shutdownFunc func()
)

// RegisterShutdown 组合根（server/app）在 http.Server 建立后注册优雅关闭函数。
// 注册前收到关机请求返回 503（调用方回退 Kill）
func RegisterShutdown(fn func()) {
	shutdownMu.Lock()
	shutdownFunc = fn
	shutdownMu.Unlock()
}

// shutdownHeader 自定义头：浏览器跨源页面无法携带自定义头（预检会被同源
// CORS 策略拦截），防止任意网页对本机服务发起 CSRF 关机
const shutdownHeader = "X-SC-Shutdown"

// Shutdown POST /api/shutdown —— 本机优雅停机（cmdStop 优先走这里）
// 约束：仅回环地址 + 必须携带自定义头。成功即 202（关闭流程异步进行）。
// 刻意不随 /api/restart 放开锁令牌双路（P-20261109-11）：重启可恢复、停机
// 是终局——停机的合法入口恒在本机（CLI cmdStop / 本机浏览器），远端误触
// 停机没有「自己回来」的兜底，故保持 loopback-only 不动
func Shutdown(c *gin.Context) {
	if !isLoopbackRequest(c) {
		shared.Error(c, http.StatusForbidden, "loopback only", nil)
		return
	}
	if c.GetHeader(shutdownHeader) == "" {
		shared.Error(c, http.StatusBadRequest, "missing "+shutdownHeader, nil)
		return
	}
	shutdownMu.RLock()
	fn := shutdownFunc
	shutdownMu.RUnlock()
	if fn == nil {
		shared.Error(c, http.StatusServiceUnavailable, "shutdown not ready", nil)
		return
	}
	slog.Info("graceful shutdown requested via api (local)")
	go fn() // 异步执行 srv.Shutdown：先响应，让 cmdStop 的请求正常拿到结果
	c.JSON(http.StatusAccepted, gin.H{"ok": true})
}

var (
	restartMu  sync.RWMutex
	restartFun func()
)

// RegisterRestart 组合根（server/app）注册的重启动作（P-20261106 页面重启链）。
// 注册前收到重启请求返回 503
func RegisterRestart(fn func()) {
	restartMu.Lock()
	restartFun = fn
	restartMu.Unlock()
}

// restartHeader 自定义头：与 shutdownHeader 同型 CSRF 防线
const restartHeader = "X-SC-Restart"

// Restart POST /api/restart —— 本机优雅重启。
// 授权双路（P-20261109-11）：回环 OR 有效锁凭据（mw.ValidateLockCredential，
// 校验器与载体与锁中间件同一套）——LAN/https（TLS 自签 + IP 访问）是产品
// 默认部署形态，解锁后凭 X-Lock-Token 头（或 HttpOnly cookie 载体）即可
// 重启；锁定态非回环且无有效 token 仍 403（诚实文案）。回环路径不受影响
// （A8：锁定态也必须能重启恢复——本端点刻意不入 api 锁保护组的原因）。
// X-SC-Restart 头保持必携：跨源页面无法携带自定义头（预检被同源 CORS 拒），
// 与锁凭据双头=双保险。接受 cookie 载体却不挂 mw.LockCSRF 的理由：LockCSRF
// 防的是「同主机异端口页面借 Strict cookie 发简单请求」，本端点必携自定义头
// 已使跨源浏览器请求过不了预检（同源 CORS 不批）、简单请求缺头恒 400——同一
// 威胁面已闭合。成功即 202（重启异步进行：监听短暂离线后回归，前端轮询
// /api/health 收口）。运行形态分链见组合根注册的动作
func Restart(c *gin.Context) {
	// via 运行日志授权路径标注：LAN 放开后重启不再必然是本机动作，日志须能
	// 区分「回环」与「凭锁凭据的远端会话」（凭据值本身不入日志）
	via := "loopback"
	if !isLoopbackRequest(c) {
		if _, ok := mw.ValidateLockCredential(c.Request); !ok {
			shared.Error(c, http.StatusForbidden, "loopback only or valid unlock token required", nil)
			return
		}
		via = "lock-credential"
	}
	if c.GetHeader(restartHeader) == "" {
		shared.Error(c, http.StatusBadRequest, "missing "+restartHeader, nil)
		return
	}
	restartMu.RLock()
	fn := restartFun
	restartMu.RUnlock()
	if fn == nil {
		shared.Error(c, http.StatusServiceUnavailable, "restart not ready", nil)
		return
	}
	slog.Info("graceful restart requested via api", "via", via, "ip", c.ClientIP())
	go fn() // 异步执行：先响应，前端拿到结果后开始轮询健康
	c.JSON(http.StatusAccepted, gin.H{"ok": true})
}
