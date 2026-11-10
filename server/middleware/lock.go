package middleware

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"codecombo/server/api/shared"
	"codecombo/server/store"
)

// LockHeaderName unlock token 的独立请求头
// 与 Authorization: Bearer sc_xxx（access token）独立，避免混淆
const LockHeaderName = "X-Lock-Token"

// LockCookieName 解锁 token 的浏览器 cookie 载体名。
// iframe 导航与 iframe 内第三方 WS（如端口预览透传的 Vite HMR）无法携带
// X-Lock-Token 头或 Sec-WebSocket-Protocol 子协议——cookie 是同一 token 在
// 这类请求上的唯一可达载体。P-20261019-2 起由服务端在解锁/设密成功响应上
// 以 Set-Cookie 下发（HttpOnly + SameSite=Strict，见 SetLockTokenCookie），
// 前端只作锁定时尽力清除遗留的非 HttpOnly 旧 cookie；服务端仅作校验回退：
// 校验器与头载体同一套（ValidateToken/AgentToken.Validate），不新增信任边界，
// token 失效即失效。不入 query：gin 访问日志会落完整 URL（与 remotehost
// export 口令不走 query 同一考量）。
const LockCookieName = "sc_lock_token"

// LockCookieMaxAge cookie 载体的 Max-Age（30 天）：远大于 token 自身滑动 TTL
// （默认 120min）——cookie 只是载体不是会话期限，过期与否由服务端逐请求校验
// token 决定；Max-Age 过短反而会在长闲置后丢载体，迫使用户重新输密
const LockCookieMaxAge = 60 * 60 * 24 * 30

// requestIsHTTPS 请求是否走 HTTPS（TLS 直连或反代终止 TLS 后的
// X-Forwarded-Proto 声明）。Secure 属性据此按 scheme 下发——HTTP 部署追加
// Secure 会被浏览器拒绝写入，明文本地部署将无法解锁（P-20261020-1 前端侧
// 同款判定的服务端等价物）。伪造 X-Forwarded-Proto 的最坏影响是 fail-closed
// （明文请求拿到带 Secure 的 cookie 被浏览器丢弃 → 需重新解锁），不会扩大暴露面
func requestIsHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// SetLockTokenCookie 在响应上以 HttpOnly 下发解锁 token cookie（P-20261019-2）：
// 同主机任意端口的页面 JS（dsh 控制台/端口预览等独立端口 UI）读不到
// document.cookie 里的令牌——cookie 按主机隔离不按端口隔离，此前前端
// document.cookie 写入形态可被任意同主机页面读取，令牌可被窃取后离线重放。
// SameSite=Strict 防跨站自动携带；Path=/ 覆盖 /api /ws /preview /proxy 全部
// 锁保护前缀。属性与前端遗留清除串（web/src/utils/lockCookie）同域同 Path，
// 服务端下发的 HttpOnly cookie 可正常覆盖同名非 HttpOnly 旧 cookie
func SetLockTokenCookie(c *gin.Context, token string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     LockCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   LockCookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   requestIsHTTPS(c.Request),
	})
}

// ClearLockTokenCookie 过期同属性 cookie。HttpOnly cookie 无法经
// document.cookie 清除，锁定/撤销路径必须由服务端下发清除：
//   - POST /lock/lock 主动锁定（响应侧）；
//   - lockAuth 的 423 拒绝（token 失效/过期/被 RevokeAllTokens）——浏览器
//     持失效 cookie 反复发送只会持续 423，响应侧顺手清掉可终结该循环。
func ClearLockTokenCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     LockCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   requestIsHTTPS(c.Request),
	})
}

// LockMiddleware 校验 unlock token
//   - 锁定功能关闭 → 放行
//   - 携带有效 access token（Bearer sc_，机器间调用）→ 放行——远程实例锁定时，
//     持有效 token 的代理/中心实例仍可访问 API（与 /proxy/* 豁免同一信任语义）
//   - X-Lock-Token 缺失/无效 → 423 Locked
//   - 有效 → 滑动续期（ValidateToken 内部更新 LastSeen）
func LockMiddleware() gin.HandlerFunc {
	return lockAuth(false)
}

