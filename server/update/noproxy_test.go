package update

import (
	"net"
	"net/netip"
	"net/url"
	"testing"
)

// NO_PROXY 匹配口径单测（P-20261110-1 S6）：域后缀/顶域/通配/IP/CIDR/端口/星号/
// localhost 各形态按 ProxyFromEnvironment（net/http 内置匹配器）口径逐一钉死——
// 探测档据此让位直连；解析容错（畸形条目跳过不报错）同口径
func TestParseNoProxyMatch(t *testing.T) {
	u := func(raw string) *url.URL { return mustParseRaw(t, raw) }

	cases := []struct {
		name string
		list noProxyList
		url  string
		want bool
	}{
		// 域名条目：匹配自身与全部子域
		{"domain apex", parseNoProxy("foo.com"), "https://foo.com/x", true},
		{"domain subdomain", parseNoProxy("foo.com"), "https://api.foo.com/x", true},
		{"domain deep subdomain", parseNoProxy("foo.com"), "https://a.b.foo.com/x", true},
		{"domain unrelated", parseNoProxy("foo.com"), "https://notfoo.com/x", false},
		{"domain suffix trick", parseNoProxy("foo.com"), "https://evilsfoo.com/x", false},
		// .domain / *.domain：只匹配子域
		{"dot domain sub only", parseNoProxy(".foo.com"), "https://api.foo.com/x", true},
		{"dot domain apex excluded", parseNoProxy(".foo.com"), "https://foo.com/x", false},
		{"star domain sub only", parseNoProxy("*.foo.com"), "https://api.foo.com/x", true},
		{"star domain apex excluded", parseNoProxy("*.foo.com"), "https://foo.com/x", false},
		// 端口形态：条目带端口时目标端口须相等（缺省端口按 scheme 推断）
		{"domain with port match", parseNoProxy("foo.com:443"), "https://foo.com/x", true},
		{"domain with port mismatch", parseNoProxy("foo.com:443"), "https://foo.com:8443/x", false},
		{"domain default port inferred", parseNoProxy("foo.com:80"), "http://foo.com/x", true},
		{"domain any port", parseNoProxy("foo.com"), "https://foo.com:8443/x", true},
		// IP 条目
		{"ip exact", parseNoProxy("1.2.3.4"), "https://1.2.3.4/x", true},
		{"ip other", parseNoProxy("1.2.3.4"), "https://1.2.3.5/x", false},
		{"ip with port match", parseNoProxy("1.2.3.4:443"), "https://1.2.3.4/x", true},
		{"ip with port mismatch", parseNoProxy("1.2.3.4:80"), "https://1.2.3.4/x", false},
		{"ip literal vs domain entry", parseNoProxy("foo.com"), "https://1.2.3.4/x", false},
		{"ipv6", parseNoProxy("::1"), "https://[::1]:8443/x", true},
		// CIDR 条目
		{"cidr v4 hit", parseNoProxy("10.0.0.0/8"), "https://10.1.2.3/x", true},
		{"cidr v4 miss", parseNoProxy("10.0.0.0/8"), "https://11.1.2.3/x", false},
		{"cidr v6 hit", parseNoProxy("fd00::/8"), "https://[fd00::1]/x", true},
		{"cidr vs domain", parseNoProxy("10.0.0.0/8"), "https://foo.com/x", false},
		// 星号：一切目标直连
		{"star all", parseNoProxy("*"), "https://github.com/x", true},
		// localhost 族恒直连（条目不写也一样）
		{"localhost implicit", parseNoProxy(""), "https://localhost:9999/x", true},
		{"localhost listed", parseNoProxy("github.com"), "http://localhost/x", true},
		{"loopback implicit", parseNoProxy(""), "https://127.0.0.1:8080/x", true},
		{"loopback ipv6 implicit", parseNoProxy(""), "https://[::1]:8080/x", true},
		{"localhost subdomain not exempt", parseNoProxy(""), "https://api.localhost/x", false},
		// 大小写与空白
		{"case insensitive entry", parseNoProxy("  FOO.COM "), "https://foo.com/x", true},
		{"case insensitive host", parseNoProxy("foo.com"), "https://FOO.com/x", true},
		{"empty entries skipped", parseNoProxy(" ,, foo.com ,"), "https://foo.com/x", true},
		// 多条目任一命中
		{"multi entry any hit", parseNoProxy("a.com, foo.com:443, b.com"), "https://foo.com/x", true},
		// 畸形容错：不报错、不误伤其余条目
		{"malformed entries skipped", parseNoProxy(":::bad, [::], foo.com"), "https://foo.com/x", true},
		{"empty list", parseNoProxy(""), "https://github.com/x", false},
	}
	for _, c := range cases {
		if got := c.list.match(u(c.url)); got != c.want {
			t.Errorf("%s: match(%s) = %v, want %v", c.name, c.url, got, c.want)
		}
	}

	// CIDR 解析正确性（net.ParseCIDR 网段成员判定抽查）
	l := parseNoProxy("10.0.0.0/8")
	ip := net.IP(netip.MustParseAddr("10.255.0.1").AsSlice())
	if !l.rules[0].cidr.Contains(ip) {
		t.Fatal("cidr 10.0.0.0/8 must contain 10.255.0.1")
	}
}

// noProxyMatchFor 缺省实现读进程环境快照（sync.OnceValue）：此处只钉「不 panic、
// 返回布尔」，不读宿主真实 NO_PROXY（断言不得依赖宿主环境）——各形态判定由上方
// parseNoProxy/match 表驱动覆盖
func TestEnvNoProxyListDefault(t *testing.T) {
	l := envNoProxyList()
	_ = l.match(mustParseRaw(t, "https://github.com/x"))
}
