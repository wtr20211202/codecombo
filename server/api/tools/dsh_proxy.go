package tools

// 回环反代与多目标路由——原 dsh.go「反代服务（惰性启动，进程内单例；配置变更
// 即时重绑定）」「多目标路由（cookie 作用域）」两节 + proxyScheme/TLS 服务标志
// 整体平移（P-20261003-314 纯搬运拆分，逻辑零改动）。改写与注入的具体实现
// （ModifyResponse 消费的 polyfill/injectHeadStyle 等）在 dsh_rewrite.go。

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/config"
	"codecombo/server/tlsutil"
)

// ============== 反代服务（惰性启动，进程内单例；配置变更即时重绑定） ==============

var (
	proxyMu         sync.Mutex
	proxySrv        *http.Server
	proxyListenAddr string // 已启动实例的监听地址（含绑定面，exposeAll 切换即变更）
	proxyBaseUsed   string // 已启动实例的本机目标上游
	proxyDegraded   string // 最近一次监听失败原因（空 = 正常服务中）
)

// proxyScheme 反代对外协议：跟随主服务（SC 以 TLS 对外则反代同为 https）。
// iframe 与顶层页面同 scheme 才构成 schemeful 同站，dsh 的 SameSite=Strict
// 会话 cookie 才会在 iframe 内携带——https 页面嵌 http iframe 被判跨站，
// cookie 永不携带（实测换发成功但回落 / 即 401 鉴权页 / 回环入口补签死循环）。
// 自签证书的信任由用户在浏览器接受一次（SAN 已含 localhost/主机名/全部网卡 IP）
func proxyScheme() string {
	if config.TLSEnabled() {
		return "https"
	}
	return "http"
}

// tlsServedOnce TLS 反代已成功服务过至少一次请求。证书被拒的请求根本到不了
// 服务端（TLS 握手失败即断），故「有请求到达」即「已有浏览器接受自签证书」
// ——前端据此收起证书接受提示。持久化到 DataDir：证书与浏览器的接受状态都
// 跨重启有效，提示不应在每次重启后重新出现
var tlsServedOnce atomic.Bool

func markTLSServed() {
	if tlsServedOnce.Swap(true) {
		return
	}
	_ = os.WriteFile(filepath.Join(config.DataDir(), "dsh-tls-served.flag"),
		[]byte(time.Now().Format(time.RFC3339)), 0600)
}

// ============== 多目标路由（cookie 作用域） ==============

// dshRoute 单请求解析出的路由：目标上游 + 令牌
type dshRoute struct {
	base  string
	token string
}

// resolveRoute 请求路由解析：scDshTarget 查询参数优先（命中即落 cookie 供后续
// 请求复用），其次 sc_dsh_target cookie，缺省本机目标；未知目标回退本机
// （目标删除后残留的 cookie/URL 自动回落，不 404）
func resolveRoute(r *http.Request) (dshRoute, string) {
	cfg := readConfig()
	id := ""
	if u, err := url.Parse(r.URL.RequestURI()); err == nil {
		id = u.Query().Get(scTargetQuery)
	}
	setID := ""
	if id == "" {
		if c, err := r.Cookie(scTargetCookie); err == nil {
			id = c.Value
		}
		// 已删/未知目标不落 cookie（回退本机服务，URL 保持干净）
	} else if id != localTargetID && targetExists(cfg, id) {
		setID = id
	}
	return dshRoute{base: baseForTarget(cfg, targetIDOrDefault(id)), token: tokenForTarget(cfg, targetIDOrDefault(id))}, setID
}

// hasDshAuthCookie dsh 0.1.2+ 的会话 cookie（名字带按实例后缀，前缀匹配）
func hasDshAuthCookie(r *http.Request) bool {
	for _, c := range r.Cookies() {
		if strings.HasPrefix(c.Name, "dsh-auth-") {
			return true
		}
	}
	return false
}

// shouldIssueToken 自动签发门判定（吸收自 dsh-web 脚本）：仅无 dsh-auth- cookie
// 的首页 GET/HEAD 首访、URL 未带 token、且已知当前 token 时才 302；
// token 为空（未捕获/旧版本 dsh）不启用
func shouldIssueToken(method, path, rawQuery string, hasAuthCookie, hasToken bool) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	if path != "/" || hasAuthCookie || !hasToken {
		return false
	}
	for _, kv := range strings.Split(rawQuery, "&") {
		if strings.HasPrefix(kv, "token=") {
			return false
		}
	}
	return true
}

