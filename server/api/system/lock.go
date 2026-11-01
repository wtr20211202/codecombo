package system

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// unlockFailNotifyThreshold 连续解锁失败的通知阈值：达到即发一条 warning 通知
// （后续失败只进审计不再重复通知）
const unlockFailNotifyThreshold = 3

// LockHandler 锁定机制 HTTP handler
type LockHandler struct{}

// NewLockHandler 构造
func NewLockHandler() *LockHandler {
	return &LockHandler{}
}

// GetState GET /api/lock/state
// 豁免 LockMiddleware；isDefaultPassword 字段仅对 localhost 返回（避免远程探测）
func (h *LockHandler) GetState(c *gin.Context) {
	cfg := store.Get().Lock.GetConfig()
	state := gin.H{
		"enabled":         cfg.Enabled,
		"autoLockEnabled": cfg.AutoLockEnabled,
		"autoLockMinutes": cfg.AutoLockMinutes,
		"tokenTTLMinutes": cfg.TokenTTLMinutes,
		// 从未初始化配置：前端引导进入「设置密码」流程而非解锁表单
		"needsSetup": !store.Get().Lock.HasConfig(),
		// 服务绑定通配地址（0.0.0.0/::）时局域网来源允许完成首次设密：
		// 设密表单据此显示「可从任意机器经 IP 设密」提示（无头部署关键路径）
		"lanSetupAllowed": serverBoundToWildcard(),
	}
	if isLocalhostRequest(c) {
		state["isDefaultPassword"] = store.Get().Lock.IsDefaultPassword()
	} else {
		state["isDefaultPassword"] = false
	}
	c.JSON(http.StatusOK, state)
}

// SetupRequest 首次设置密码请求体
type SetupRequest struct {
	Password string `json:"password" binding:"required"`
}

// Setup POST /api/lock/setup
// 豁免 LockMiddleware；仅当从未初始化配置时可用（幂等防竞态在 store 层锁内复查）。
// 成功后直接签发 unlock token，前端无缝进入已解锁态。
// 来源限制：默认仅本机回环（设密属于凭证占位操作，防局域网抢设首启/重置密码，
// 安全 backlog A3；忘记密码路径 = 本机 CLI reset-lock）。例外：服务显式绑定
// 通配地址（0.0.0.0/::）时放行局域网设密——通配绑定本身即运维者对局域网开放的
// 有意表达，而无头 Linux 部署没有本机浏览器，首启设密只能经局域网完成
// （此前一刀切回环限制把该场景堵死：报 403 无法继续）。局域网设密与 unlock
// 共用同源限流，并打显著审计日志。
func (h *LockHandler) Setup(c *gin.Context) {
	lanSetup := !isLoopbackRequest(c)
	if lanSetup && !serverBoundToWildcard() {
		c.JSON(http.StatusForbidden, gin.H{"err": "forbidden", "msg": "initial setup is only allowed from localhost (restart with -H 0.0.0.0 to enable first-time setup over LAN)"})
		return
	}
	if store.Get().Lock.HasConfig() {
		c.JSON(http.StatusConflict, gin.H{"err": "alreadyInitialized", "msg": "password already set"})
		return
	}
	if middleware.IsLockUnlockRateLimited(c.ClientIP()) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"err":        "rateLimited",
			"retryAfter": 60,
		})
		return
	}
	var req SetupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "password required"})
		return
	}
	if err := store.Get().Lock.SetupPassword(req.Password); err != nil {
		switch {
		case errors.Is(err, store.ErrAlreadyInitialized):
			c.JSON(http.StatusConflict, gin.H{"err": "alreadyInitialized", "msg": "password already set"})
		case errors.Is(err, store.ErrPasswordEmpty):
			c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "password cannot be empty"})
		default:
			// 透出底层错误（如 permission denied）：部署场景最常见的是数据目录
			// 属主/沙箱/SELinux 拦写，generic "internal" 会让用户无从下手
			slog.Error("lock setup failed", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		}
		return
	}
	token, err := store.Get().Lock.IssueToken()
	if err != nil {
		slog.Error("issue lock token failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal"})
		return
	}
	if lanSetup {
		slog.Warn("lock setup performed from LAN (server bound to wildcard address)", "ip", c.ClientIP())
		// 局域网设密是高价值安全事件（凭证占位），入账审计（Setup 注释既有承诺）
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditLockSetup,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: "LAN initial setup",
		})
	}
	// HttpOnly cookie 载体随设密响应下发（P-20261019-2）：前端不再持有可读副本
	middleware.SetLockTokenCookie(c, token)
	c.JSON(http.StatusOK, gin.H{
		"token":     token,
		"expiresIn": store.Get().Lock.GetConfig().TokenTTLMinutes * 60,
	})
}

