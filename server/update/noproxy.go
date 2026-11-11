// NO_PROXY 判定（P-20261110-1 S6）：系统探测档「尊重 NO_PROXY」的匹配口。
//
// 为什么要自己判：环境变量档用 http.ProxyFromEnvironment，它对「没有 env 代理」
// 与「目标命中 NO_PROXY」都返回 nil——探测档要区分这两种 nil（前者落到探测档、
// 后者运维已表达直连意图，启发式须让位），只能单独判 NO_PROXY。net/http 内置的
// 匹配器是 vendored 私有副本不可导入，golang.org/x/net 在本仓只是间接依赖——不为
// 一个匹配器升直接依赖，按同一口径独立实现（语义对齐 ProxyFromEnvironment，
// 单测逐形态覆盖）：
//
//   - 逗号分隔，条目去空白、大小写不敏感，空条目忽略；
//   - "*" = 一切目标直连；
//   - CIDR（10.0.0.0/8、fd00::/8）：目标为 IP 且落在网段内；
//   - IP（1.2.3.4、::1）可带端口（1.2.3.4:80、[::1]:443）：目标为同一 IP（端口
//     给出时还须相等）；
//   - 域名 foo.com：匹配 foo.com 本身及全部子域；.foo.com / *.foo.com：只匹配
//     子域；可带端口（foo.com:443）——域名条目不匹配 IP 字面量目标；
//   - 目标 localhost 与回环 IP 恒判直连（ProxyFromEnvironment 同口径）；
//   - 目标端口缺省按 scheme 推断（http 80 / https 443 / socks5 1080）。
//
// 诚实边界：非 ASCII（IDN）条目与目标不做 punycode 归一，按字面比较——更新链
// 目标均为 ASCII 官方域/显式配置的更新源；localhost 判定大小写不敏感。
//
// 环境变量读取时机与 net/http 一致：进程内首次判定时读一次 NO_PROXY（缺省读
// no_proxy）并缓存——与环境变量档（ProxyFromEnvironment 同为进程级一次性快照）
// 口径一致，热路径零 env 读取、零重复解析。
package update

import (
	"net"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
)

// noProxyRule 单条 NO_PROXY 条目的预解析形态
type noProxyRule struct {
	cidr *net.IPNet // 网段条目
	ip   net.IP     // IP 条目
	// suffix 域名条目的「.域名」后缀形态；apex 为 true 时还匹配去点的域名本身
	// （foo.com 形态；.foo.com 与 *.foo.com 只匹配子域）
	suffix string
	apex   bool
	port   string // 条目带端口时目标端口须相等；空 = 任意端口
}

// noProxyList 预解析后的 NO_PROXY 清单；all = 出现过 "*"
type noProxyList struct {
	all   bool
	rules []noProxyRule
}

// parseNoProxy 解析 NO_PROXY 串（尽力而为：畸形条目跳过，不报错——与 net/http
// 同口径，环境变量写错不应阻断更新链）
func parseNoProxy(raw string) noProxyList {
	var l noProxyList
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		if entry == "*" {
			return noProxyList{all: true}
		}
		if _, network, err := net.ParseCIDR(entry); err == nil {
			l.rules = append(l.rules, noProxyRule{cidr: network})
			continue
		}
		host, port := entry, ""
		if h, p, err := net.SplitHostPort(entry); err == nil {
			host, port = h, p
		}
		if host == "" {
			continue // ":80" 之类无主机条目视为畸形
		}
		if ip := net.ParseIP(host); ip != nil {
			l.rules = append(l.rules, noProxyRule{ip: ip, port: port})
			continue
		}
		suffix, apex := host, true
		switch {
		case strings.HasPrefix(suffix, "*."):
			suffix, apex = suffix[1:], false
		case strings.HasPrefix(suffix, "."):
			apex = false
		default:
			suffix = "." + suffix
		}
		l.rules = append(l.rules, noProxyRule{suffix: suffix, apex: apex, port: port})
	}
	return l
}

// match 目标 URL 是否命中（命中 = 应直连、不走代理）
func (l noProxyList) match(u *url.URL) bool {
	if u == nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	port := u.Port()
	if port == "" {
		port = defaultPortForScheme(u.Scheme)
	}
	var ip net.IP
	if a, err := netip.ParseAddr(host); err == nil {
		ip = net.IP(a.AsSlice())
	}
	if host == "localhost" || (ip != nil && ip.IsLoopback()) {
		return true
	}
	if l.all {
		return true
	}
	for _, r := range l.rules {
		switch {
		case r.cidr != nil:
			if ip != nil && r.cidr.Contains(ip) {
				return true
			}
		case r.ip != nil:
			if ip != nil && r.ip.Equal(ip) && (r.port == "" || r.port == port) {
				return true
			}
		default:
			if ip != nil {
				continue // 域名条目不匹配 IP 字面量目标
			}
			if (strings.HasSuffix(host, r.suffix) || (r.apex && host == r.suffix[1:])) &&
				(r.port == "" || r.port == port) {
				return true
			}
		}
	}
	return false
}

// defaultPortForScheme 目标缺省端口（ProxyFromEnvironment 规范地址同口径）
func defaultPortForScheme(scheme string) string {
	switch scheme {
	case "http":
		return "80"
	case "https":
		return "443"
	case "socks5":
		return "1080"
	}
	return ""
}

// envNoProxyList 进程级 NO_PROXY 快照（首次判定时读取，见文件头读取时机）
var envNoProxyList = sync.OnceValue(func() noProxyList {
	raw := os.Getenv("NO_PROXY")
	if raw == "" {
		raw = os.Getenv("no_proxy")
	}
	return parseNoProxy(raw)
})

// noProxyMatchFor 目标是否命中 NO_PROXY 的判定口：生产读进程环境快照；独立变量
// 仅为测试注入（单测不依赖、不改动宿主环境变量）
var noProxyMatchFor = func(u *url.URL) bool {
	return envNoProxyList().match(u)
}
