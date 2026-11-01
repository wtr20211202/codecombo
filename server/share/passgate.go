package share

// 访问口令门（P-20261006-25）：高敏分享的二级验证——「知道链接」之外再要
// 「知道口令」。本文件承载访客面的门机制：签名会话 cookie 的签发/校验、
// 错口令限流、口令验证端点与守卫中间件；口令页 HTML 在 page.go。
//
// 威胁模型与取舍：
//   - 口令以 bcrypt 哈希随分享记录落库（store.Share.PassphraseHash，管理面
//     创建/改口令时哈希），访客面只做比对，明文不落盘不进日志；
//   - 门会话 cookie 值 = 过期时点 + HMAC(signKey, token|hash|exp)。签名输入
//     绑定 token（rotate 换链即失效）与记录当前口令哈希（改/移除口令即全体
//     已发会话失效）——不需要任何服务端会话表，撤销/过期由 lookup 收口；
//   - 签名密钥从部署级 master-key 派生（域分离标签，勿新秘密源——与分享
//     短链 token 派生同源异域，config.MasterKey 注释「派生型用途」同款）；
//   - 错口令限流复用 middleware.RateLimiter（lock 域解锁失败限流同款：仅
//     失败计数、成功不计），按 (token, IP) 维度——token 维度防单口令爆破，
//     IP 维度防局外人灌错口令锁死全部正常访客。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"golang.org/x/crypto/bcrypt"
)

const (
	// gateCookieTTL 访客门会话有效期。口令常用「另一渠道口头传达」，收件人
	// 往往隔天才看——24h 平衡重验烦扰与暴露窗口（任务书取值）
	gateCookieTTL = 24 * time.Hour

	// gateMaxFailures / gateFailWindow 错口令限流参数：每 (token, IP) 每窗口
	// 10 次失败后到窗口末 429——与 middleware/auth.go 的解锁失败限流同参数
	// 同语义（仅失败计数）。bcrypt 比对本身 ~数十 ms 也是天然节流，限流是
	// 把在线爆破压到不可行量级（10^9 量级口令空间 × 10 次/分钟 ≫ 宇宙热寂）
	gateMaxFailures = 10
	gateFailWindow  = time.Minute

	// gateBodyLimit 口令提交体读取上限：口令输入不需要长（bcrypt 只吃前 72
	// 字节），上限防把验证端点当免费读体通道滥用
	gateBodyLimit = 8 << 10
)

// 错误文案代号（口令页渲染分支）："" = 首次进入无错
const (
	gateErrWrong   = "wrong"   // 口令不正确
	gateErrLimited = "limited" // 失败过多被限流
)

// gateSessions 门会话签发/校验 + 错口令限流（Service 持有一枚）。
// 签名密钥经 signKey 惰性派生：NewService 在测试里高频构造，不该让每个
// 构造都触发 master-key 落盘——首个门操作才碰 config
type gateSessions struct {
	once  sync.Once
	key   []byte
	fails *middleware.RateLimiter // 仅错口令计数（成功不计），auth.go 同款
}

func newGateSessions() *gateSessions {
	return &gateSessions{fails: middleware.NewRateLimiter(gateMaxFailures, gateFailWindow)}
}

// deriveGateKey 门会话签名密钥：HMAC-SHA256(masterKey, 域分离标签)。
// 与 DeriveShareToken 同一 master-key、不同域——互相不可推导
func deriveGateKey(master []byte) []byte {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte("share-gate-cookie-v1"))
	return mac.Sum(nil)
}

func (g *gateSessions) signKey() []byte {
	g.once.Do(func() { g.key = deriveGateKey(config.MasterKey()) })
	return g.key
}

// gateCookieName / gateCookiePath cookie 按 token 命名与锚定路径：同一浏览器
// 可同时持有多条口令分享的会话（全局单名会互相顶掉），Path 锚定 /s/<token>
// 让 cookie 只随该分享的请求出没，分享撤销后浏览器侧自然失效
func gateCookieName(token string) string { return "sc_gate_" + token }

func gateCookiePath(token string) string { return "/s/" + token }

