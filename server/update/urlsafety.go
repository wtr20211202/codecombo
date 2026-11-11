// 更新通道出站安全：
//   - 仅允许 https——更新承载可执行文件，明文 http 可被中间人整体替换
//     （即使有 sha256/签名伴随校验，校验文件同样经该通道拉取）；
//   - 拒绝指向本机/内网/保留地址的更新源（SSRF 面收口）；
//   - 拨号期对 DNS 解析结果复查（防 rebinding：URL 字面量合法但解析到内网）；
//   - 出站路径四档（P-20261109-12 三态 + P-20261110-1 S6 系统探测档），逐跳按序
//     裁决：显式设置代理 > 环境变量代理（HTTPS_PROXY/HTTP_PROXY/NO_PROXY 业界事实
//     标准，服务器 systemd unit 设 env 即生效）> 系统代理探测（开关
//     updateProxyAutoDetect 开时才有此档）> 直连守卫。env 是运维显式动作，启发式
//     探测不得覆盖它；开关关时探测档不存在、不读 NO_PROXY，行为与三态逐字节一致。
//     历史缺口：newSafeTransport 自定义 DialContext 无 Proxy 字段，Go 不读任何代理
//     环境变量，CN 网络直连 github.com 阵发失败只能靠重试。
//   - 探测挂点钉死（proxytier.go）：只在装配点（ApplySource：启动 + 设置保存）与
//     更新尝试边界（检查更新取数前 / 受理下载前 / 中心分发缓存下载前，一次尝试
//     探测一次）探测，结果写入 outbound 原子快照；选路热路径（roundTripperFor，
//     每个重定向跳都进）只读快照，绝不探测——GitHub 资产至少 302 两跳，逐跳 2s 短
//     超时会叠加成下载卡顿。
//   - NO_PROXY 立场两档不同（如实注记）：env 档由 ProxyFromEnvironment 逐 host
//     裁决（原语义）；探测档尊重 NO_PROXY——目标命中即跳过探测档直连（运维已用
//     NO_PROXY 表达直连意图，启发式须让位，noproxy.go）；显式档不解读 NO_PROXY
//     （用户手动指定代理 = 对更新链全量生效，NO_PROXY 在此无作用对象）。
//
// 走代理后目标由代理解析，直连 IP 守卫语义失效——代理路径（显式/env/探测三档同
// 口径）的 SSRF 防线降级为官方可信域白名单（∪ 显式配置的更新源 host），逐跳校验
// （含重定向）。
package update

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
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
// 为「直连」的请求（无代理可配 / 显式代理缺省且环境变量未命中且探测档无结果 /
// NO_PROXY 豁免），环境代理与探测快照的读取在 safeRoundTripper 选路层完成
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

// ── 出站代理装配态（P-20261109-12；S6 扩系统探测档）──────────────────────────

// outboundState 更新链出站配置快照（不可变：任何变更都整体替换 Store，读侧 Load
// 现读）。proxy 为 nil 时走环境变量感知层；sourceHost 是当前更新源 host（显式
// 配置它本身就是信任决定，进代理白名单——自建镜像/Gitea 源不被官方域白名单误伤）。
// 探测字段（S6）只在 autoDetect 开时由探测挂点写入（proxytier.go）：detected 为
// nil = 本档无代理（未探测 / 系统未启用静态代理 / 探测失败——失败原因留 detectErr
// 供状态端点诊断，不冒泡）
type outboundState struct {
	proxy      *url.URL
	sourceHost string

	autoDetect     bool
	detected       *url.URL
	detectedSource string
	detectedAt     time.Time // 本次探测发起时刻；零值 = 尚未探测
	detectErr      string
}

// outbound 单点装配（ApplySource 启动/设置保存调用；探测挂点只替换探测字段），
// 每请求原子现读——设置保存即生效，无须重建任何 http.Client
var outbound atomic.Pointer[outboundState]

// envProxyFor 环境变量代理探询口：默认 http.ProxyFromEnvironment（HTTPS_PROXY/
// HTTP_PROXY/NO_PROXY 标准语义，含小写变体与端口推断）。独立变量仅为测试注入，
// 生产语义与 net/http 完全一致
var envProxyFor = func(u *url.URL) (*url.URL, error) {
	return http.ProxyFromEnvironment(&http.Request{URL: u})
}

// 出站档位（稳定机读值：GET /api/updates/proxy-status 的 tier 字段，前端映射文案）
const (
	ProxyTierExplicit  = "explicit"  // 显式设置项 updateProxy
	ProxyTierEnv       = "env"       // 环境变量 HTTPS_PROXY/HTTP_PROXY
	ProxyTierSysDetect = "sysdetect" // 系统代理探测（开关开 + 探测到 + 目标未命中 NO_PROXY）
	ProxyTierDirect    = "direct"    // 直连（IP 守卫）
)

// safeRoundTripper 按请求 URL 现选出站路径的 RoundTripper（显式代理 / 环境代理 /
// 系统探测代理 / 直连四档）。http.Client 的每个重定向跳都会重新进入 RoundTrip，
// 因此选路+守卫是逐跳的：代理档下重定向到非可信域被拒，直连档下被拨号期 IP 守卫拦截
type safeRoundTripper struct{}

