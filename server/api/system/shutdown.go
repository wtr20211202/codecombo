package system

import (
	shared "codecombo/server/api/shared"
	"log/slog"
	"net/http"
	"sync"

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
// 约束：仅回环地址 + 必须携带自定义头。成功即 202（关闭流程异步进行）
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