// stripQueryParam 保字节剔除查询参数（dsh 插件 URL 含非标形态 /plugins/??a,b&rev=x，
// url.Values 重编码会打碎导致上游 404——禁止重写 RawQuery，仅逐字节透传）
func stripQueryParam(rawQuery, key string) string {
	parts := strings.Split(rawQuery, "&")
	kept := parts[:0]
	for _, p := range parts {
		if !strings.HasPrefix(p, key+"=") {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "&")
}

// browserHostKey 浏览器面向地址（进代理时的 Host 头，改写前快照）传递键：
// 决定是否需要 Secure-Context 降级改写（回环 = 安全上下文，跳过全部改写）
type browserHostKey struct{}

// dshRouteKey 已解析路由（目标上游/令牌）传递键
type dshRouteKey struct{}

// dshProxyHandler 反代入口：嵌入守卫（allowStandalone 开关）+ 多目标路由落
// cookie + token 自动签发门 + 反代
func dshProxyHandler(proxy http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if config.TLSEnabled() {
			markTLSServed() // 请求到达 = TLS 握手成功 = 证书已被接受
		}
		// 独立标签页访问守卫（默认关）：未开启「允许独立标签页访问」时，顶层
		// 导航（地址栏直开/从书签打开）返回友好引导页——嵌入通道仅供 SC 内
		// iframe 使用。子资源/XHR/WS（dest 非 document）一律放行：它们只发生在
		// 已加载的 dsh 页面内，而页面加载已在守卫之后
		if !readConfig().AllowStandalone && isStandaloneNavigation(r) {
			renderStandaloneBlockedPage(w, r)
			return
		}
		route, setID := resolveRoute(r)
		if setID != "" {
			http.SetCookie(w, &http.Cookie{
				Name: scTargetCookie, Value: setID, Path: "/", SameSite: http.SameSiteLaxMode,
			})
			r.URL.RawQuery = stripQueryParam(r.URL.RawQuery, scTargetQuery)
		}
		// token 自动签发门（吸收自 dsh-web 脚本）：无 cookie 的首页首访自动 302
		// 携带当前 token，由上游换取 30 天 cookie——浏览器侧 token 零管理；
		// no-store 防止 302 被缓存
		// 仅对回环 Host 签发：非回环（LAN 地址/可被 DNS rebinding 指向回环的
		// 域名）一律不签发、交给上游 401——LAN 浏览器的 token 经 /dsh/url（SC
		// 鉴权后）以查询参数注入，防攻击页把域名切到 127.0.0.1 后同源窃取会话
		if !isLoopbackBrowserHost(r.Host) {
			ctx := context.WithValue(r.Context(), dshRouteKey{}, route)
			proxy.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if shouldIssueToken(r.Method, r.URL.Path, r.URL.RawQuery, hasDshAuthCookie(r), route.token != "") {
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, "/?token="+url.QueryEscape(route.token), http.StatusFound)
			return
		}
		ctx := context.WithValue(r.Context(), dshRouteKey{}, route)
		proxy.ServeHTTP(w, r.WithContext(ctx))
	})
}