func (safeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt, err := roundTripperFor(req.URL)
	if err != nil {
		return nil, err
	}
	return rt.RoundTrip(req)
}

// selectOutbound 单请求出站档位裁决（纯选路，守卫在调用方）——roundTripperFor 与
// 状态端点共用，「显示的档位」与「实际走的路」同源不漂移：
//   - 显式设置代理：对更新链全量生效（不解读 NO_PROXY——那是环境变量层的语义，
//     想对部分目标直连的用户应清空设置项改走 env 层）；
//   - 无显式：探询环境变量（ProxyFromEnvironment 同款逐 host 裁决），命中即走
//     env 档；未命中可能是「无 env 代理」也可能是「NO_PROXY 豁免」——
//   - 探测档：开关开且快照里有探测结果，且目标未命中 NO_PROXY 才启用（NO_PROXY
//     豁免的目标在此同样落直连，与 env 档结论一致）；只读快照，热路径零探测；
//   - 皆无：直连档，行为与历史版本逐字节一致（零变化验收；开关关时 detected 恒
//     nil，短路不读 NO_PROXY）。
func selectOutbound(u *url.URL) (tier string, proxy *url.URL, err error) {
	st := outbound.Load()
	if st != nil && st.proxy != nil {
		return ProxyTierExplicit, st.proxy, nil
	}
	p, err := envProxyFor(u)
	if err != nil {
		return "", nil, err
	}
	if p != nil {
		return ProxyTierEnv, p, nil
	}
	if st != nil && st.detected != nil && !noProxyMatchFor(u) {
		return ProxyTierSysDetect, st.detected, nil
	}
	return ProxyTierDirect, nil, nil
}

// roundTripperFor 单请求出站选路（守卫单点）：代理三档（显式/env/探测）目标一律
// 过官方域白名单后走代理档 Transport；直连档走 IP 守卫 Transport
func roundTripperFor(u *url.URL) (http.RoundTripper, error) {
	tier, p, err := selectOutbound(u)
	if err != nil {
		return nil, err
	}
	if tier == ProxyTierDirect {
		return directTransport, nil
	}
	if err := checkProxyTargetHost(u); err != nil {
		return nil, err
	}
	return proxyTransportFor(p), nil
}

// ── 代理档 Transport ─────────────────────────────────────────────────────

// proxyTransportFor 返回按代理地址复用的代理档 Transport（单条缓存：同一时刻生效
// 的代理档只有一个地址——显式/环境/探测三档按序互斥，更新链目标全是 https 不会
// 在两档间交替；换代即重建并收掉旧池 idle 连接）
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

// SetOutbound 装配更新链出站态（ApplySource 启动/设置保存单点调用）。
// rawProxy 空 = 清除显式代理（回环境变量感知层）；sourceHost 为当前更新源
// host（小写归一，进代理白名单）；autoDetect 为系统代理探测开关（S6）。解析失败
// 返回错误且不改动现状，回退策略由调用方决定。
// 探测结果的去留：开关关即清空（探测档不存在）；开关保持开时沿用上一份结果直到
// 装配点的新探测落地（proxytier.go）——无关字段的保存（换通道/改分发源）不该在
// 新探测完成前的窗口里让在途下载的下一跳从探测档掉回直连。本函数自身不做探测
// （纯内存装配），探测由调用方在装配后经 refreshSystemProxyDetection 触发
func SetOutbound(rawProxy, sourceHost string, autoDetect bool) error {
	var p *url.URL
	if rawProxy != "" {
		u, err := parseProxyURL(rawProxy)
		if err != nil {
			return err
		}
		p = u
	}
	next := &outboundState{
		proxy:      p,
		sourceHost: strings.ToLower(strings.TrimSpace(sourceHost)),
		autoDetect: autoDetect,
	}
	if prev := outbound.Load(); autoDetect && prev != nil && prev.autoDetect {
		next.detected = prev.detected
		next.detectedSource = prev.detectedSource
		next.detectedAt = prev.detectedAt
		next.detectErr = prev.detectErr
	}
	outbound.Store(next)
	return nil
}

// NormalizeProxyURL 更新代理地址归一（设置保存期校验口，api/system/settings.go；
// 亦是系统代理探测结果的同规校验口，sysproxy.go）：
// 空串 = 清除；接受 http/https/socks5/socks5h；缺端口补默认（80/443/1080）；
// 端口须 1–65535；拒绝带路径/query/fragment 的形态（代理地址无路径，顺带拦下 host
// 粘连错拼）。回环/内网代理地址合法且是目标场景本身（本地 clash 端口、公司内网
// 代理），不套 IP 守卫
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
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		default: // socks5 / socks5h
			port = "1080"
		}
		// 以 Hostname 重建 host：「host:」空端口形态（Port() 为空）直接拼接会得到
		// url.Parse 不认的 host::80 坏串；JoinHostPort 同时为 IPv6 字面量补方括号
		u.Host = net.JoinHostPort(u.Hostname(), port)
		return u, nil
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return nil, fmt.Errorf("invalid update proxy url %q: port out of range", raw)
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