// LockMiddlewareWithCookie 锁中间件的通用形态：头/子协议之外额外接受 cookie
// 载体的解锁 token。P-20261019-2 起浏览器侧令牌改 HttpOnly cookie 载体
// （localStorage 停写），/api /proxy /preview /metrics 全部锁保护组挂本形态——
// 刷新后的页面内存无 token，同源请求只剩浏览器自动携带的 cookie 可用。
// 头载体优先：X-Lock-Token 存在（即便无效）时 cookie 不参与判定——被显式
// 拒绝过的头不能靠 cookie「复活」（与 lock_test.go 头优先既有语义一致）
func LockMiddlewareWithCookie() gin.HandlerFunc {
	return lockAuth(true)
}

func lockAuth(allowCookie bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		lock := store.Get().Lock
		cfg := lock.GetConfig()
		if !cfg.Enabled {
			// 从未初始化配置（首次安装/被 reset-lock 清除）：API 全量 423，
			// 仅 lock 公开组（state/unlock/setup）可达，强制先完成密码设置
			if !lock.HasConfig() {
				ClearLockTokenCookie(c)
				c.AbortWithStatusJSON(http.StatusLocked, gin.H{
					"err": "locked",
					"msg": "initial password setup required",
				})
				return
			}
			c.Next()
			return
		}

		if hasValidAccessToken(c) {
			c.Next()
			return
		}

		token := c.GetHeader(LockHeaderName)
		if token == "" && allowCookie {
			token, _ = c.Cookie(LockCookieName)
		}
		if token == "" || !(lock.ValidateToken(token) || store.Get().AgentToken.Validate(token)) {
			// 拒绝顺手清 cookie：失效 token 的载体留在浏览器只会反复 423
			//（HttpOnly 只有服务端清得掉，见 ClearLockTokenCookie 注）
			ClearLockTokenCookie(c)
			c.AbortWithStatusJSON(http.StatusLocked, gin.H{
				"err": "locked",
				"msg": "system is locked, please unlock",
			})
			return
		}
		c.Next()
	}
}

// ExtractLockToken 从 HTTP 请求中提取 unlock token（WS 握手期共用）
// 优先级：X-Lock-Token 头 > Sec-WebSocket-Protocol 子协议（浏览器 new WebSocket(url, [token])）
// > sc_lock_token cookie（P-20261019-2：前端令牌改 HttpOnly cookie 载体后，
// 刷新页面的内存无 token，业务 WS 握手只剩浏览器自动携带的同源 cookie 可用；
// 跨站 WS 握手被升级器 SameOrigin 拒绝 + cookie SameSite=Strict 双防劫持）
func ExtractLockToken(r *http.Request) string {
	if t := r.Header.Get(LockHeaderName); t != "" {
		return t
	}
	// 浏览器 new WebSocket(url, [token]) 会通过 Sec-WebSocket-Protocol 发送
	for _, p := range r.Header.Values("Sec-WebSocket-Protocol") {
		// 一个 header value 内可能含多个逗号分隔协议
		for _, proto := range strings.Split(p, ",") {
			proto = strings.TrimSpace(proto)
			// scl_ 解锁 token / sca_ 智能体令牌均可经子协议传递
			if strings.HasPrefix(proto, "scl_") || strings.HasPrefix(proto, "sca_") {
				return proto
			}
		}
	}
	if ck, err := r.Cookie(LockCookieName); err == nil {
		return ck.Value
	}
	return ""
}

