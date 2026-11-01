// 分享访客面同源入口（P-20261020-2）：主应用把 /s/* 与访客页依赖的
// /assets/<vendored 三件> 以进程内直通方式交给本包的 Service.Handler。
//
// 为什么是进程内直通而不是反代到 127.0.0.1:<sharePort>：
//   - 分享子服务绑定 server.host（默认 127.0.0.1），反代/内置 SSH 隧道只转发
//     主端口时第二端口不可达；同源路径让分享链接只依赖主应用入口；
//   - 进程内直通保留分享服务自身的口令门/响应头/no-store/SSE 语义，不经过
//     额外网络跳与端口绑定假设（host 为局域网地址时回环拨号也不可用）。
//
// 匿名边界：本入口由 api 路由层注册在 LockMiddleware/TokenAuthMiddleware
// 之前（与分享子服务独立监听同一安全语义——token + 可选口令门是唯一门禁）。
// 访客来源 IP 由主应用 Gin 按 server.trustedProxies 解析后经 WithClientIP
// 注入请求上下文，供访问审计与口令门限流使用；直连分享子服务的请求没有该
// 上下文值，仍退回 RemoteAddr（不可伪造）。
package share

import (
	"context"
	"net/http"
	"sync/atomic"
)

// gatewayState 原子持有当前分享服务 Handler（nil = 子服务未就绪）。
// 模块 Start 监听成功后发布、Stop 清除；路由层每请求读取，启动顺序无关。
type gatewayState struct {
	handler http.Handler
}

var gatewayHandler atomic.Pointer[gatewayState]

// SetSameOriginHandler 发布同源访客面 Handler（装配层在子服务监听成功后调用）。
func SetSameOriginHandler(h http.Handler) {
	if h == nil {
		gatewayHandler.Store(nil)
		return
	}
	gatewayHandler.Store(&gatewayState{handler: h})
}

// ClearSameOriginHandler 收回同源入口（子服务停止后调用；nil 安全）。
func ClearSameOriginHandler() {
	gatewayHandler.Store(nil)
}

// SameOriginHandler 读取当前同源访客面 Handler；未就绪返回 nil，由路由层
// 映射 503（前端 meanwhile 显示服务未就绪，不把请求落到 SPA index）。
func SameOriginHandler() http.Handler {
	if s := gatewayHandler.Load(); s != nil {
		return s.handler
	}
	return nil
}

// clientIPKey 同源入口注入的访客来源 IP（仅进程内可写，不来自请求头）。
type clientIPKey struct{}

// WithClientIP 把主应用已按可信代理链解析出的客户端 IP 注入请求上下文。
func WithClientIP(ctx context.Context, ip string) context.Context {
	if ip == "" {
		return ctx
	}
	return context.WithValue(ctx, clientIPKey{}, ip)
}

// clientIPFromContext 读取同源入口注入的客户端 IP。
func clientIPFromContext(ctx context.Context) (string, bool) {
	ip, ok := ctx.Value(clientIPKey{}).(string)
	return ip, ok && ip != ""
}

// ClientIP 返回本次访客请求的归属 IP：同源入口注入值优先，否则回落直连
// 对端。导出版本供路由层集成测试与后续消费点复用，语义与审计/口令限流
// 完全一致（clientIPOf 单一实现）。
func ClientIP(r *http.Request) string { return clientIPOf(r) }
