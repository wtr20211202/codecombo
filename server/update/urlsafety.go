// 更新通道出站安全：
//   - 仅允许 https——更新承载可执行文件，明文 http 可被中间人整体替换
//     （即使有 sha256/签名伴随校验，校验文件同样经该通道拉取）；
//   - 拒绝指向本机/内网/保留地址的更新源（SSRF 面收口）；
//   - 拨号期对 DNS 解析结果复查（防 rebinding：URL 字面量合法但解析到内网）。
package update

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ValidatePublicHTTPSURL 校验更新源 URL：https 且 host 非本机/内网/保留地址
func ValidatePublicHTTPSURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("invalid update url: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("update url must use https, got %q scheme", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("update url missing host")
	}
	if isForbiddenHost(host) {
		return fmt.Errorf("update url host %q is local/private/reserved — not allowed", host)
	}
	return nil
}

// isForbiddenHost 字面量层判断：localhost 族与内网/保留 IP 直接拒绝；
// 域名解析后的 IP 复查在拨号期（防 DNS rebinding）
func isForbiddenHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") {
		return true
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return false // 域名：字面量层放行，解析期复查
	}
	return isForbiddenIP(ip)
}

func isForbiddenIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}

// checkResolvedIPs 拨号期复查：解析出的任一 IP 落在本机/内网/保留段即拒绝
func checkResolvedIPs(host string, addrs []net.IPAddr) error {
	for _, addr := range addrs {
		if isForbiddenIP(addr.IP) {
			return fmt.Errorf("update source %q resolved to local/private/reserved address %s — refusing", host, addr.IP)
		}
	}
	return nil
}

// newSafeTransport 构造带出站守卫的 Transport：
// DialContext 手动解析并复查每个 IP，逐个尝试直连
func newSafeTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	return &http.Transport{
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("resolve update source %q: %w", host, err)
			}
			if err := checkResolvedIPs(host, addrs); err != nil {
				return nil, err
			}
			var lastErr error
			for _, a := range addrs {
				conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(a.IP.String(), port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
			}
			if lastErr == nil {
				lastErr = fmt.Errorf("no usable address for update source %q", host)
			}
			return nil, lastErr
		},
	}
}
