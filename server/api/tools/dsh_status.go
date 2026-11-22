package tools

// 状态探测——原 dsh.go 同名节整体平移（P-20261003-314 纯搬运拆分，逻辑零
// 改动）：/status 判活与 /url 反代地址端点 + 目标令牌状态判定（控制台
// 「需重新授权」横幅的事实源）。

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============== 状态探测 ==============

// DshStatus GET /api/tools/dsh/status
// 对本机目标做短超时探测：available 判活（不关心状态码，401/404 也算活着）。
// 嵌入通道固定走反代（结构保证可用），探测仅用于 UI 判活与延迟展示。
// 判活走 TCP 拨号+一次重试（P-20261118-4，见 probeAvailableBase/probeWithRetry）；
// latencyMs 语义钉死（P-20261118-6）：available 时 = HTTP 往返耗时（延迟展示
// 口径），不可用时 = 拨号往返耗时（诊断口径）——/url（拨号判活）与 /status
// 在同环境的 available 结论因此恒一致。
// 响应带 probe 诊断块（实际探测的 base 与失败归因）——空态可自诊断。
func DshStatus(c *gin.Context) {
	cfg := readConfig()
	ok, diag := probeWithRetry(cfg.Base)
	latency := diag.LatencyMs
	if ok {
		start := time.Now()
		if resp, err := probeHTTP.Get(cfg.Base); err == nil {
			resp.Body.Close()
		}
		latency = time.Since(start).Milliseconds()
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"available": ok,
		"upstream":  cfg.Base,
		"proxyURL":  proxyURLIfEnabled(cfg),
		"latencyMs": latency,
		"probe":     probeDiagJSON(diag, localTargetID),
	}})
}

// probeDiagJSON 探测诊断块的响应形态（自包含：前端空态只读本块即可渲染
// 「已探测 <base>（目标 <id>）：<失败原因>」诊断行）
func probeDiagJSON(diag dshProbeDiag, targetID string) gin.H {
	return gin.H{
		"base":      diag.Base,
		"target":    targetID,
		"latencyMs": diag.LatencyMs,
		"errClass":  diag.ErrClass,
		"err":       diag.ErrText,
	}
}

func proxyURLIfEnabled(cfg dshConfig) any {
	if !cfg.ProxyEnabled {
		return nil
	}
	return fmt.Sprintf("%s://127.0.0.1:%d/", proxyScheme(), cfg.ProxyPort)
}

// DshProxyURL GET /api/tools/dsh/url?target=<id，可选>
// 返回可直接放进 iframe/新标签的地址：反代开启时 = 代理地址（顺带惰性启动/
// 按配置重绑定代理服务）；反代关闭时 = 直连上游地址。
// 反代通道的 token 由签发门（302）发放，URL 保持干净；直连上游才拼 ?token=。
func DshProxyURL(c *gin.Context) {
	cfg := readConfig()
	if cfg.ProxyEnabled {
		startProxyOnce(cfg)
	} else {
		stopProxy() // 关闭通道即释放旧监听
	}
	tid := targetIDOrDefault(c.Query("target"))
	// 先判令牌：本机目标失效时自动回收（从启动日志重取写回设置），随后用
	// 回收后的最新令牌构造地址——顺序反了会把刚过期的令牌塞进 iframe URL，
	// 白吃一次 401
	tokenState := tokenStateFor(cfg, tid)
	if tid == localTargetID {
		cfg = readConfig() // 回收可能更新了设置，取最新令牌
	}

	// 目标地址构造（纯函数形态供测试直达注入矩阵）
	target := dshEmbedTargetURL(cfg, c.Request.Host, c.Query("target"))

	proxyMu.Lock()
	degraded, degradedReason := proxyDegraded != "", proxyDegraded
	proxyMu.Unlock()

	probeBase := baseForTarget(cfg, tid)
	ok, diag := probeWithRetry(probeBase)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"url":            target,
		"available":      ok,
		"upstream":       probeBase,
		"exposeAll":      cfg.ProxyEnabled && cfg.ExposeAll,
		"proxyEnabled":   cfg.ProxyEnabled,
		"degraded":       degraded,
		"degradedReason": degradedReason,
		"tokenState":     tokenState,
		"proxyScheme":    proxyScheme(),
		"tlsServedOnce":  tlsServedOnce.Load(),
		"probe":          probeDiagJSON(diag, tid),
	}})
}