// sign 会话签名：覆盖 token（rotate 换链即失效）+ 记录当前口令哈希（改/移除
// 口令即失效）+ 过期时点（过期值本身防篡改——改明文 exp 必须重签，签不出）
func (g *gateSessions) sign(token, hash string, exp int64) string {
	mac := hmac.New(sha256.New, g.signKey())
	fmt.Fprintf(mac, "%s\x00%s\x00%d", token, hash, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// issue 签发门会话 cookie（验证成功路径）。HttpOnly 防脚本侧窃取重放；
// SameSite=Lax（访客页站内跳转/表单回程需携带）；Secure 跟随子服务 TLS 态
func (g *gateSessions) issue(sh *store.Share, now time.Time, secure bool) *http.Cookie {
	exp := now.Add(gateCookieTTL)
	expUnix := exp.Unix()
	val := strconv.FormatInt(expUnix, 10) + "." + g.sign(sh.Token, sh.PassphraseHash, expUnix)
	return &http.Cookie{
		Name:     gateCookieName(sh.Token),
		Value:    val,
		Path:     gateCookiePath(sh.Token),
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}
}

// valid 校验请求携带的门会话：格式/签名/有效期/记录绑定全过才放行。
// hmac.Equal 常数时间比较；过期或签名不符统一 false 不区分原因（不向外
// 泄露「哪个环节没过」）
func (g *gateSessions) valid(r *http.Request, sh *store.Share) bool {
	c, err := r.Cookie(gateCookieName(sh.Token))
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
	want := g.sign(sh.Token, sh.PassphraseHash, exp)
	return hmac.Equal([]byte(want), []byte(c.Value[dot+1:]))
}

// gateFailKey 限流维度：(token, IP)——token 维度防对口令定点爆破，IP 维度
// 防局外人灌错口令把正常访客锁在门外（联合维度让两者都只能伤及自身）。
// IP 解析与审计同源（clientIPOf：同源入口注入值优先，直连回落 RemoteAddr），
// 反代后所有访客不再共享一个代理 IP 而互相牵连限流
func gateFailKey(token string, r *http.Request) string {
	return token + "\x00" + clientIPOf(r)
}

// gateGuard 访客面内容守卫中间件：凡带 {token} 的内容子资源（meta/list/
// render/raw/html/f/download/dl/stream）统一经此——防绕过口令页直取子资源
// （口令页只是访客 UI，真正的门在每一个取数端点上）。四形态（file/frozen/
// snippet/terminal）按记录字段统一把门，frozen 快照路径在守卫之后才解析
// （同门核对）。无口令记录零开销直通（存量语义零变化）；记录不存在/过期时
// 守卫放行——由 handler 产出既有的品牌 404/410 语义，守卫不遮蔽错误呈现。
//
// 一次性分享（P-20261020-3）在本守卫叠加第二道门：未持查看 cookie 一律回
// 内容页入口（该入口只出确认页）——否则知道 token 的人可绕过确认页直取
// raw/render/html，显式确认就只是页面层装饰。确认 POST /view 不经本守卫
// （它是获得查看 cookie 的入口）；窗后记录已在 lookup 消费分支 410，不会
// 走到这里。
func (s *Service) gateGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sh, herr := s.lookup(r, r.PathValue("token"))
		if herr != nil {
			// 不存在/已过期：放行给 handler 走既有的 404/410 呈现——但守卫
			// lookup 的惰性删除副作用已发生，错误随上下文传下去，handler 的
			// lookup 复用同一错误（不重读已删记录拿 404 盖掉 410 语义）
			next.ServeHTTP(w, r.WithContext(withLookupError(r.Context(), herr)))
			return
		}
		if sh.PassphraseHash != "" && !s.gate.valid(r, sh) {
			writeJSONErrorStatus(w, http.StatusUnauthorized, "passphrase_required")
			return
		}
		if sh.ViewOnce && !s.viewConfirmed(r, sh) {
			// 303 回内容页：访客下一步看到的是泛化确认页（不泄露文件名/
			// 项目名），确认后浏览器持有 cookie 再取子资源
			http.Redirect(w, r, "/s/"+sh.Token, http.StatusSeeOther)
			return
		}
		// 守卫已读到的记录随上下文传给 handler（lookup 复用）——访客面
		// 单请求保持单次记录读取（filestore.Get 是磁盘读，不做会双倍）
		next.ServeHTTP(w, r.WithContext(withResolvedShare(r.Context(), sh)))
	})
}