// ValidateLockCredential 通用锁凭据校验：HTTP 请求是否携带可用解锁凭据，
// 返回 (token, ok)。校验器与载体与 lockAuth / WS 握手完全同一套，不新增
// 信任边界：
//   - 锁关闭且已有配置 → ("", true)（全应用开放，与 LockMiddleware 放行同语义）
//   - 无配置（首次安装 / reset-lock 后）→ false（强制先设密）
//   - 持有效 access token（Bearer sc_）→ ("", true)（机器间调用）
//   - 头/子协议/cookie 载体（ExtractLockToken）的解锁 token 或智能体令牌
//     任一有效 → (token, true)（解锁 token 随校验滑动续期）
//
// 消费方：WS 握手（ValidateLockTokenForWS）与 /api/restart 非回环请求授权
// （P-20261109-11，Restart 不入锁保护组——锁定态也要能重启（A8），回环之外
// 凭本函数放行）——新增授权面须复用本函数，不另写校验器
func ValidateLockCredential(r *http.Request) (string, bool) {
	lock := store.Get().Lock
	cfg := lock.GetConfig()
	if !cfg.Enabled {
		// 与 LockMiddleware 同语义：从未初始化配置时不放行（强制先设密）
		if !lock.HasConfig() {
			return "", false
		}
		// 锁定功能关闭，放行（无 token）
		return "", true
	}
	// 与 HTTP LockMiddleware 同语义：持有效 access token（Bearer sc_）的机器间调用放行。
	// 远程实例锁定时，本机代理（/ws/proxy/* 自动注入实例 token）仍可建立业务 WS，
	// 否则远程的文件监听/通知/终端 WS 在远程锁定态会被握手期 423 全部拒绝，
	// 与 HTTP API（LockMiddleware 认 access token）行为不一致
	if hasValidAccessTokenRequest(r) {
		return "", true
	}
	token := ExtractLockToken(r)
	if token == "" {
		return "", false
	}
	// 解锁 token（滑动续期）或智能体令牌（sca_，长效）任一有效即放行
	if !lock.ValidateToken(token) && !store.Get().AgentToken.Validate(token) {
		return "", false
	}
	return token, true
}

// ValidateLockTokenForWS WS 握手期校验，返回 token 与是否有效
// （ValidateLockCredential 的 WS 消费别名——语义由后者单点承载）
func ValidateLockTokenForWS(r *http.Request) (string, bool) {
	return ValidateLockCredential(r)
}

// ── unlock 接口 IP 限流 ──

// lockUnlockFailure 单个 IP 的失败计数
type lockUnlockFailure struct {
	count       int
	windowStart time.Time
	blockUntil  time.Time
}

const (
	// lockUnlockMaxFails 每分钟最多失败次数
	lockUnlockMaxFails = 10
	// lockUnlockWindow 滚动窗口（1 分钟）
	lockUnlockWindow = time.Minute
	// lockUnlockBlockTime 触发后封禁时长
	lockUnlockBlockTime = 60 * time.Second
)

// lockUnlockFailures IP 限流计数（仅 unlock 接口）
// 策略：仅错误密码计数，正确密码始终放行（spec 6.3A）
var lockUnlockFailures = struct {
	sync.Mutex
	m map[string]*lockUnlockFailure
}{m: make(map[string]*lockUnlockFailure)}

// gcExpiredFailures 惰性清理已过期条目，防止长时间运行后 map 无限增长
// 清理规则：blockUntil 已过 + windowStart 超过 2 倍窗口（即 2 分钟内无任何失败）
// 调用方必须持有锁
func gcExpiredFailures(now time.Time) {
	gcThreshold := now.Add(-2 * lockUnlockWindow)
	for ip, f := range lockUnlockFailures.m {
		// 同时满足：封禁期已过 + 计数窗口超过阈值
		if now.After(f.blockUntil) && f.windowStart.Before(gcThreshold) {
			delete(lockUnlockFailures.m, ip)
		}
	}
}

// IsLockUnlockRateLimited 判断 IP 是否被封禁
func IsLockUnlockRateLimited(ip string) bool {
	lockUnlockFailures.Lock()
	defer lockUnlockFailures.Unlock()
	now := time.Now()
	// 惰性 GC：每次访问都触发一次清理，避免内存泄漏
	gcExpiredFailures(now)
	f, ok := lockUnlockFailures.m[ip]
	if !ok {
		return false
	}
	return now.Before(f.blockUntil)
}