// dshEmbedTargetURL 构造 /url 响应的嵌入地址（反代开启 = 代理地址 + 目标路由
// 参数 + 非回环浏览器令牌注入；反代关闭 = 上游直连同注入）。抽成纯函数是
// P-20261118-6 的令牌注入矩阵测试前提（host/tid 显式入参，不起真监听）。
func dshEmbedTargetURL(cfg dshConfig, browserHost, tid string) string {
	// 目标代理地址：默认回环（同机浏览器）；开放所有 IP 时按请求 Host 回构造，
	// LAN 浏览器经 http://<SC机>:<端口> 访问。开关切换即时生效（重绑定），
	// 本系统无需重启。
	// 回环访问沿用浏览器实际使用的回环名（localhost / 127.0.0.1）：二者互为
	// 跨 site——iframe 用与宿主页面不同的 site 会被现代 Chromium 按第三方
	// 上下文处理，302 签发门的 SameSite=Strict cookie 无法随重定向携带，
	// 陷入「签发→丢弃→再签发」死循环
	host := "127.0.0.1"
	if cfg.ProxyEnabled {
		if h := hostnameOf(browserHost); h != "" && isLoopbackBrowserHost(browserHost) {
			host = h
		} else if cfg.ExposeAll && h != "" {
			host = h
		}
	}
	var target string
	if cfg.ProxyEnabled {
		target = proxyScheme() + "://" + net.JoinHostPort(host, strconv.Itoa(cfg.ProxyPort)) + "/"
		if tid != "" && tid != localTargetID && targetExists(cfg, tid) {
			// 多目标路由：查询参数落 cookie，iframe 内部后续请求自动携带；
			// 已删除/未知目标不拼参数（服务端本就回退本机，URL 保持干净）
			target += "?" + scTargetQuery + "=" + url.QueryEscape(tid)
		}
		// token 门仅对回环 Host 签发（防 DNS rebinding）：LAN 浏览器（开放模式）
		// 的令牌经本接口注入——本接口在 SC 锁鉴权之后，凭据只在授权链路上分发。
		// 注入令牌随目标取（P-20261118-6）：外部目标注入其自身令牌而非本机
		// DshWebToken——此前两分支都拼 cfg.Token，LAN 浏览器看外部目标必 401
		// 鉴权页（直连分支本就 tokenForTarget，两分支不一致的实锚缺陷）
		if tok := tokenForTarget(cfg, targetIDOrDefault(tid)); tok != "" && !isLoopbackBrowserHost(browserHost) {
			target = withTokenParam(target, tok)
		}
	} else {
		// 直连上游无签发门，回退为 URL 注入令牌（原行为）；地址随目标取
		//（P-20261118-6：反代关闭时外部目标至少指对机器——直连嵌入缺帧头
		// 剥离/令牌签发门、https 主站下 http 外链混合内容硬阻断，该代价由
		// 前端的外部目标警告如实交代，见 DshConsoleBody externalTargetProxyOff）
		target = withTokenParam(baseForTarget(cfg, targetIDOrDefault(tid)), tokenForTarget(cfg, targetIDOrDefault(tid)))
	}
	return target
}

// dshProbeDiag 探测诊断（P-20261118-4 空态可诊断化）：空态不再只给笼统判词，
// 实际探测的 base 与失败归因随 /url、/status 响应下发——DshWebBase 被设置
// 导入带偏/多目标选错时一眼可见，而非无从下手的「未检测到」
type dshProbeDiag struct {
	Base      string // 实际探测的上游地址
	LatencyMs int64  // 本次探测耗时（TCP 拨号往返）
	ErrClass  string // 失败分类：timeout/refused/tls/other（前端映射可读文案）；成功为空
	ErrText   string // err 原文摘录（≤200 字符）——分类为辅原文为主，供深查
}

