// 更新通道出站安全：
//   - 仅允许 https——更新承载可执行文件，明文 http 可被中间人整体替换
//     （即使有 sha256/签名伴随校验，校验文件同样经该通道拉取）；
//   - 拒绝指向本机/内网/保留地址的更新源（SSRF 面收口）；
//   - 拨号期对 DNS 解析结果复查（防 rebinding：URL 字面量合法但解析到内网）；
//   - 出站路径三态（P-20261109-12）：显式设置代理 > 环境变量代理（HTTPS_PROXY/
//     HTTP_PROXY/NO_PROXY 业界事实标准，服务器 systemd unit 设 env 即生效）
//     > 直连守卫。历史缺口：newSafeTransport 自定义 DialContext 无 Proxy 字段，
//     Go 不读任何代理环境变量，CN 网络直连 github.com 阵发失败只能靠重试。
//
// 走代理后目标由代理解析，直连 IP 守卫语义失效——代理路径的 SSRF 防线降级为
// 官方可信域白名单（∪ 显式配置的更新源 host），逐跳校验（含重定向）。
package update

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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

// newSafeTransport 直连档 Transport：DialContext 手动解析并复查每个 IP，逐个
// 尝试直连（多 IP 逐试语义）。刻意不设 Proxy 字段——本档只承载已被选路层裁决
// 为「直连」的请求（无代理可配 / 显式代理缺省且环境变量未命中 / NO_PROXY 豁免），
// 环境代理的读取在 safeRoundTripper 选路层完成
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

// directTransport 直连档单例（不可变配置，全进程共享）
var directTransport = newSafeTransport()

// ── 出站代理装配态（P-20261109-12）─────────────────────────────────────────

// outboundState 更新链出站配置快照。proxy 为 nil 时走环境变量感知层；
// sourceHost 是当前更新源 host（显式配置它本身就是信任决定，进代理白名单——
// 自建镜像/Gitea 源不被官方域白名单误伤）
type outboundState struct {
	proxy      *url.URL
	sourceHost string
}

// outbound 单点装配（ApplySource 启动/设置保存调用），每请求原子现读——
// 设置保存即生效，无须重建任何 http.Client
var outbound atomic.Pointer[outboundState]

// envProxyFor 环境变量代理探询口：默认 http.ProxyFromEnvironment（HTTPS_PROXY/
// HTTP_PROXY/NO_PROXY 标准语义，含小写变体与端口推断）。独立变量仅为测试注入，
// 生产语义与 net/http 完全一致
var envProxyFor = func(u *url.URL) (*url.URL, error) {
	return http.ProxyFromEnvironment(&http.Request{URL: u})
}

// safeRoundTripper 按请求 URL 现选出站路径的 RoundTripper（显式代理 / 环境代理 /
// 直连三态）。http.Client 的每个重定向跳都会重新进入 RoundTrip，因此选路+守卫
// 是逐跳的：代理模式下重定向到非可信域被拒，直连模式下被拨号期 IP 守卫拦截
type safeRoundTripper struct{}

func (safeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt, err := roundTripperFor(req.URL)
	if err != nil {
		return nil, err
	}
	return rt.RoundTrip(req)
}

// roundTripperFor 单请求出站选路（守卫单点）：
//   - 显式设置代理：对更新链全量生效（不解读 NO_PROXY——那是环境变量层的语义，
//     想对部分目标直连的用户应清空设置项改走 env 层），目标过域白名单；
//   - 无显式：探询环境变量（ProxyFromEnvironment 同款逐 host 裁决），命中即
//     走代理档（同过白名单），未命中/NO_PROXY 豁免走直连档（IP 守卫保持）；
//   - 两层皆无代理：直连档，行为与历史版本逐字节一致（零变化验收）。
func roundTripperFor(u *url.URL) (http.RoundTripper, error) {
	if st := outbound.Load(); st != nil && st.proxy != nil {
		if err := checkProxyTargetHost(u); err != nil {
			return nil, err
		}
		return proxyTransportFor(st.proxy), nil
	}
	p, err := envProxyFor(u)
	if err != nil {
		return nil, err
	}
	if p != nil {
		if err := checkProxyTargetHost(u); err != nil {
			return nil, err
		}
		return proxyTransportFor(p), nil
	}
	return directTransport, nil
}

// ── 代理档 Transport ─────────────────────────────────────────────────────

// proxyTransportFor 返回按代理地址复用的代理档 Transport（单条缓存：显式/环境
// 代理各一个地址，换代即重建并收掉旧池 idle 连接）
var (
	proxyTransportMu   sync.Mutex
	proxyTransportKey  string
	proxyTransportInst *http.Transport
)