// serverBoundToWildcard 服务监听地址是否显式绑定通配（0.0.0.0 / ::）——
// 运维者对局域网开放的有意表达，是首启设密允许局域网来源的依据。
// 空值/未知值按回环默认（127.0.0.1）处理，维持严格限制
func serverBoundToWildcard() bool {
	host := strings.ToLower(strings.TrimSpace(store.Get().Settings.Get().Server.Host))
	return host == "0.0.0.0" || host == "::" || host == "[::]"
}

// UnlockRequest 解锁请求体
type UnlockRequest struct {
	Password string `json:"password" binding:"required"`
}

// Unlock POST /api/lock/unlock
// 豁免 LockMiddleware；密码错误触发 IP 限流，正确密码始终放行
func (h *LockHandler) Unlock(c *gin.Context) {
	var req UnlockRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "password required"})
		return
	}

	if middleware.IsLockUnlockRateLimited(c.ClientIP()) {
		// 限流命中入账（denied）：连发试探的痕迹在审计里必须可见
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditUnlock,
			Result: store.AuditResultDenied,
			IP:     c.ClientIP(),
			Detail: "rate limited",
		})
		c.JSON(http.StatusTooManyRequests, gin.H{
			"err":        "rateLimited",
			"retryAfter": 60,
		})
		return
	}

	if !store.Get().Lock.VerifyPassword(req.Password) {
		fails := middleware.RecordLockUnlockFailure(c.ClientIP())
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditUnlock,
			Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: "wrong password",
		})
		// 连发失败感知入通知中心：失败数达到阈值（3 次）时发一条 warning，
		// 后续失败只进审计不再重复通知（避免通知中心被刷屏）
		if fails == unlockFailNotifyThreshold {
			store.Get().Notification.Add(notification.Notification{
				Type:      "warning",
				Category:  notification.CategorySystem,
				TitleKey:  "audit.notify.unlockFails.title",
				BodyKey:   "audit.notify.unlockFails.body",
				Title:     "检测到连续解锁失败",
				Body:      fmt.Sprintf("%s 连续 %d 次密码错误", c.ClientIP(), fails),
				MsgParams: map[string]any{"ip": c.ClientIP(), "n": fails},
			})
		}
		c.JSON(http.StatusUnauthorized, gin.H{"err": "invalidPassword"})
		return
	}

	token, err := store.Get().Lock.IssueToken()
	if err != nil {
		slog.Error("issue lock token failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal"})
		return
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditUnlock,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})

	// HttpOnly cookie 载体随解锁响应下发（P-20261019-2）：响应体 token 仍保留
	// （CLI/agent 头载体契约不变），浏览器侧改为只依赖 cookie，不再落
	// localStorage/可读 cookie 副本
	middleware.SetLockTokenCookie(c, token)
	c.JSON(http.StatusOK, gin.H{
		"token":     token,
		"expiresIn": store.Get().Lock.GetConfig().TokenTTLMinutes * 60,
	})
}