// probeHTTP 探测/令牌判定/HTTP 就绪判据共用的专用 HTTP 客户端（P-20261118-6
// 探测通道增强）：
//   - Proxy: nil —— Go 默认 transport 按 HTTP(S)_PROXY 环境变量构造代理，仅对
//     回环豁免；SC 部署在代理-only 环境（部署面靠 ambient 代理出网）时，外部
//     LAN 目标的令牌探测/HTTP 探测会被 ambient 代理劫持（代理未必可达内网
//     目标）。TCP 拨号判活不走 HTTP 栈天然免疫，HTTP 层探测须显式无代理
//     transport。不做 DshProxyPort 反代转发——本客户端只面对上游 base
//   - InsecureSkipVerify —— 外部目标自签 https 是合法形态（证书信任由浏览器
//     侧用户接受一次），x509 校验失败会让令牌判定恒 unknown、就绪判据恒失败
var probeHTTP = &http.Client{
	Timeout: probeTimeout,
	Transport: &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // 自签 https 外部目标合法形态，见上注
	},
}

// httpProbeReady HTTP 层就绪判据（P-20261118-6 双层判活）：任意 HTTP 响应
//（任意状态码）即就绪——node 已在应答请求。拨号通而 HTTP 持续不通 = 进程
// 在听但事件循环/磁盘被拖慢，是 launchAndWait NotReady 显式态的事实源。
// 走 probeHTTP（自签 https 外部目标可判、ambient 代理不劫持）
func httpProbeReady(base string) bool {
	resp, err := probeHTTP.Get(base)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return true
}

// probeAvailableBase 探活：TCP 拨号 base 的 host:port（P-20261118-4 由完整
// HTTP GET 改拨号——用户实测虚拟机磁盘卡顿拖慢 dsh（node）HTTP 响应 >1.5s，
// 短超时 GET 恒超时，落成「进程在、监听在、面板恒显未检测到」的假阴性；TCP
// connect 在内核 accept 队列完成，不依赖 node 事件循环/磁盘，卡顿环境恒快）。
// https base 拨号通后追加一次 TLS 握手（P-20261118-6，InsecureSkipVerify）：
// 纯拨号对「端口在听但不是 TLS 服务」会假阳性，浏览器同样进不去——握手失败
// 如实报 tls 归因（自签证书是合法形态，握手可成）。http base 零附加成本。
// 状态码语义不变——原实现本就不关心状态码，401/404 也算活着。
// 失败时返回归因诊断；err 原文截断 ≤200 字符（默认 transport 代理环境下
// err 可能含代理主机名，截断兼防泄漏与超长）
func probeAvailableBase(base string) (bool, dshProbeDiag) {
	diag := dshProbeDiag{Base: base}
	u, perr := url.Parse(strings.TrimSpace(base))
	if perr != nil || u.Host == "" {
		diag.ErrClass, diag.ErrText = "other", truncateProbeErrText(fmt.Sprintf("invalid base URL: %s", base))
		return false, diag
	}
	hostport := probeDialAddr(u)
	start := time.Now()
	conn, err := (&net.Dialer{Timeout: probeTimeout}).Dial("tcp", hostport)
	diag.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		diag.ErrClass, diag.ErrText = classifyProbeErr(err)
		return false, diag
	}
	if u.Scheme == "https" {
		_ = conn.SetDeadline(time.Now().Add(probeTimeout)) // 握手同样受短超时约束
		tconn := tls.Client(conn, &tls.Config{ServerName: u.Hostname(), InsecureSkipVerify: true}) // 自签合法形态，见 probeHTTP 注
		herr := tconn.Handshake()
		_ = tconn.Close()
		if herr != nil {
			diag.ErrClass, diag.ErrText = classifyProbeErr(herr)
			return false, diag
		}
	}
	_ = conn.Close()
	return true, diag
}

// probeWithRetry 同探测重试一次（间隔 probeRetryDelay）：低配机 node 冷启动/
// 高负载窗口的单发短超时易误判，重试一次即覆盖大部分抖动。作用域限定 /url
// 与 /status 两个 UI 判活入口——stopDsh 端口等待环与 launchAndWait 就绪环
// 内部已周期性多次探测，单次重试无增益反而拖慢收口节奏
func probeWithRetry(base string) (bool, dshProbeDiag) {
	ok, diag := probeAvailableBase(base)
	if ok {
		return ok, diag
	}
	time.Sleep(probeRetryDelay)
	return probeAvailableBase(base)
}

// probeDialAddr 已解析 base → 拨号 host:port（端口缺省按 scheme 补 80/443；
// IPv6 保括号形态——u.Host 自带括号，无端口时 Hostname() 剥括号后经
// JoinHostPort 复原）
func probeDialAddr(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	port := "80"
	if u.Scheme == "https" {
		port = "443"
	}
	return net.JoinHostPort(u.Hostname(), port)
}

