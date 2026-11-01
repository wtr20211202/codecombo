// Package preview 开发服务器端口预览：把服务端本机回环端口（npm run dev /
// go run 等监听的 127.0.0.1:<port>）经既有 Web 面反代给任意访问设备——
// 自托管远程开发面的「VS Code 端口转发」等价物。
//
// 安全边界三原则（缺一不可，预览端口本质是把本机监听服务暴露到 Web 面）：
//  1. 仅回环：目标主机硬编码 127.0.0.1 / ::1 双栈回环（dev server 可能只绑
//     其一，Windows 上 vite 默认只监听 ::1），URL 只接受端口——不存在借道
//     路由到内网其他主机的表达方式；
//  2. 端口范围：1024~65535——特权端口（<1024）一律拒绝；
//  3. 锁保护：路由挂 LockMiddleware 保护组（含 cookie 载体回退，见
//     middleware.LockMiddlewareWithCookie），与 /api 同级同权限语义。
//
// 反代技法与 dsh 回环通道（server/api/tools/dsh.go）同款：httputil.ReverseProxy
// 原生透传 HTTP/1.1 upgrade——Vite HMR 等开发期 WS 无需手写 relay；响应剥
// X-Frame-Options 与 CSP frame-ancestors，使任意访问设备的浏览器可内嵌 iframe。
//
// 路径语义（双模式自适配）：默认剥前缀——上游收到相对自身根的路径，根路径
// 形态的静态服务/后端框架（go run、python -m http.server）零配置可用。上游
// 表现为「不认识该路径」（404，或 3xx 跳回带前缀的目标路径——vite --base
// 对齐形态的典型反应）且请求幂等（GET/HEAD）时，透明重试保留前缀路径——
// Vite 等绝对路径 dev server 以 --base=/preview/<端口>/ 启动即全链路可用
// （HTML/模块/HMR WS 均落在前缀下）。写方法与 WS 升级不重试：避免副作用
// 重复与 upgrade 通道二义。
package preview

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// 端口允许范围：特权端口不开放预览（保留给系统服务，误填也有明确报错）
const (
	MinPort = 1024
	MaxPort = 65535
)

// retryBodyCap 重试判定的响应缓冲上限：超过即放弃重试原样透传
// （404/3xx 文案体都很小，防的是病态大响应把内存吃穿）
const retryBodyCap = 256 << 10

// maxRetryRounds 保留前缀重试的最大轮数：覆盖「剥前缀 → 301 归一 → 重试」
// 的一跳链路即可，更多跳说明上游在自转圈，透传终止
const maxRetryRounds = 2

// routeKey 单次预览请求的路由信息（经 request context 传入 Director/ModifyResponse）
type routeKey struct{}

// routeInfo 一次预览请求的回环目标
type routeInfo struct {
	port int
	// upstreamPath 发往上游的路径（含首斜杠）：首轮剥 /preview/<port> 前缀
	//（相对根路径），重试轮保留完整前缀（--base 对齐形态消费）
	upstreamPath string
}

// loopbackTransport 限定双栈回环拨号：目标恒为 127.0.0.1 / ::1（先后尝试）。
// 只拨回环两侧，不放宽到名字解析
var loopbackTransport = &http.Transport{
	DialContext: loopbackDial,
}

func loopbackDial(ctx context.Context, _, addr string) (net.Conn, error) {
	// addr 的主机段来自 Director，恒为 127.0.0.1——取端口按序拨双栈回环
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	var lastErr error
	for _, host := range []string{"127.0.0.1", "::1"} {
		conn, dialErr := d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

// proxy 进程级单例：Director 每请求从 context 读目标（端口随请求变化），
// 连接复用由双栈回环 Transport 承担
var previewProxy = &httputil.ReverseProxy{
	// 流式即时冲刷：dev server 的 SSE/HMR 心跳、长日志输出不缓冲
	FlushInterval: -1,
	Transport:     loopbackTransport,
	Director: func(req *http.Request) { //nolint:staticcheck // SA1019：Director→Rewrite 迁移属行为敏感重构，另行专项
		info, _ := req.Context().Value(routeKey{}).(routeInfo)
		// 结构性回环：目标主机恒为 127.0.0.1，端口经 Handler 白名单校验后才可达
		req.URL.Scheme = "http"
		req.URL.Host = net.JoinHostPort("127.0.0.1", strconv.Itoa(info.port))
		req.URL.Path = info.upstreamPath
		req.Host = req.URL.Host
	},
	ModifyResponse: func(resp *http.Response) error {
		// 101 Switching Protocols（WS 升级）不经过此函数，防御性放行同 dsh 反代
		if resp.StatusCode == http.StatusSwitchingProtocols {
			return nil
		}
		// 剥帧限制头：本代理通道的结构性保证——任意设备的浏览器可 iframe 内嵌
		resp.Header.Del("X-Frame-Options")
		// CSP 仅摘除 frame-ancestors 指令，其余指令（script-src 等）保留——
		// 只解除「被嵌入」限制，不整体放弃目标应用自身的防护
		for i, policy := range resp.Header.Values("Content-Security-Policy") {
			resp.Header["Content-Security-Policy"][i] = stripFrameAncestors(policy)
		}
		rewriteRedirect(resp)
		return nil
	},
	ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		info, _ := r.Context().Value(routeKey{}).(routeInfo)
		slog.Warn("[preview] upstream unreachable", "port", info.port, "err", err)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "preview upstream 127.0.0.1:"+strconv.Itoa(info.port)+" unreachable")
	},
}

