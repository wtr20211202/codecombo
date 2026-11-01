package config

import (
	"fmt"
	"net"
	"strings"
)

// 可信反向代理清单（P-20261020-1）。
//
// 背景：Gin 默认 trustedProxies = ["0.0.0.0/0","::/0"]（信任所有直连对端，
// 会采信 X-Forwarded-For / X-Real-IP）。产品此前未调用 SetTrustedProxies，
// 直连形态下任意客户端伪造 XFF 即可绕过「每 IP 每分钟 10 次失败」的解锁
// 限流、并污染审计 IP。本清单默认空 = 不信任任何转发头（ClientIP 回落
// RemoteAddr）；反代部署显式配置回环地址后，仅来自这些代理的转发头被采信。
//
// 同一份清单同时供 gin.Engine.SetTrustedProxies（ClientIP 口径）与
// shared.RequestBaseURL（X-Forwarded-Proto/Host 口径）使用，避免两处信任
// 边界漂移。

// MaxTrustedProxies 清单条目上限：条目是启动/设置读写的低频配置，上限只为
// 防误配/恶意膨胀撑大匹配循环，不构成正常使用约束
const MaxTrustedProxies = 32

// MaxTrustedProxyEntryLength 单条目长度上限（IPv6 CIDR 最长 43 字节，留余量）
const MaxTrustedProxyEntryLength = 64

// TrustedProxySet 编译后的可信代理匹配器。nil 接收者/空集合一律不匹配
// （安全默认：不信任任何转发头）。
type TrustedProxySet struct {
	nets []*net.IPNet
}

// NormalizeTrustedProxies 校验并归一可信代理清单（写路径与启动期共用）：
// 去首尾空白、丢空条目、去重、逐条校验 IP/CIDR、条数与长度上限。返回值
// 保留用户输入的可读形态（127.0.0.1 不补 /32），空列表返回非 nil 空切片
// （调用方据此区分「显式空」与「缺省」，两者在信任语义上等价）。
func NormalizeTrustedProxies(entries []string) ([]string, error) {
	out := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, raw := range entries {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		if len(v) > MaxTrustedProxyEntryLength {
			return nil, fmt.Errorf("trusted proxy entry too long (max %d bytes): %q", MaxTrustedProxyEntryLength, v)
		}
		if _, err := parseTrustedProxyEntry(v); err != nil {
			return nil, err
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
		if len(out) > MaxTrustedProxies {
			return nil, fmt.Errorf("too many trusted proxies (max %d)", MaxTrustedProxies)
		}
	}
	return out, nil
}

// ParseTrustedProxies 把清单编译为匹配器。校验失败返回错误——调用方必须
// 按「不信任任何转发头」降级（安全失败），不得跳过校验继续用原始条目。
func ParseTrustedProxies(entries []string) (*TrustedProxySet, error) {
	normalized, err := NormalizeTrustedProxies(entries)
	if err != nil {
		return nil, err
	}
	set := &TrustedProxySet{nets: make([]*net.IPNet, 0, len(normalized))}
	for _, entry := range normalized {
		n, err := parseTrustedProxyEntry(entry)
		if err != nil {
			return nil, err
		}
		set.nets = append(set.nets, n)
	}
	return set, nil
}

// Trusts 判断直连对端 IP 是否属于可信代理。nil 接收者 = 无信任。
func (s *TrustedProxySet) Trusts(ip net.IP) bool {
	if s == nil || ip == nil {
		return false
	}
	for _, n := range s.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Len 清单条目数（状态/日志展示用）
func (s *TrustedProxySet) Len() int {
	if s == nil {
		return 0
	}
	return len(s.nets)
}

// parseTrustedProxyEntry 解析单条 IP 或 CIDR。裸 IP 归一为单主机网段；
// IPv4-mapped IPv6（::ffff:127.0.0.1）按 IPv4 处理，与 net.ParseIP 的
// To4 语义一致。
func parseTrustedProxyEntry(entry string) (*net.IPNet, error) {
	if strings.Contains(entry, "/") {
		_, network, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q: %w", entry, err)
		}
		return network, nil
	}
	ip := net.ParseIP(entry)
	if ip == nil {
		return nil, fmt.Errorf("invalid trusted proxy IP %q", entry)
	}
	if v4 := ip.To4(); v4 != nil {
		return &net.IPNet{IP: v4, Mask: net.CIDRMask(32, 32)}, nil
	}
	return &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)}, nil
}