// classifyProbeErr 探测失败归因分类（枚举 timeout/refused/tls/other 为主、
// err 原文摘录为辅；无法归类的都落 other）。tls 分支由 https base 的 TLS
// 握手步产生（P-20261118-6）——纯 TCP 拨号不握手不产生该类
func classifyProbeErr(err error) (class, text string) {
	text = truncateProbeErrText(err.Error())
	s := strings.ToLower(text)
	switch {
	case strings.Contains(s, "refused"):
		return "refused", text
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline exceeded"):
		return "timeout", text
	case strings.Contains(s, "tls") || strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
		return "tls", text
	default:
		return "other", text
	}
}

// truncateProbeErrText 诊断 err 原文截断（≤200 字符，按字符不按字节——
// Windows 本地化错误文案可能非 ASCII，字节截断会切半个 rune）
func truncateProbeErrText(s string) string {
	if len(s) <= 200 {
		return s
	}
	r := []rune(s)
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

// dshAuthPageMarker dsh 鉴权页固定输出（dsh web authentication required: ...）。
// 判定用内容标记而非状态码：dsh 鉴权页可能 200 也可能 401，随版本浮动
const dshAuthPageMarker = "dsh web authentication required"

// tokenStateFor 目标令牌状态（控制台「需重新授权」横幅的事实源）：
//   - unset：未配置令牌——带 token 参数也无法过 dsh 鉴权门，嵌入必现鉴权页
//   - stale：令牌已失效——dsh 每次启动更换令牌，dsh 侧重启后 SC 存的旧令牌即被拒
//   - valid：带令牌探测首页非鉴权页，令牌可用
//   - unknown：上游不可达（available=false 主导 UI，此处不判定）
//
// 探测 = 带令牌 GET 上游首页读前 8KB 找鉴权页标记；仅回环、短超时，挂在 /url
// 轮询（30s）上成本可忽略。令牌有效的响应是 30x + Set-Cookie 换发 30 天会话
// （实测 303 → Location /），跟随重定向必须手动回贴响应下发的 cookie：
// cookiejar 尊重 Secure 语义，明文 HTTP 上拒发 Secure cookie（curl -L 同理），
// 跟随请求落在鉴权页，令牌有效也被误判 stale——与 ModifyResponse 的 Secure
// 剥除是同一问题的两侧。
//
// 令牌自动回收：本机目标判 stale 时先尝试从启动日志重取最新令牌（SC 拉起
// 实例的 stdout 即令牌事实源，重启后新令牌必在其中），取到不同值即写回设置
// 并复探——SC 按钮重启/升级重启/进程级重启后零操作自愈（≤30s 轮询周期）。
// 边界：手动终端、doctor 救援等外部拉起的实例 stdout 不落在 SC 日志，日志里
// 就没有现行令牌，无法自愈——回落横幅一键重启（重启后实例归 SC 管，恢复自愈）。
func tokenStateFor(cfg dshConfig, id string) string {
	token := tokenForTarget(cfg, id)
	if strings.TrimSpace(token) == "" {
		return "unset"
	}
	base := baseForTarget(cfg, id)
	state := probeTokenState(base, token)
	if state == "stale" && id == localTargetID {
		if tok, ok := refreshLocalToken(); ok && tok != token {
			saveDshTokenFn(tok)
			if probeTokenState(base, tok) != "stale" {
				return "valid"
			}
		}
	}
	return state
}

// probeTokenState 带令牌探测上游首页（跟随换发重定向并回贴 cookie，见
// tokenStateFor 注释）。transport 取 probeHTTP（Proxy:nil + 自签 https 可判）
// ——令牌判定是 HTTP 层探测，ambient 代理会劫持外部 LAN 目标
func probeTokenState(base, token string) string {
	client := &http.Client{Timeout: probeTimeout, Transport: probeHTTP.Transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if resp := req.Response; resp != nil {
			for _, ck := range resp.Cookies() {
				req.AddCookie(ck)
			}
		}
		if len(via) >= 5 {
			return fmt.Errorf("stopped after 5 redirects")
		}
		return nil
	}}
	resp, err := client.Get(withTokenParam(base, token))
	if err != nil {
		return "unknown"
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if strings.Contains(strings.ToLower(string(body)), dshAuthPageMarker) {
		return "stale"
	}
	return "valid"
}
