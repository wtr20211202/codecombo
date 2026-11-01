package share

// 一次性分享的显式确认（P-20261020-3）：防 IM/邮件预览抓取烧掉一次性链接。
//
// 背景：把一次性短链发到 IM/邮件后，聊天工具与邮件安全网关会先 GET 链接
// 生成预览。若 GET 即武装（P-20261006-27 的旧行为），10 分钟宽限窗在收件人
// 看到之前就走完，链接变成 410「已被查看并失效」；访问次数/最近访问也被
// 预览流量污染。
//
// 收口：ViewOnce 记录的武装/计数不再挂在 GET 页面/下载上，只发生在
// POST /s/{token}/view——GET /s/{token} 未确认态只出轻量确认页（不计数、
// 不武装、不渲染内容、不泄露文件名）；确认成功才 MarkFirstView + hits/
// recordView 入账，发短时效查看 cookie（Path=/s/{token}，HttpOnly，
// SameSite=Lax）后 303 回内容页。内容页对 ViewOnce 要求该 cookie：未确认
// →确认页，已武装且在宽限窗→内容，窗后→既有 consumed 410 专页；刷新/同窗
// 重开不重复武装、不重复计数。
//
// 查看 cookie 与口令门会话分离（不同 cookie 名 + 不同签名域标签）：口令
// 分享的 gate 会话不能被当作一次性确认，反之 view cookie 也不解锁口令门。
// 确认 POST 不携带秘密，限流（复用 middleware.RateLimiter）只防「知道 token
// 的人」高频刷访问计数，正常访客一次点击。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

const (
	// viewCookieTTL 查看 cookie 有效期：与宽限窗同长——窗后记录本身已
	// consumed（lookup 先行 410），cookie 再长也没有可看内容；短时效缩小
	// 共享设备上的残留窗口
	viewCookieTTL = store.ViewOnceGrace

	// viewMaxConfirms / viewConfirmWindow 显式确认限流参数：每 (token, IP)
	// 每窗口 10 次。确认动作不携带秘密，限流防高频 POST 刷访问计数；正常
	// 访客一次点击，同窗重复提交在 cookie 幂等分支短路（不计入这里）
	viewMaxConfirms   = 10
	viewConfirmWindow = time.Minute
)

// viewSessions 查看 cookie 的签发/校验 + 确认 POST 限流（Service 持有一枚）。
// 签名密钥与 gateSessions 同款惰性派生：NewService 在测试里高频构造，不该
// 让每个构造都触发 master-key 落盘——首个查看操作才碰 config
type viewSessions struct {
	once     sync.Once
	key      []byte
	confirms *middleware.RateLimiter
}

func newViewSessions() *viewSessions {
	return &viewSessions{confirms: middleware.NewRateLimiter(viewMaxConfirms, viewConfirmWindow)}
}

// deriveViewKey 查看 cookie 签名密钥：HMAC-SHA256(masterKey, 域分离标签)。
// 标签与 gate 的 share-gate-cookie-v1 不同——同一 master-key 的两个用途
// 互相不可推导（查看 cookie 不能冒充口令门会话，反之亦然）
func deriveViewKey(master []byte) []byte {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte("share-view-cookie-v1"))
	return mac.Sum(nil)
}

func (v *viewSessions) signKey() []byte {
	v.once.Do(func() { v.key = deriveViewKey(config.MasterKey()) })
	return v.key
}

// viewCookieName / viewCookiePath 按 token 命名与锚定路径（与 gate cookie
// 同款隔离：同一浏览器可同时持有多条一次性分享的确认态，互不顶掉；cookie
// 只随该分享的请求出没，分享撤销后浏览器侧自然失效）
func viewCookieName(token string) string { return "sc_view_" + token }
func viewCookiePath(token string) string { return "/s/" + token }