// Lock POST /api/lock/lock
// 需有效 unlock token；仅撤销当前 token（其他 token 不受影响）。
// token 载体：X-Lock-Token 头优先，缺省回落 sc_lock_token cookie——浏览器侧
// 令牌改 HttpOnly cookie 后（P-20261019-2），刷新过的页面内存无 token，
// 主动锁定只能靠 cookie 定位要撤销的 token；响应同时过期该 cookie
// （HttpOnly 只有服务端清得掉，前端 document.cookie 清除对它无效）
func (h *LockHandler) Lock(c *gin.Context) {
	token := c.GetHeader(middleware.LockHeaderName)
	if token == "" {
		token, _ = c.Cookie(middleware.LockCookieName)
	}
	store.Get().Lock.RevokeToken(token)
	middleware.ClearLockTokenCookie(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetConfig GET /api/lock/config
// 需有效 unlock token（受 LockMiddleware 保护）
func (h *LockHandler) GetConfig(c *gin.Context) {
	cfg := store.Get().Lock.GetConfig()
	c.JSON(http.StatusOK, gin.H{
		"enabled":         cfg.Enabled,
		"autoLockEnabled": cfg.AutoLockEnabled,
		"autoLockMinutes": cfg.AutoLockMinutes,
		"tokenTTLMinutes": cfg.TokenTTLMinutes,
	})
}

// UpdateConfigRequest 更新配置请求体（指针字段实现 partial update）
type UpdateConfigRequest struct {
	Enabled         *bool  `json:"enabled"`
	AutoLockEnabled *bool  `json:"autoLockEnabled"`
	AutoLockMinutes *int   `json:"autoLockMinutes"`
	TokenTTLMinutes *int   `json:"tokenTTLMinutes"`
	CurrentPassword string `json:"currentPassword" binding:"required"`
}

// UpdateConfig PUT /api/lock/config
// 需当前密码确认；关闭锁定功能时联动 RevokeAllTokens
func (h *LockHandler) UpdateConfig(c *gin.Context) {
	var req UpdateConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": err.Error()})
		return
	}

	if !store.Get().Lock.VerifyPassword(req.CurrentPassword) {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditLockConfig,
			Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: "wrong current password",
		})
		c.JSON(http.StatusUnauthorized, gin.H{"err": "invalidPassword"})
		return
	}

	// 输入校验：AutoLockMinutes / TokenTTLMinutes 若提供必须 >= 1（防止 0/负值导致立即过期或除零）
	if req.AutoLockMinutes != nil && *req.AutoLockMinutes < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "autoLockMinutes must be >= 1 minute"})
		return
	}
	if req.TokenTTLMinutes != nil && *req.TokenTTLMinutes < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "tokenTTLMinutes must be >= 1 minute"})
		return
	}

	cfg := store.Get().Lock.GetConfig()
	wasEnabled := cfg.Enabled

	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}
	if req.AutoLockEnabled != nil {
		cfg.AutoLockEnabled = *req.AutoLockEnabled
	}
	if req.AutoLockMinutes != nil {
		cfg.AutoLockMinutes = *req.AutoLockMinutes
	}
	if req.TokenTTLMinutes != nil {
		cfg.TokenTTLMinutes = *req.TokenTTLMinutes
	}

	if err := store.Get().Lock.SaveConfig(cfg); err != nil {
		slog.Error("save lock config failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal"})
		return
	}

	// 关闭锁定功能 → 撤销所有 token，强制全员重认证
	if wasEnabled && !cfg.Enabled {
		store.Get().Lock.RevokeAllTokens()
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditLockConfig,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("enabled=%v autoLock=%v autoLockMinutes=%d tokenTTLMinutes=%d",
			cfg.Enabled, cfg.AutoLockEnabled, cfg.AutoLockMinutes, cfg.TokenTTLMinutes),
	})

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UpdatePasswordRequest 修改密码请求体
type UpdatePasswordRequest struct {
	CurrentPassword string `json:"currentPassword" binding:"required"`
	NewPassword     string `json:"newPassword" binding:"required"`
}

// UpdatePassword PUT /api/lock/password
// store.UpdatePassword 内部联动 RevokeAllTokens
func (h *LockHandler) UpdatePassword(c *gin.Context) {
	var req UpdatePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": err.Error()})
		return
	}

	if err := store.Get().Lock.UpdatePassword(req.CurrentPassword, req.NewPassword); err != nil {
		if errors.Is(err, store.ErrInvalidPassword) {
			middleware.AuditAppend(c, store.AuditEvent{
				Action: store.AuditLockPassword,
				Result: store.AuditResultFailure,
				IP:     c.ClientIP(),
				Detail: "wrong current password",
			})
			c.JSON(http.StatusUnauthorized, gin.H{"err": "invalidPassword"})
			return
		}
		if errors.Is(err, store.ErrPasswordEmpty) {
			c.JSON(http.StatusBadRequest, gin.H{"err": "badRequest", "msg": "password cannot be empty"})
			return
		}
		slog.Error("update lock password failed", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal"})
		return
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditLockPassword,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// isLocalhostRequest 判断是否来自本机/局域网（用于 isDefaultPassword 字段保护）
// 局域网段也视为可信，避免局域网内浏览器看不到默认密码提示
func isLocalhostRequest(c *gin.Context) bool {
	ip := c.ClientIP()
	return ip == "127.0.0.1" || ip == "::1" ||
		strings.HasPrefix(ip, "192.168.") ||
		strings.HasPrefix(ip, "10.")
}

// isLoopbackRequest 严格本机回环判定（设密入口专用）：比 isLocalhostRequest 更严，
// 不放行局域网段——重设密码的合法路径是本机操作（CLI reset-lock 后本机浏览器设密）
func isLoopbackRequest(c *gin.Context) bool {
	ip := c.ClientIP()
	return ip == "127.0.0.1" || ip == "::1"
}
