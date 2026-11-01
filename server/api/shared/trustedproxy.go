package shared

import (
	"net"
	"sync"

	"codecombo/server/config"

	"github.com/gin-gonic/gin"
)

// 可信代理判定（P-20261020-1）：与 gin.Engine.SetTrustedProxies 吃同一份
// server.trustedProxies 清单，供不走 Gin ClientIP 的转发头消费点（当前为
// RequestBaseURL 的 X-Forwarded-Proto/Host）复用，两处信任边界同源。
//
// 进程级状态在启动期由 middleware.ApplyTrustedProxies 一次性写入（配置变更
// 需重启，运行期不再变更）；读路径只做一次 RLock + 网段匹配，请求级开销
// 与条目数线性相关（默认 0 条，反代形态通常 1~2 条）。
var (
	trustedProxyMu  sync.RWMutex
	trustedProxySet *config.TrustedProxySet
)

// SetTrustedProxies 替换进程内可信代理匹配器。校验失败不改变现有状态并
// 返回错误——调用方应显式按「无信任」降级（见 ApplyTrustedProxies）。
func SetTrustedProxies(entries []string) error {
	set, err := config.ParseTrustedProxies(entries)
	if err != nil {
		return err
	}
	trustedProxyMu.Lock()
	trustedProxySet = set
	trustedProxyMu.Unlock()
	return nil
}

// IsTrustedProxyRequest 判断本次请求的直连对端是否属于可信代理。注意语义
// 是「直连对端」而非 ClientIP：只有直连对端是可信代理时，转发头才可采信。
// 未配置（默认）或 RemoteAddr 不可解析时一律 false。
func IsTrustedProxyRequest(c *gin.Context) bool {
	if c == nil || c.Request == nil {
		return false
	}
	trustedProxyMu.RLock()
	set := trustedProxySet
	trustedProxyMu.RUnlock()
	if set == nil || set.Len() == 0 {
		return false
	}
	return set.Trusts(net.ParseIP(c.RemoteIP()))
}