// sign 签名覆盖 token + 过期时点：改 exp 必须重签，签不出；token 换链
// （rotate）即旧 cookie 自然失效。与 gate 签名输入刻意不同源（不含口令
// 哈希）——两类会话的语义维度不同，不能互相推导
func (v *viewSessions) sign(token string, exp int64) string {
	mac := hmac.New(sha256.New, v.signKey())
	fmt.Fprintf(mac, "%s\x00%d", token, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// issue 签发查看 cookie（显式确认成功路径）。HttpOnly 防脚本侧窃取；
// SameSite=Lax（确认页表单回程 303 后同站 GET 需携带）；Secure 跟随子服务
// TLS 态（与 gate.issue 同口径）
func (v *viewSessions) issue(sh *store.Share, now time.Time, secure bool) *http.Cookie {
	exp := now.Add(viewCookieTTL)
	expUnix := exp.Unix()
	val := strconv.FormatInt(expUnix, 10) + "." + v.sign(sh.Token, expUnix)
	return &http.Cookie{
		Name:     viewCookieName(sh.Token),
		Value:    val,
		Path:     viewCookiePath(sh.Token),
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}
}

// valid 校验请求携带的查看 cookie：格式/签名/有效期全过才放行。hmac.Equal
// 常数时间比较；过期或签名不符统一 false 不区分原因（不向外泄露「哪个
// 环节没过」）。记录绑定由调用方叠加（见 viewConfirmed）
func (v *viewSessions) valid(r *http.Request, sh *store.Share) bool {
	c, err := r.Cookie(viewCookieName(sh.Token))
	if err != nil || c.Value == "" {
		return false
	}
	dot := strings.IndexByte(c.Value, '.')
	if dot <= 0 || dot == len(c.Value)-1 {
		return false
	}
	exp, err := strconv.ParseInt(c.Value[:dot], 10, 64)
	if err != nil || exp <= time.Now().Unix() {
		return false
	}
	want := v.sign(sh.Token, exp)
	return hmac.Equal([]byte(want), []byte(c.Value[dot+1:]))
}

// viewConfirmed 请求方是否已完成一次性分享的显式确认：记录已武装
// （ViewedAt 非零）且携带有效查看 cookie。ViewedAt 零值即便有旧 cookie
// （管理面关闭再开启一次性等边界）也不放行——重新确认会重新武装
func (s *Service) viewConfirmed(r *http.Request, sh *store.Share) bool {
	return sh.ViewOnce && !sh.ViewedAt.IsZero() && s.view.valid(r, sh)
}

// handleViewPost 一次性分享显式确认（POST /s/{token}/view）：确认页表单的
// 唯一提交端点。校验 token/口令门（口令分享先过既有 gate）后：
//   - 已确认（有效查看 cookie）：303 回内容页，不重复武装/计数（浏览器
//     回退重放/双击的幂等口）；
//   - 首次确认：限流 → MarkFirstView 武装 → hits/recordView 入账 → 发查看
//     cookie → 303 回内容页（PRG：刷新走 GET 不重放确认）。
//
// 错误面与 handlePage 同款：过期/已消费/不存在分别 410 专页/404 品牌页。
// 一次性已消费后确认入口不借尸还魂（lookup 先行 410）。
func (s *Service) handleViewPost(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	sh, herr := s.lookup(r, token)
	if herr != nil {
		if herr == errShareExpired {
			s.writeExpired(w, r)
			return
		}
		if herr == errShareConsumed {
			s.writeConsumed(w, r)
			return
		}
		s.writeNotFound(w, r)
		return
	}
	if sh.PassphraseHash != "" && !s.gate.valid(r, sh) {
		// 门会话缺失/过期：回内容页入口（该入口会再出口令页），确认动作
		// 不落账——口令门先于一次性确认，两层不合并
		http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
		return
	}
	if !sh.ViewOnce {
		// 非一次性记录确认无意义：直通内容页（幂等，不计数）
		http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
		return
	}
	if s.viewConfirmed(r, sh) {
		http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
		return
	}
	key := gateFailKey(sh.Token, r)
	if n := s.view.confirms.Hit(key); n > viewMaxConfirms {
		remain := int64(time.Until(s.view.confirms.ExpireAt(key)).Seconds() + 0.999)
		if remain < 1 {
			remain = 1
		}
		w.Header().Set("Retry-After", strconv.FormatInt(remain, 10))
		s.writeConfirm(w, r, http.StatusTooManyRequests, true)
		return
	}
	// 显式确认 = 人类「我要看」动作：武装、计数、留痕三件事只在此点发生
	// （GET 路径不再触达——预览抓取不会烧掉链接，也不会污染 hits/审计）
	s.armViewOnce(sh)
	s.hits.Count(sh.Token)
	s.recordView(r, sh)
	http.SetCookie(w, s.view.issue(sh, time.Now(), r.TLS != nil))
	http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
}

// writeConfirm 确认页输出（状态码随分支：200 首次进入 / 429 确认限流）。
// CSP 与口令页同款放行同源表单（默认页 form-action 'none' 是页面无交互
// 表单的锁死姿态，确认页是第二个例外）；零外部依赖单文件页。
func (s *Service) writeConfirm(w http.ResponseWriter, r *http.Request, status int, limited bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; "+
			"form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	_ = renderConfirmPage(w, r.PathValue("token"), prefLang(r), int(store.ViewOnceGrace/time.Minute), limited)
}