// startProxyOnce 惰性启动回环反代（进程内单例；base/绑定面/端口任一配置变更
// 即时优雅重绑定，无需重启本系统——在途流收尾，iframe/WS 自动重连）。
// 监听失败（端口占用等）：记日志并保持未启动——下次请求重试，/dsh/url 报 degraded
func startProxyOnce(cfg dshConfig) {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	addr := "127.0.0.1:" + strconv.Itoa(cfg.ProxyPort)
	if cfg.ExposeAll {
		addr = ":" + strconv.Itoa(cfg.ProxyPort) // 0.0.0.0 含回环，本机嵌入不受影响
	}
	if proxySrv != nil && proxyListenAddr == addr && proxyBaseUsed == cfg.Base {
		proxyDegraded = ""
		return
	}
	// 配置变更：同步优雅关停旧实例后再 Listen——Shutdown 放 goroutine 会与
	// 紧随的 net.Listen 赛跑（旧 listener 未及关闭 → EADDRINUSE → 通道下线）。
	// 持 proxyMu 等待无死锁依赖（Shutdown 不需要本锁），超时兜底防悬挂
	if proxySrv != nil {
		old := proxySrv
		proxySrv = nil
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = old.Shutdown(shutdownCtx)
		cancel()
	}
	proxy := newDshReverseProxy()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		proxyDegraded = fmt.Sprintf("listen %s failed: %v（端口被占用可在设置中调整 dshProxyPort）", addr, err)
		fmt.Printf("[dsh-proxy] %s\n", proxyDegraded)
		return
	}
	proxyDegraded = ""
	srv := &http.Server{
		Handler:           dshProxyHandler(proxy),
		ReadHeaderTimeout: 10 * time.Second, // exposeAll 时防 slowloris（对齐主服务）
	}
	proxySrv = srv
	proxyListenAddr = addr
	proxyBaseUsed = cfg.Base
	scheme := proxyScheme()
	if scheme == "https" {
		// 证书接受状态跨重启有效（浏览器例外持久 + 标志文件持久），提示不闪现
		if _, err := os.Stat(filepath.Join(config.DataDir(), "dsh-tls-served.flag")); err == nil {
			tlsServedOnce.Store(true)
		}
	}
	go func() {
		var err error
		if scheme == "https" {
			// 自签证书与主服务共用（SAN 覆盖 localhost/主机名/全部网卡 IP，
			// DataDir/certs 生成一次重启复用）。浏览器侧信任需在新标签打开一次
			// 反代地址接受证书，之后 iframe 内正常加载
			certPath, keyPath, certErr := tlsutil.EnsureCert(filepath.Join(config.DataDir(), "certs"))
			if certErr != nil {
				proxyMu.Lock()
				if proxySrv == srv {
					proxySrv = nil
				}
				proxyDegraded = fmt.Sprintf("tls cert: %v", certErr)
				proxyMu.Unlock()
				return
			}
			err = srv.ServeTLS(ln, certPath, keyPath)
		} else {
			err = srv.Serve(ln)
		}
		if err != nil && err != http.ErrServerClosed {
			proxyMu.Lock()
			if proxySrv == srv {
				proxySrv = nil
			}
			proxyDegraded = fmt.Sprintf("serve stopped: %v", err)
			proxyMu.Unlock()
		}
	}()
	fmt.Printf("[dsh-proxy] dsh Web UI 反代已启动: %s://%s → %s（token 自动签发；多目标 cookie 路由；scheme 跟随主服务）\n", scheme, addr, cfg.Base)
}

