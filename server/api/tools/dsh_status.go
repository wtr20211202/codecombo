package tools

// 状态探测——原 dsh.go 同名节整体平移（P-20261003-314 纯搬运拆分，逻辑零
// 改动）：/status 判活与 /url 反代地址端点 + 目标令牌状态判定（控制台
// 「需重新授权」横幅的事实源）。

import (
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
// 对本机目标做短超时 HTTP 探测：available 判活（不关心状态码，401/404 也算活着）。
// 嵌入通道固定走反代（结构保证可用），探测仅用于 UI 判活与延迟展示。
func DshStatus(c *gin.Context) {
	cfg := readConfig()
	client := &http.Client{Timeout: probeTimeout}
	start := time.Now()
	resp, err := client.Get(cfg.Base)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{
			"available": false,
			"upstream":  cfg.Base,
			"proxyURL":  proxyURLIfEnabled(cfg),
			"latencyMs": latency,
		}})
		return
	}
	defer resp.Body.Close()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"available": true,
		"upstream":  cfg.Base,
		"proxyURL":  proxyURLIfEnabled(cfg),
		"latencyMs": latency,
	}})
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

	// 目标地址构造：默认回环（同机浏览器）；开放所有 IP 时按请求 Host 回构造，
	// LAN 浏览器经 http://<SC机>:<端口> 访问。开关切换即时生效（重绑定），
	// 本系统无需重启。
	// 回环访问沿用浏览器实际使用的回环名（localhost / 127.0.0.1）：二者互为
	// 跨 site——iframe 用与宿主页面不同的 site 会被现代 Chromium 按第三方
	// 上下文处理，302 签发门的 SameSite=Strict cookie 无法随重定向携带，
	// 陷入「签发→丢弃→再签发」死循环
	host := "127.0.0.1"
	if cfg.ProxyEnabled {
		if h := hostnameOf(c.Request.Host); h != "" && isLoopbackBrowserHost(c.Request.Host) {
			host = h
		} else if cfg.ExposeAll && h != "" {
			host = h
		}
	}
	target := cfg.Base
	if cfg.ProxyEnabled {
		target = proxyScheme() + "://" + net.JoinHostPort(host, strconv.Itoa(cfg.ProxyPort)) + "/"
		if tid := c.Query("target"); tid != "" && tid != localTargetID && targetExists(cfg, tid) {
			// 多目标路由：查询参数落 cookie，iframe 内部后续请求自动携带；
			// 已删除/未知目标不拼参数（服务端本就回退本机，URL 保持干净）
			target += "?" + scTargetQuery + "=" + url.QueryEscape(tid)
		}
		// token 门仅对回环 Host 签发（防 DNS rebinding）：LAN 浏览器（开放模式）
		// 的令牌经本接口注入——本接口在 SC 锁鉴权之后，凭据只在授权链路上分发
		if cfg.Token != "" && !isLoopbackBrowserHost(c.Request.Host) {
			target = withTokenParam(target, cfg.Token)
		}
	} else {
		// 直连上游无签发门，回退为 URL 注入令牌（原行为）
		target = withTokenParam(target, tokenForTarget(cfg, tid))
	}

	proxyMu.Lock()
	degraded, degradedReason := proxyDegraded != "", proxyDegraded
	proxyMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"url":            target,
		"available":      probeAvailableBase(baseForTarget(cfg, tid)),
		"upstream":       baseForTarget(cfg, tid),
		"exposeAll":      cfg.ProxyEnabled && cfg.ExposeAll,
		"degraded":       degraded,
		"degradedReason": degradedReason,
		"tokenState":     tokenState,
		"proxyScheme":    proxyScheme(),
		"tlsServedOnce":  tlsServedOnce.Load(),
	}})
}

func probeAvailableBase(base string) bool {
	client := &http.Client{Timeout: probeTimeout}
	resp, err := client.Get(base)
	if err == nil {
		defer resp.Body.Close()
		return true
	}
	return false
}

// probeAvailable 兼容旧调用的本机目标探活
func probeAvailable(cfg dshConfig) bool {
	return probeAvailableBase(cfg.Base)
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
// tokenStateFor 注释）
func probeTokenState(base, token string) string {
	client := &http.Client{Timeout: probeTimeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
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