// pathMode 上游路径语义：root = 相对自身根（剥前缀，默认）；
// preserve = 按 --base=/preview/<port>/ 对齐（保留完整前缀）
type pathMode int

const (
	modeStrip pathMode = iota
	modePreserve
)

// modeHints 每端口已验证的路径语义（进程内记忆）：试错解析一次后，同端口
// 后续请求——尤其 WS 升级（vite 只在 base 路径上接受 upgrade，挂起不回 404，
// 无从试错）——直接走对的语义。条目极小且随端口离散，不做 TTL；
// 端口易主时首轮试错自愈并覆写
var modeHints sync.Map // int(port) -> pathMode

// Handler 端口预览反代入口。路由：/preview/:port/*path → http://127.0.0.1:port/*path
func Handler(c *gin.Context) {
	port, err := parsePort(c.Param("port"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"err": "invalid port", "msg": err.Error()})
		return
	}
	prefix := "/preview/" + strconv.Itoa(port)
	rel := "/" + strings.TrimPrefix(c.Param("path"), "/")

	// 首轮按记忆语义（默认剥前缀）；上游不认识该路径（404，或 3xx 跳回带
	// 前缀路径——vite --base 对齐形态的典型反应）且请求幂等时，换另一种语义
	// 重试。重试轮丢弃上一轮响应（含头），重试耗尽或不可重试时缓冲原样落盘；
	// 某语义应答成功即记忆（含 WS Hijack 形态的成功）
	req := c.Request
	idempotent := req.Method == http.MethodGet || req.Method == http.MethodHead
	mode := modeStrip
	if m, ok := modeHints.Load(port); ok {
		mode = m.(pathMode)
	}
	w := &retryWriter{writer: c.Writer}
	serveMode := func(m pathMode) {
		path := rel
		if m == modePreserve {
			path = prefix + rel
		}
		previewProxy.ServeHTTP(w, withRoute(req, routeInfo{port: port, upstreamPath: path}))
	}
	serveMode(mode)
	for round := 0; idempotent && wrRetryable(w, prefix) && round < maxRetryRounds; round++ {
		w.reset()
		if mode == modeStrip {
			mode = modePreserve
		} else {
			mode = modeStrip
		}
		serveMode(mode)
	}
	if w.resolved() {
		modeHints.Store(port, mode)
	}
	w.flushBuffered()
}

// withRoute 为请求注入本轮回环目标
func withRoute(req *http.Request, info routeInfo) *http.Request {
	return req.WithContext(context.WithValue(req.Context(), routeKey{}, info))
}

// wrRetryable 该轮响应是否值得换语义重试：
//   - 404：上游不认识当前语义的路径；
//   - 3xx 且 Location 指回预览前缀（剥前缀路径被上游按 base 归一跳转，照原样
//     回给浏览器会经代理剥前缀再次命中同一跳，构成循环——代理侧就地跟随一跳）。
//
// 超缓冲/Hijack（WS）/已直通一票否决。调用方限定幂等方法
func wrRetryable(w *retryWriter, prefix string) bool {
	if !w.canRetry() {
		return false
	}
	if w.status == http.StatusNotFound {
		return true
	}
	if w.status >= 300 && w.status <= 399 {
		loc := w.Header().Get("Location")
		return loc != "" && (strings.HasPrefix(loc, prefix+"/") || loc == prefix)
	}
	return false
}

// wrCandidate 与 wrRetryable 同判定（不依赖 prefix 的保守形态：3xx 一律视为
// 候选，用于 resolved 判定——记忆语义时 Location 已被放行或改写，不精确区分）
func wrCandidate(w *retryWriter) bool {
	if !w.canRetry() {
		return false
	}
	return w.status == http.StatusNotFound || (w.status >= 300 && w.status <= 399)
}

// retryWriter 响应拦截包装：可能重试的响应（404/前缀对齐 3xx）缓冲不落盘，
// 交由 Handler 决定重试；其余状态码与流式写直通。Hijack/Flush 透传保持
// WS 升级与 SSE 行为不变。每轮持有独立 Header 隔离轮间污染
type retryWriter struct {
	writer http.ResponseWriter
	hdr    http.Header // 本轮响应头（与底层隔离，重试轮不残留上一轮头）
	status int
	buf    []byte
	over   bool // 缓冲超限：放弃重试
	hijack bool
	done   bool // 已直通底层（后续写原样透传）
}