func proxyTransportFor(p *url.URL) *http.Transport {
	key := p.String()
	proxyTransportMu.Lock()
	defer proxyTransportMu.Unlock()
	if proxyTransportInst != nil && proxyTransportKey == key {
		return proxyTransportInst
	}
	if proxyTransportInst != nil {
		proxyTransportInst.CloseIdleConnections()
	}
	proxyTransportInst = newProxyTransport(p)
	proxyTransportKey = key
	return proxyTransportInst
}

// newProxyTransport 代理档 Transport：CONNECT 隧道（http/https 代理）或 SOCKS5
// （net/http 原生支持 socks5/socks5h scheme，域名原样交代理解析=socks5h 语义）。
// DialContext 只承载到代理本身的连接——代理地址（公司内网代理/本地 clash 回环
// 端口）不走 IP 守卫，它是本功能要打通的目标场景；目标侧守卫在选路层逐跳校验
func newProxyTransport(p *url.URL) *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyURL(p),
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	}
}

// ── 代理路径目标域守卫 ───────────────────────────────────────────────────

// trustedUpdateDomains 官方更新链域名白名单（代理路径信任面）。GitHub 资产
// 下载会 302 到 release-assets/objects.githubusercontent.com——选路逐跳裁决
// 时同样过本表。新增官方域在此扩展
var trustedUpdateDomains = map[string]struct{}{
	"github.com":                           {},
	"www.github.com":                       {},
	"api.github.com":                       {},
	"objects.githubusercontent.com":        {},
	"release-assets.githubusercontent.com": {},
}

// checkProxyTargetHost 代理路径目标域守卫：仅 https 且目标 host ∈ 官方可信域
// ∪ 显式配置的更新源 host。被篡改的 API 响应把二进制拉取重定向到任意/内网
// 主机的供应链形态在此收口（代理代解析使拨号期 IP 复查不可用）
func checkProxyTargetHost(u *url.URL) error {
	if u.Scheme != "https" {
		return fmt.Errorf("update over proxy must use https, got %q scheme", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("update url missing host")
	}
	if _, ok := trustedUpdateDomains[host]; ok {
		return nil
	}
	if st := outbound.Load(); st != nil && st.sourceHost != "" && host == st.sourceHost {
		return nil
	}
	return fmt.Errorf("update source %q is not an official trusted domain — proxy mode only allows official update domains and the configured update source", host)
}

// ── 代理地址解析与装配 ───────────────────────────────────────────────────

// SetOutbound 装配更新链出站代理（ApplySource 启动/设置保存单点调用）。
// rawProxy 空 = 清除显式代理（回环境变量感知层）；sourceHost 为当前更新源
// host（小写归一，进代理白名单）。解析失败返回错误且不改动现状，回退策略由
// 调用方决定
func SetOutbound(rawProxy, sourceHost string) error {
	var p *url.URL
	if rawProxy != "" {
		u, err := parseProxyURL(rawProxy)
		if err != nil {
			return err
		}
		p = u
	}
	outbound.Store(&outboundState{proxy: p, sourceHost: strings.ToLower(strings.TrimSpace(sourceHost))})
	return nil
}

// NormalizeProxyURL 更新代理地址归一（设置保存期校验口，api/system/settings.go）：
// 空串 = 清除；接受 http/https/socks5/socks5h；缺端口补默认（80/443/1080）；
// 拒绝带路径/query/fragment 的形态（代理地址无路径，顺带拦下 host 粘连错拼）。
// 回环/内网代理地址合法且是目标场景本身（本地 clash 端口、公司内网代理），不套 IP 守卫
func NormalizeProxyURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := parseProxyURL(raw)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func parseProxyURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid update proxy url: %w", err)
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, fmt.Errorf("invalid update proxy scheme %q (http/https/socks5/socks5h only)", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("invalid update proxy url %q: missing host", raw)
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid update proxy url %q: path/query/fragment not allowed", raw)
	}
	if u.Port() == "" {
		switch u.Scheme {
		case "http":
			u.Host += ":80"
		case "https":
			u.Host += ":443"
		default: // socks5 / socks5h
			u.Host += ":1080"
		}
	}
	return u, nil
}

// hostOfSourceURL 取更新源 URL 的 host（小写）作为代理白名单成员；解析失败
// 返回空串（白名单只剩官方域——该源本身也会被 NewGitHubSource 拒绝装配）
func hostOfSourceURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}