// RecordLockUnlockFailure 记录一次失败，达阈值后封禁 60s。
// 返回该 IP 当前窗口内的累计失败数（审计/通知消费：连发失败感知需要计数）
//
// 关键安全约束：封禁期间（blockUntil 未过）禁止重置 windowStart/count，
// 否则攻击者只需等到窗口过期（60s）再失败一次即可让 count 归 1 绕过封禁。
// 只有封禁期 AND 滑动窗口都已过期，才允许开新一轮计数。
func RecordLockUnlockFailure(ip string) int {
	lockUnlockFailures.Lock()
	defer lockUnlockFailures.Unlock()
	now := time.Now()
	// 惰性 GC：清理已过期条目
	gcExpiredFailures(now)
	f, ok := lockUnlockFailures.m[ip]
	if !ok {
		lockUnlockFailures.m[ip] = &lockUnlockFailure{
			count:       1,
			windowStart: now,
		}
		return 1
	}

	blocked := now.Before(f.blockUntil)
	windowExpired := now.Sub(f.windowStart) > lockUnlockWindow

	// 封禁期未过：绝不重置 count；窗口若过期则只换窗口起点，保留累计计数
	//   → 阻止攻击者通过等待窗口过期来绕过封禁
	// 封禁期已过 + 窗口已过期：全新一轮
	// 封禁期已过 + 窗口未过期：同窗口继续累加（短时间反复失败仍要触发封禁）
	switch {
	case blocked && windowExpired:
		// 封禁期内窗口过期：换窗口起点，保留 count（仍处于封禁中）
		f.windowStart = now
		f.count++
	case !blocked && windowExpired:
		// 全新一轮：封禁期 + 窗口都过期
		f.count = 1
		f.windowStart = now
		f.blockUntil = time.Time{}
	default:
		// 同窗口内累加
		f.count++
	}

	if f.count >= lockUnlockMaxFails {
		f.blockUntil = now.Add(lockUnlockBlockTime)
	}
	return f.count
}

// ResetLockUnlockRateLimitForTesting 测试专用：清空限流计数（避免用例间相互影响）
func ResetLockUnlockRateLimitForTesting() {
	lockUnlockFailures.Lock()
	defer lockUnlockFailures.Unlock()
	lockUnlockFailures.m = make(map[string]*lockUnlockFailure)
}

// LockUnlockFailureSnapshot 解锁限流计数的只读聚合快照（P-20261004-11 入口面
// 总览消费）：返回（跟踪中的来源 IP 数，窗口累计失败次数，当前被封禁 IP 数）。
// 只出聚合计数，不回显 IP 明细——IP 维度的审计轨迹走审计分区既有查询面。
// 存储口径：计数是本进程内存态（重启清零），消费方须如实注记该语义
func LockUnlockFailureSnapshot() (trackedIPs, totalFails, blockedIPs int) {
	lockUnlockFailures.Lock()
	defer lockUnlockFailures.Unlock()
	now := time.Now()
	// 快照走同一条惰性 GC 路径：过期条目不进聚合，总览不展示陈旧失败
	gcExpiredFailures(now)
	for _, f := range lockUnlockFailures.m {
		trackedIPs++
		totalFails += f.count
		if now.Before(f.blockUntil) {
			blockedIPs++
		}
	}
	return
}

// CloseCodeLockRejected 应用自定义 WS 关闭码（4000-4999 为应用保留段）：
// 握手期直接回 HTTP 423 时浏览器无法读到状态码（onerror/onclose 一律 1006），
// 客户端区分不了「token 失效」与「网络故障」，只能用失效 token 无限重连——
// 先升级再以 4001 关闭，浏览器 event.code === 4001 可确定性识别锁定拒绝，
// 前端据此清 token 切锁定屏（与 HTTP 423 拦截器同语义）
const CloseCodeLockRejected = 4001

