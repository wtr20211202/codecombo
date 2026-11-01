package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// 请求关联 ID（P-20261003-216）：每个 HTTP 请求携带一个短码 request-id，
// 写入 X-Request-Id 响应头 + gin context（gin.Logger 的自定义 formatter 把它
// 追加进访问日志行，slog 落盘可检索）——前端 errorLog 捕获响应头后，跨面排障
// 「这条前端错误对应后端哪条日志」由时间猜测变成 id 精确对齐。
// 生成开销：crypto/rand 8 字节（16 hex 字符），单次 <1µs，相对每请求的
// 路由/handler 成本可忽略；16 hex=64bit，日请求量 10 万级碰撞概率 ~1e-10。

// HeaderXRequestID 请求关联 ID 的 HTTP 头（请求面透传 + 响应面回执同一名）
const HeaderXRequestID = "X-Request-Id"

// GinKeyRequestID gin context 键（c.Set/c.GetString；gin.Logger 的 formatter
// 经 param.Keys 读取，见 app.go 的访问日志 formatter）
const GinKeyRequestID = "scRequestId"

// ctxKeyRequestID 请求上下文键（私有类型防跨包取值）
type ctxKeyRequestID struct{}

// requestIDRe 合法 request-id 形态：字母数字 + - _，8~64 字符。
// 客户端（上游代理链）带来的 id 沿用前先校验——非法值（超长/控制字符/引号）
// 直接丢弃重新生成，防日志注入与日志行撑爆
var requestIDRe = regexp.MustCompile(`^[0-9A-Za-z_-]{8,64}$`)

// RequestID 请求关联 ID 中间件。注册在路由引擎全局第一顺位（router.go），
// 保证后续任何中间件 abort（423/401）或 handler panic 恢复的响应都带头。
// 请求面：上游已带合法 X-Request-Id 时沿用（代理链两端口径一致），否则新生成
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderXRequestID)
		if !requestIDRe.MatchString(id) {
			id = NewRequestID()
		}
		c.Set(GinKeyRequestID, id)
		c.Writer.Header().Set(HeaderXRequestID, id)
		// 同时注入请求上下文：不依赖 gin 的调用方（如未来非 gin 面的
		// slog 输出）可经 RequestIDFromContext 取到同值
		c.Request = c.Request.WithContext(
			context.WithValue(c.Request.Context(), ctxKeyRequestID{}, id))
		c.Next()
	}
}

// RequestIDFromGin 取当前请求的关联 ID（中间件未挂载时返回空串）
func RequestIDFromGin(c *gin.Context) string {
	id, _ := c.Get(GinKeyRequestID)
	s, _ := id.(string)
	return s
}

// RequestIDFromContext 从标准库请求上下文取关联 ID
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(ctxKeyRequestID{}).(string)
	return id
}

// NewRequestID 生成短码关联 ID：crypto/rand 8 字节 hex（16 字符）。
// 熵源故障（极罕见）退化纳秒时间戳 base36——id 可用性优先于不可预测性
func NewRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}
