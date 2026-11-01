package tools

// 嵌入通道的「页面改写与注入」面——原 dsh.go「Secure-Context 降级改写」节 +
// 独立标签页访问守卫与引导页模板（原属「多目标路由」节尾部）整体平移
// （P-20261003-314 纯搬运拆分，逻辑零改动）。判定键 browserHostKey 与改写
// 触发方（反代 ModifyResponse / dshProxyHandler）在 dsh_proxy.go。

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	"codecombo/server/config"
	"codecombo/server/store"
)

// secureCtxPolyfill Secure-Context API 降级（吸收自 dsh-web 脚本）：明文 HTTP
// 非安全上下文中 crypto.randomUUID / navigator.clipboard 不可用，dsh 前端裸调用
// 会报 "crypto.randomUUID is not a function"。randomUUID 基于 getRandomValues
// （非安全上下文仍可用）降级，clipboard 走 textarea+execCommand；运行时判定，
// 回环（安全上下文）注入无害
const secureCtxPolyfill = `<script>(function(){` +
	`if(!crypto.randomUUID){crypto.randomUUID=function(){` +
	`var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;` +
	`var h=Array.prototype.map.call(b,function(x){return(("0"+x.toString(16)).slice(-2))});` +
	`return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10,16).join("")};}` +
	`if(!navigator.clipboard||!navigator.clipboard.writeText){` +
	`navigator.clipboard={writeText:function(t){return new Promise(function(res,rej){` +
	`var ta=document.createElement("textarea");ta.value=t;ta.style.position="fixed";ta.style.opacity="0";` +
	`document.body.appendChild(ta);ta.select();` +
	`try{document.execCommand("copy")?res():rej(new Error("copy failed"))}catch(e){rej(e)}finally{ta.remove()}})}}}` +
	`})();</script>`

// isLoopbackJSRewrite settings 页客户端门禁：connection 模块用
// location.hostname 判断 isLoopback，非回环时设置镜像进入 memory/unavailable
// 模式（报 "settings are unavailable in this browser"）。location 属性是
// [LegacyUnforgeable] 无法浏览器侧伪装，且无官方开关——对模块 JS 做定向源码
// 改写（dsh 0.1.2 起客户端模块按合并包下发，一个响应混装几十个模块，按 URL
// 判归属必漏改写——必须对全部 JS 统一改写）
const isLoopbackJSRewrite = "isLoopbackHostname(pageLocation.hostname)"

// remoteBootPatch remote-web-ui 插件注入 HTML 的 boot 补丁：非回环 hostname 时
// 全局劫持 fetch/WS 到 /remote 前缀。恒真跳过让全部请求自始至终走 /api，消除
// "先劫持后 restore"的时序窗口（插件已配 requirePairingForLan:false，即使该
// 模式将来失效，客户端 apply 后也会 restore() 撤掉劫持——此为优化非依赖；
// 片段在 HTML 中唯一，单次替换即可）
const remoteBootPatchOld = "h=loc.hostname;if("
const remoteBootPatchNew = "h=loc.hostname;if(true||"