// wsAuthUpgrader 握手拒绝路径专用：先完成升级才能给浏览器送达关闭帧。
// 统一工厂默认档（SameOrigin 与业务 WSUpgrader 一致，防跨站劫持语义不变；
// 不启用压缩——仅送达关闭帧无数据面）
var wsAuthUpgrader = shared.WSUpgrade()

// rejectWSWithCloseCode 升级后立即以 4001 关闭。升级失败（非法握手）时
// 响应已由 upgrader 写出，静默返回即可
func rejectWSWithCloseCode(c *gin.Context) {
	conn, err := wsAuthUpgrader.Upgrade(c.Writer, c.Request, shared.EchoSubprotocols(c.Request))
	if err != nil {
		return
	}
	// 读帧上限防线（P-20261003-313）：本路径只写关闭帧不读消息，上限纯为
	// 「升级器不裸奔」的统一约定——未来若出现读路径不致漏设
	conn.SetReadLimit(shared.WSReadLimitInput)
	msg := websocket.FormatCloseMessage(CloseCodeLockRejected, "lock token invalid")
	_ = conn.WriteControl(websocket.CloseMessage, msg, time.Now().Add(2*time.Second))
	_ = conn.Close()
}

// StartLockTokenTouchLoop 活连接续期：handler 存续期间周期性滑动 unlock token 的
// LastSeen。此前仅 HTTP 请求续期——终端/长克隆/AI 流这类纯 WS 会话期间无 HTTP
// 流量，TTL（默认 120min）一到 token 被清理并强制断开其名下全部 WS，
// 表现为「用着用着突然没进度/终端断开」。活连接即活跃会话，续期至断开为止；
// 前端闲置自动锁定（autoLock）仍由浏览器侧计时器负责，安全语义不变
func StartLockTokenTouchLoop(token string) (stop func()) {
	if token == "" {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		for {
			timer := time.NewTimer(touchInterval())
			select {
			case <-done:
				timer.Stop()
				return
			case <-timer.C:
				// store 可能在进程收尾/测试清理时已置空：续期是尽力而为，不恐慌
				if st := store.Get(); st != nil && st.Lock != nil {
					st.Lock.TouchToken(token)
				}
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// touchInterval 续期间隔 = TTL/4，钳位 [2s, 30s]：TTL 允许配置到 1 分钟，
// 间隔必须远小于 TTL 才能保证任意时刻连续 touch 不漏档
func touchInterval() time.Duration {
	mins := 0
	if st := store.Get(); st != nil && st.Lock != nil {
		mins = st.Lock.GetConfig().TokenTTLMinutes
	}
	if mins <= 0 {
		mins = 120
	}
	d := time.Duration(mins) * time.Minute / 4
	if d < 2*time.Second {
		d = 2 * time.Second
	}
	if d > 30*time.Second {
		d = 30 * time.Second
	}
	return d
}

// WithWSLockAuth 包装 WebSocket handler，在 upgrade 前校验 unlock token
//   - 锁定功能关闭 → 直接调 handler
//   - 握手期 token 缺失/无效 → 升级后以 4001 关闭（见 CloseCodeLockRejected）
//
// closer 注册（用于 RevokeToken 时主动断开 WS）需在各 WS handler 内部完成：
// 拿到 conn 后 RegisterWSConn(token, func(){ conn.Close() })，defer UnregisterWSConn。
//
// 注意：closer 函数内部不能再调 lockStore 的方法，否则会重入死锁。
func WithWSLockAuth(handler gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, ok := ValidateLockTokenForWS(c.Request)
		if !ok {
			rejectWSWithCloseCode(c)
			return
		}
		// 活连接续期：handler 返回（连接关闭）即停止
		stopTouch := StartLockTokenTouchLoop(token)
		defer stopTouch()
		handler(c)
	}
}