// handleGatePost 访客口令验证（POST /s/{token}/gate，访客面口令输入端点；
// P-20261020-3 起另有一次性确认 /view 与访客留言 /messages，三者均不写分享
// 内容）。表单（口令页零 JS 提交）与 JSON（脚本化验证）均收；错口令 → 401
// 重出口令页带错误文案 + 失败计数；窗口内失败超限 → 429（Retry-After 到
// 窗口末）；正确 → 签发门会话 cookie → 303 回内容页（表单 POST 后经 GET
// 取内容页，浏览器地址栏回到短链本身）
func (s *Service) handleGatePost(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	sh, herr := s.lookup(r, token)
	if herr != nil {
		// 已过期/已消费/不存在：口令页本身给既有的 410/404 语义（验证入口
		// 不放过期记录借尸还魂；一次性已焚毁同样不复活——P-20261006-27
		// 的消费文案与 TTL 过期区分）
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
	if sh.PassphraseHash == "" {
		// 无门记录：验证无意义，直通内容页
		http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
		return
	}
	key := gateFailKey(sh.Token, r)
	if s.gate.fails.IsLimited(key) {
		// 与 Hit 溢出分支同一出口：429 一律带 Retry-After（客户端重试节奏
		// 的唯一依据，两条路径不应对外呈现两种形态）
		s.writeGateLimited(w, r, key)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(sh.PassphraseHash), []byte(gatePassphrase(w, r))) != nil {
		// 失败计数（窗口末自动过期）：Hit 恒递增，> 上限时本次起 429——
		// 与 auth.go 解锁失败限流同款「仅失败计数」语义
		if n := s.gate.fails.Hit(key); n > gateMaxFailures {
			s.writeGateLimited(w, r, key)
			return
		}
		s.writeGate(w, r, http.StatusUnauthorized, gateErrWrong)
		return
	}
	http.SetCookie(w, s.gate.issue(sh, time.Now(), r.TLS != nil))
	http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
}

// writeGateLimited 限流响应：Retry-After 指到当前窗口末（秒，向上取整），
// 文案与状态码经口令页一并呈现
func (s *Service) writeGateLimited(w http.ResponseWriter, r *http.Request, key string) {
	remain := int64(time.Until(s.gate.fails.ExpireAt(key)).Seconds() + 0.999)
	if remain < 1 {
		remain = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(remain, 10))
	s.writeGate(w, r, http.StatusTooManyRequests, gateErrLimited)
}

// gatePassphrase 从请求体提取口令：表单字段优先（口令页的提交形态——纯
// HTML 零 JS），JSON 兼容（agent/脚本验证）。体读取限幅；无体/解析失败按
// 空口令处理，走既有的错口令路径（不产生独立错误形态）
func gatePassphrase(w http.ResponseWriter, r *http.Request) string {
	r.Body = http.MaxBytesReader(w, r.Body, gateBodyLimit)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var req struct {
			Passphrase string `json:"passphrase"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return ""
		}
		return req.Passphrase
	}
	if err := r.ParseForm(); err != nil {
		return ""
	}
	return r.PostFormValue("passphrase")
}

// writeGate 口令页输出（状态码随分支：200 首次进入 / 401 错口令 / 429 限流）
func (s *Service) writeGate(w http.ResponseWriter, r *http.Request, status int, errCode string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// 口令页 CSP：默认页锁死 form-action 'none'（页面无交互表单），口令页是
	// 唯一例外——提交目标限同源（form-action 'self'），其余来源维持锁死
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; "+
			"form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	_ = renderGatePage(w, r.PathValue("token"), prefLang(r), errCode)
}