// stripCookieAttribute 按名移除 cookie 属性（大小写不敏感；值属性仅比对键名，
// 首段 name=value 的键名不等于属性名故天然保留）。供会话 cookie Secure 降级用
func stripCookieAttribute(ck, attr string) string {
	parts := strings.Split(ck, ";")
	kept := parts[:0]
	for _, p := range parts {
		if k, _, _ := strings.Cut(p, "="); strings.EqualFold(strings.TrimSpace(k), attr) {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(kept, ";")
}

// setsDshAuthCookie 响应是否下发了 dsh-auth- 会话 cookie（令牌换发成功的标志：
// 实测成功形态为 303 + Set-Cookie(dsh-auth-<实例后缀>=…) + Location /）
func setsDshAuthCookie(resp *http.Response) bool {
	for _, ck := range resp.Header.Values("Set-Cookie") {
		if strings.HasPrefix(ck, "dsh-auth-") {
			return true
		}
	}
	return false
}

// rewriteRejectedTokenExchange 把「令牌被拒」的换发响应改写为 401 文案。
// 判据：请求带 token= 且上游 30x 且未下发会话 cookie——成功的换发必发 cookie，
// 弹回必不发。只影响换发路径（token 查询参数仅在签发门 302 与手动粘贴 URL
// 时出现），站点正常 30x 一律不碰
func rewriteRejectedTokenExchange(resp *http.Response) {
	if resp.Request == nil || resp.StatusCode < 300 || resp.StatusCode >= 400 ||
		!strings.Contains(resp.Request.URL.RawQuery, "token=") || setsDshAuthCookie(resp) {
		return
	}
	resp.StatusCode = http.StatusUnauthorized
	resp.Status = strconv.Itoa(http.StatusUnauthorized) + " " + http.StatusText(http.StatusUnauthorized)
	resp.Header.Del("Location")
	const msg = "dsh token rejected: the running dsh instance does not honor the token Codecombo holds.\n" +
		"Click the re-capture button in the dsh console banner (it restarts dsh and captures its fresh launch token)."
	resp.Body = io.NopCloser(strings.NewReader(msg))
	resp.ContentLength = int64(len(msg))
	resp.Header.Set("Content-Length", strconv.Itoa(len(msg)))
	resp.Header.Set("Content-Type", "text/plain; charset=utf-8")
}

// injectHeadStyle 在 HTML 的 <head> 后插入内容（大小写不敏感；标签名边界
// 校验避免误中 <header>；无 <head> 时回退到文档开头——浏览器容错解析同样生效）。
// 原字节未变时原样返回。
func injectHeadStyle(body []byte, style string) []byte {
	lower := bytes.ToLower(body)
	idx := bytes.Index(lower, []byte("<head"))
	if idx < 0 {
		return append([]byte(style), body...)
	}
	gt := bytes.IndexByte(lower[idx:], '>')
	if gt < 0 {
		return append([]byte(style), body...)
	}
	// 标签名边界：<head 后必须紧跟 '>' 或空白（<header 以字母延续，排除）
	if c := lower[idx+5]; c != '>' && c != ' ' && c != '\t' && c != '\n' && c != '\r' {
		return append([]byte(style), body...)
	}
	pos := idx + gt + 1
	out := make([]byte, 0, len(body)+len(style))
	out = append(out, body[:pos]...)
	out = append(out, style...)
	out = append(out, body[pos:]...)
	return out
}

// isLoopbackBrowserHost 浏览器面向地址是否回环（127.0.0.1/::1/localhost）。
// 空地址按回环处理（内部调用方缺 Host 头的场景不做降级改写）
func isLoopbackBrowserHost(authority string) bool {
	if authority == "" {
		return true
	}
	h := authority
	if hm, _, err := net.SplitHostPort(authority); err == nil {
		h = hm
	}
	h = strings.Trim(h, "[]")
	switch strings.ToLower(h) {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

// hostnameOf 从 authority（host[:port]）提取主机名
func hostnameOf(authority string) string {
	if h, _, err := net.SplitHostPort(authority); err == nil {
		return h
	}
	return strings.Trim(strings.TrimSpace(authority), "[]")
}

// isStandaloneNavigation 顶层导航请求判定（浏览器标签直开）：Sec-Fetch-Dest:
// document 明确表示顶层文档导航；iframe 嵌入为 iframe/frame，子资源/XHR/WS
// 为 script/style/empty 等——一律放行（它们只发生在已加载的 dsh 页面内）。
// 不发 Sec-Fetch 头的浏览器（旧 Safari）无法区分：宽容放行——守卫是礼貌层
// 非安全边界，真边界是 dsh 自身令牌
func isStandaloneNavigation(r *http.Request) bool {
	return r.Header.Get("Sec-Fetch-Dest") == "document"
}

// renderStandaloneBlockedPage 独立访问被守卫拦截时的友好引导页：
// 跟随浏览器系统深浅色（prefers-color-scheme），语言按 Accept-Language 探测
// （zh 优先），链接回 SC 主端口首页。SC 主端口取自配置——反代端口 != 主端口，
// 请求 Host 的主机名 + 主端口构成回跳地址
func renderStandaloneBlockedPage(w http.ResponseWriter, r *http.Request) {
	lang := "en"
	if strings.Contains(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		lang = "zh"
	}
	mainPort := readConfigMainPort()
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	scheme := "http"
	if config.TLSEnabled() {
		scheme = "https"
	}
	scHome := fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(host, strconv.Itoa(mainPort)))
	page := buildStandaloneBlockedHTML(lang, scHome)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(page))
}

// readConfigMainPort 主服务端口（引导页回跳链接用；未配置回落 9999 默认值）
func readConfigMainPort() int {
	if sc := store.Get().Settings.Get(); sc != nil && sc.Server.Port > 0 {
		return sc.Server.Port
	}
	return 9999
}

// buildStandaloneBlockedHTML 引导页模板：零依赖内联样式，深浅色自适应
func buildStandaloneBlockedHTML(lang, scHome string) string {
	zh := lang == "zh"
	title, desc, hint, btn := "dsh Embed Channel", "", "", "Open Codecombo"
	if zh {
		title = "dsh 嵌入通道"
		desc = "此地址是 Codecombo 的 dsh 嵌入专用通道，请在 Codecombo 的 dsh 控制台中使用。"
		hint = "如需在独立标签页访问 dsh，请在 Codecombo 设置 → 终端 中开启「允许独立标签页访问 dsh」。"
		btn = "打开 Codecombo"
	} else {
		desc = "This address is the dsh embed channel of Codecombo. Please use dsh from the dsh console inside Codecombo."
		hint = "To open dsh in a standalone tab, enable \"Allow standalone tab access\" in Codecombo Settings → Terminal."
	}
	return `<!DOCTYPE html><html lang="` + lang + `"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + title + `</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
background:#f5f6f8;color:#1f2329;padding:24px}
@media (prefers-color-scheme:dark){body{background:#141518;color:#e8e9ec}}
.card{max-width:460px;padding:32px 36px;border-radius:12px;text-align:center;
background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){.card{background:#1e2025;box-shadow:0 2px 12px rgba(0,0,0,.4)}}
h1{font-size:17px;margin-bottom:14px}
p{font-size:13px;line-height:1.7;color:#5a6068;margin-bottom:10px}
@media (prefers-color-scheme:dark){p{color:#9aa0a8}}
a.btn{display:inline-block;margin-top:12px;padding:8px 18px;border-radius:6px;
background:#4d6bfe;color:#fff;font-size:13px;text-decoration:none}
a.btn:hover{opacity:.88}
</style></head><body><div class="card">
<h1>` + title + `</h1>
<p>` + desc + `</p>
<p>` + hint + `</p>
<a class="btn" href="` + scHome + `">` + btn + `</a>
</div></body></html>`
}