// canRetry 尚未落盘且未超缓冲/未 Hijack，响应完整握在手里
func (w *retryWriter) canRetry() bool { return !w.done && !w.over && !w.hijack && w.status != 0 }

// resolved 本轮已产生确定应答（成功直通，或 WS 升级已 Hijack 成通道——此时
// 无 HTTP 状态可言），可作为该端口路径语义的判定依据；候选重试态（404/对齐
// 3xx 挂起）不算
func (w *retryWriter) resolved() bool {
	if w.hijack {
		return true
	}
	return w.status != 0 && !wrCandidate(w)
}

// reset 丢弃本轮挂起响应进入下一轮（仅可在 canRetry 为真时调用）
func (w *retryWriter) reset() {
	w.status = 0
	w.hdr = nil
	w.buf = nil
}

func (w *retryWriter) Header() http.Header {
	if w.hdr == nil {
		w.hdr = make(http.Header)
	}
	return w.hdr
}

func (w *retryWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.done {
		return w.writer.Write(b)
	}
	switch {
	case w.status == http.StatusNotFound || (w.status >= 300 && w.status <= 399):
		// 候选重试响应：缓冲（超限放弃重试，连同状态落盘）
		if len(w.buf)+len(b) > retryBodyCap {
			w.over = true
			w.flushBuffered()
			return w.writer.Write(b)
		}
		w.buf = append(w.buf, b...)
		return len(b), nil
	default:
		w.flushBuffered()
		return w.writer.Write(b)
	}
}

func (w *retryWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status == http.StatusNotFound || (status >= 300 && status <= 399) {
		w.status = status // 挂起：等重试判定，期间不落盘
		return
	}
	w.status = status
	w.flushBuffered()
}

// flushBuffered 把挂起/缓冲的响应落到底层 Writer（直通后幂等）
func (w *retryWriter) flushBuffered() {
	if w.status == 0 || w.done {
		return
	}
	w.done = true
	dst := w.writer.Header()
	for k := range dst {
		delete(dst, k)
	}
	for k, vv := range w.hdr {
		dst[k] = vv
	}
	w.writer.WriteHeader(w.status)
	if len(w.buf) > 0 {
		_, _ = w.writer.Write(w.buf)
		w.buf = nil
	}
}

func (w *retryWriter) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	// 挂起缓冲期忽略 Flush（ReverseProxy 的 FlushInterval=-1 会在写头后立即
	// 冲刷——据此放行会打断重试判定）；流式响应在首个普通写时已落盘，透传
	if f, ok := w.writer.(http.Flusher); ok && w.done {
		f.Flush()
	}
}

func (w *retryWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijack = true
	h, ok := w.writer.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("preview: underlying writer not a Hijacker")
	}
	return h.Hijack()
}

// parsePort 端口校验：十进制数字且落在 [MinPort, MaxPort]
func parsePort(raw string) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if n < MinPort || n > MaxPort {
		return 0, strconv.ErrRange
	}
	return n, nil
}

// stripFrameAncestors 从 CSP 策略串中摘除 frame-ancestors 指令（指令名大小写
// 不敏感），其余指令原样保留；整条策略只含 frame-ancestors 时返回空串
func stripFrameAncestors(policy string) string {
	directives := strings.Split(policy, ";")
	kept := make([]string, 0, len(directives))
	for _, d := range directives {
		// 先去指令两侧空白（"; frame-ancestors …" 的首空格会让指令名提取为空串），
		// 再取首个空白前的指令名
		d = strings.TrimSpace(d)
		name := d
		if i := strings.IndexAny(d, " \t"); i >= 0 {
			name = d[:i]
		}
		if strings.EqualFold(name, "frame-ancestors") {
			continue
		}
		kept = append(kept, d)
	}
	return strings.Join(kept, "; ")
}

// rewriteRedirect 上游 3xx 的相对 Location 补回预览前缀，浏览器才不会跳出
// /preview/<port>/ 路径空间（如 dev server 的 trailing-slash 归一 301）。
// Location 已带预览前缀（上游按 --base 对齐形态自行跳转）则原样放行——该形态
// 由 Handler 的保留前缀重试就地跟随，不靠浏览器跳转（会成剥前缀循环）
func rewriteRedirect(resp *http.Response) {
	if resp.StatusCode < 300 || resp.StatusCode > 399 {
		return
	}
	loc := resp.Header.Get("Location")
	if loc == "" || !strings.HasPrefix(loc, "/") {
		return // 绝对地址（含协议）不动：上游指到别处是它自己的意图
	}
	info, _ := resp.Request.Context().Value(routeKey{}).(routeInfo)
	prefix := "/preview/" + strconv.Itoa(info.port)
	if strings.HasPrefix(loc, prefix+"/") || loc == prefix {
		return
	}
	resp.Header.Set("Location", prefix+loc)
}