// newDshReverseProxy 构造回环反代实例（Director/ModifyResponse 全量行为链）。
// 独立成函数是 P-20261111-2-S2 反代行为快照回归钉的前提：钉必须直接复用生产
// 构造断言真实行为——测试侧复刻一份 Director/ModifyResponse 防不了本文件内
// 改写逻辑的将来回归
func newDshReverseProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		// 本机目标 base 每请求动态读取：设置页改动即时生效（监听地址固化在
		// 首次启动，绑定面/端口改动经重绑定路径生效）。
		// token 不在代理层注入：签发门（302）已按目标发放，代理若每请求再注入
		// 会造成「设 cookie → 303 → 再注入 → 再 303」的死循环
		Director: func(req *http.Request) { //nolint:staticcheck // SA1019：Director→Rewrite 迁移属行为敏感重构，另行专项
			live := readConfig()
			route, _ := req.Context().Value(dshRouteKey{}).(dshRoute)
			if route.base == "" {
				route.base = live.Base
			}
			upstream, err := url.Parse(route.base)
			if err != nil {
				return
			}
			// 浏览器面向地址快照（改写前）：ModifyResponse 据此决定降级改写
			ctx := context.WithValue(req.Context(), browserHostKey{}, req.Host)
			*req = *req.WithContext(ctx)
			req.URL.Scheme = upstream.Scheme
			req.URL.Host = upstream.Host
			// fence 回环断言（吸收自 dsh-web 脚本）：拨号目标仍是 upstream.Host，
			// 仅 Host/Origin 头断言为回环授权——dsh 的服务端 fence（settings.*
			// 只认回环 Host，--trusted-host 不覆盖）由此放行，上游拓扑无关
			if p := upstream.Port(); p != "" {
				req.Host = net.JoinHostPort("127.0.0.1", p)
			} else {
				req.Host = "127.0.0.1"
			}
			if req.Header.Get("Origin") != "" {
				req.Header.Set("Origin", "http://"+req.Host)
			}
			// task-board 等插件 fence 更严：无 Origin/Sec-Fetch 标记的浏览器读取
			// 直接 403（核心 fence 对无标记请求认回环 Host 即可）。为无标记的
			// /api 请求补上同源标记，与 X-Forwarded-* 同语义，由信任边界代理断言
			if strings.HasPrefix(req.URL.Path, "/api/") &&
				req.Header.Get("Sec-Fetch-Site") == "" && req.Header.Get("Origin") == "" {
				req.Header.Set("Sec-Fetch-Site", "same-origin")
			}
			// 统一要未压缩响应：ModifyResponse 的 HTML/JS 注入直接改字节流，压缩
			// 响应会产出非法流（浏览器 ERR_CONTENT_DECODING_FAILED）；回环无
			// 带宽成本，压缩无收益
			req.Header.Set("Accept-Encoding", "identity")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			fmt.Printf("[dsh-proxy] upstream error: %v\n", err)
			w.WriteHeader(http.StatusBadGateway)
		},
		ModifyResponse: func(resp *http.Response) error {
			// 101 Switching Protocols（WS 升级）必须原样交还：反代的升级
			// 处理要求 body 可读写，任何缓冲/替换都会直接破坏 WS 通道
			if resp.StatusCode == http.StatusSwitchingProtocols {
				return nil
			}
			// 剥掉帧限制头：本系统回环代理通道的结构性保证
			resp.Header.Del("X-Frame-Options")
			resp.Header.Del("Content-Security-Policy")
			// dsh 会话 cookie 的 Secure 降级：dsh 令牌换发的 30 天会话 cookie 带
			// Secure 属性（实测），明文 HTTP 上 LAN 浏览器拒收（127.0.0.1 等可信源
			// 例外）——cookie 永远落不了地，iframe 恒见鉴权页。嵌入通道本就是明文
			// 反代，Secure 在该通路上没有语义只有伤害，由信任边界代理剥除（与剥
			// XFO/CSP 同层同理）；回环浏览器属可信源不受影响
			for i, ck := range resp.Header["Set-Cookie"] {
				if strings.HasPrefix(ck, "dsh-auth-") {
					resp.Header["Set-Cookie"][i] = stripCookieAttribute(ck, "Secure")
				}
			}
			// 断环：带 token 的换发请求被上游以 30x 弹回且未下发 dsh-auth- 会话
			// cookie，即令牌被拒（dsh 每次启动换令牌，SC 存量令牌过期后上游照常
			// 303 弹回「/」）。若照常透传，签发门会对「/」再次 302 补签同一枚失效
			// 令牌——补签↔弹回往复构成浏览器侧无限重定向（ERR_TOO_MANY_REDIRECTS
			// 实测）。改写为 401 文案止住循环；控制台横幅（探测同源判 stale）继续
			// 引导「重启并重新捕获令牌」
			rewriteRejectedTokenExchange(resp)
			ct := resp.Header.Get("Content-Type")
			isHTML := strings.Contains(ct, "text/html") && resp.Request.Method != http.MethodHead
			isJS := strings.Contains(ct, "javascript") && resp.Request.Method != http.MethodHead
			// Secure-Context 降级改写仅覆盖非回环浏览器的 HTML/JS（回环是安全
			// 上下文且 hostname 本就是 127.0.0.1——零改写零缓冲快路径）；其余
			// 类型（SSE/流/二进制）一律不缓冲直通，防止 goroutine 在活跃流上悬挂
			bhost, _ := resp.Request.Context().Value(browserHostKey{}).(string)
			secureDowngrade := !isLoopbackBrowserHost(bhost) && (isHTML || isJS)
			if !secureDowngrade {
				return nil
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				return err
			}
			if secureDowngrade && isJS {
				// settings 页 isLoopback 判定恒真（合并包多处，统一替换）
				body = []byte(strings.ReplaceAll(string(body), isLoopbackJSRewrite, "true"))
			} else if secureDowngrade && isHTML {
				body = injectHeadStyle(body, secureCtxPolyfill)
				// remote-web-ui boot 补丁恒真跳过（片段唯一，单次替换）
				body = []byte(strings.Replace(string(body), remoteBootPatchOld, remoteBootPatchNew, 1))
			}
			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		},
	}
}

// stopProxy 关闭反代实例并清理状态（通道关闭/配置迁移时释放监听）
func stopProxy() {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if proxySrv == nil {
		return
	}
	old := proxySrv
	proxySrv = nil
	proxyListenAddr = ""
	proxyDegraded = ""
	go func() { _ = old.Shutdown(context.Background()) }()
}
