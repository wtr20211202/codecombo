package share

// 一次性分享显式确认（P-20261020-3）访客面矩阵：预览抓取 GET/HEAD 不武装、
// 显式 POST 武装且只记确认访问、内容页要求查看 cookie、窗内刷新不重复计时/
// 计数、窗后 410 consumed、下载需确认、口令门与一次性叠加、确认 POST 限流。
// 宽限窗是编译期常量，窗外态经注入 ViewedAt 表达——e2e（share-viewonce）
// 覆盖可达面（确认页交互/内容可用），窗界判定在本文件。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"

	"golang.org/x/crypto/bcrypt"
)

// armingShares 带 MarkFirstView 的记录桩：生产装配（shareapi.shareLookup →
// store.ShareStore）恒实现 MarkFirstView，裸 fakeShares 没有；本桩把武装
// 写回记录（ViewedAt 落库），后续请求的 lookup 才能看到倒计时——与真
// store 行为同构。armed 计数是「不重复武装」的观测口
type armingShares struct {
	fakeShares
	armed int
}

func (a *armingShares) MarkFirstView(token string, at time.Time) error {
	sh, err := a.fakeShares.Get(token)
	if err != nil {
		return err
	}
	if !sh.ViewOnce || !sh.ViewedAt.IsZero() {
		return nil
	}
	sh.ViewedAt = at
	a.armed++
	return nil
}

// newOnceServer 建带一次性分享记录的测试服务（mut 可改写记录，如注入
// 既往 ViewedAt / 口令哈希）；返回服务器、记录桩、服务与 token 供断言。
// 查看/口令 cookie 的签名密钥惰性派生自 master-key：SC_DATA_DIR 隔离 +
// ResetForTest 让每个用例拿到独立密钥，不碰真实数据目录
func newOnceServer(t *testing.T, mut func(*store.Share)) (*httptest.Server, *armingShares, *Service, string) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	config.ResetForTest()
	t.Cleanup(config.ResetForTest)
	root := fixture(t)
	tok := fixedToken("once")
	sh := &store.Share{
		Token: tok, Kind: store.ShareKindFile, ProjectID: "p1", ProjectName: "proj",
		Name: "docs", Path: "docs", IsDir: true, ViewOnce: true,
	}
	if mut != nil {
		mut(sh)
	}
	shares := &armingShares{fakeShares: fakeShares{tok: sh}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, shares, svc, tok
}

// getWith 带 Accept-Language 的 GET（访客页文案按语言分支的断言口）
func getWith(t *testing.T, url, lang string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", url, err)
	}
	if lang != "" {
		req.Header.Set("Accept-Language", lang)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s: %v", url, err)
	}
	return resp.StatusCode, string(b)
}

// viewPost 构造显式确认请求（确认页表单的真实提交形态：POST /view 无体）
func viewPost(token string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/s/"+token+"/view", nil)
	req.Header.Set("Accept-Language", "zh-CN")
	return req
}

// viewCookieOf 从响应提取查看 cookie
func viewCookieOf(t *testing.T, resp *httptest.ResponseRecorder, token string) *http.Cookie {
	t.Helper()
	for _, c := range resp.Result().Cookies() {
		if c.Name == viewCookieName(token) {
			return c
		}
	}
	t.Fatalf("view cookie %s not set", viewCookieName(token))
	return nil
}

// flushHitTotal 冲刷内存计数并返回累计命中（apply 侧只求和，测试关心条数）
func flushHitTotal(svc *Service) int {
	return svc.FlushHits(func(string, int64, time.Time) error { return nil })
}

// flushViewTotal 冲刷访问审计并返回条数
func flushViewTotal(svc *Service) int {
	return svc.FlushViewAudits(nil)
}

// TestViewOncePreviewGetAndHeadDoNotArm 预览抓取防线：IM/邮件网关式 UA 的
// GET 与 HEAD 只拿到确认页——不武装、不计数、不留痕；确认页文案泛化
// （不泄露文件名/项目名）、零外部依赖、CSP 放行同源表单、noindex 双保险
func TestViewOncePreviewGetAndHeadDoNotArm(t *testing.T) {
	_, shares, svc, tok := newOnceServer(t, nil)
	h := svc.Handler()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req.Header.Set("User-Agent", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")
	req.Header.Set("Accept-Language", "zh-CN")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("preview GET status = %d, want 200 confirmation page", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{
		"这是一条一次性分享",
		"10 分钟",
		`action="/s/` + tok + `/view"`,
		`<meta name="robots" content="noindex">`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("confirmation page missing %q: %s", want, body)
		}
	}
	// 泛化文案：记录字段（分享名 docs / 项目名 proj）没有进入确认页的路径
	if strings.Contains(body, ">docs") || strings.Contains(body, "proj") {
		t.Fatalf("confirmation page leaked record fields: %s", body)
	}
	// 零外部依赖（无脚本/外部 URL）+ CSP 对确认页放行同源表单
	if strings.Contains(body, "<script") || strings.Contains(body, "https://") {
		t.Fatalf("confirmation page must stay zero-dependency: %s", body)
	}
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "form-action 'self'") {
		t.Fatalf("confirmation page CSP must allow same-origin form, got %q", csp)
	}
	if got := w.Header().Get("X-Robots-Tag"); got != "noindex" {
		t.Fatalf("X-Robots-Tag = %q, want noindex", got)
	}
	if shares.armed != 0 || !shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("preview GET must not arm (armed=%d, viewedAt=%v)", shares.armed, shares.fakeShares[tok].ViewedAt)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("preview GET must not count hits, got %d", n)
	}
	if n := flushViewTotal(svc); n != 0 {
		t.Fatalf("preview GET must not audit views, got %d", n)
	}

	// HEAD 探测（Go 的 GET 路由同时匹配 HEAD）：不武装不计数
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest(http.MethodHead, "/s/"+tok, nil))
	if w2.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", w2.Code)
	}
	if shares.armed != 0 || !shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("HEAD must not arm (armed=%d)", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("HEAD must not count hits, got %d", n)
	}
	if n := flushViewTotal(svc); n != 0 {
		t.Fatalf("HEAD must not audit views, got %d", n)
	}

	// 抓取之后再次 GET 仍是确认页（没有内容页可被预览）
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, httptest.NewRequest(http.MethodGet, "/s/"+tok, nil))
	if w3.Code != http.StatusOK || strings.Contains(w3.Body.String(), `id="page-css"`) {
		t.Fatalf("after preview GET the page must stay a confirmation page, code=%d", w3.Code)
	}
}

// TestViewOnceExplicitConfirmArmsServesContentAndCountsOnce 显式 POST 武装：
// 303 回内容页 + 短时效查看 cookie（HttpOnly/SameSite=Lax/Path=/s/{token}）；
// 内容页要求该 cookie（无 cookie 仍是确认页）；同窗刷新/重复提交不重复
// 武装、不重复计数；非一次性分享保持既有 GET 计数路径
func TestViewOnceExplicitConfirmArmsServesContentAndCountsOnce(t *testing.T) {
	_, shares, svc, tok := newOnceServer(t, nil)
	h := svc.Handler()

	// 未确认 GET：确认页且零计数
	w0 := httptest.NewRecorder()
	req0 := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req0.Header.Set("Accept-Language", "zh-CN")
	h.ServeHTTP(w0, req0)
	if w0.Code != http.StatusOK || !strings.Contains(w0.Body.String(), "这是一条一次性分享") {
		t.Fatalf("unconfirmed GET must render confirmation page, code=%d", w0.Code)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("unconfirmed GET must not count, got %d", n)
	}

	// 显式确认：303 回内容页 + 查看 cookie
	w := httptest.NewRecorder()
	h.ServeHTTP(w, viewPost(tok))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("confirm POST status = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "/s/"+tok {
		t.Fatalf("confirm redirect = %q, want /s/%s", loc, tok)
	}
	ck := viewCookieOf(t, w, tok)
	if !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode || ck.Path != "/s/"+tok {
		t.Fatalf("view cookie flags = %+v", ck)
	}
	if ck.MaxAge <= 0 || ck.MaxAge > int(viewCookieTTL.Seconds()) {
		t.Fatalf("view cookie MaxAge = %d, want short-lived (<= %d)", ck.MaxAge, int(viewCookieTTL.Seconds()))
	}
	if shares.armed != 1 || shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("confirm must arm exactly once (armed=%d, viewedAt=%v)", shares.armed, shares.fakeShares[tok].ViewedAt)
	}
	if n := flushHitTotal(svc); n != 1 {
		t.Fatalf("confirm must count exactly one hit, got %d", n)
	}
	if n := flushViewTotal(svc); n != 1 {
		t.Fatalf("confirm must audit exactly one view, got %d", n)
	}

	// 内容页要求查看 cookie：另一个浏览器（转发链第二位）仍只拿确认页
	wNo := httptest.NewRecorder()
	reqNo := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	reqNo.Header.Set("Accept-Language", "zh-CN")
	h.ServeHTTP(wNo, reqNo)
	if wNo.Code != http.StatusOK || !strings.Contains(wNo.Body.String(), "这是一条一次性分享") ||
		strings.Contains(wNo.Body.String(), `id="page-css"`) {
		t.Fatalf("view-once content must require the view cookie (code=%d)", wNo.Code)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("unconfirmed GET after arming must not count, got %d", n)
	}

	// 带 cookie：正常内容页；同窗刷新不重复武装/计数
	withCookie := func(method string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/s/"+tok, nil)
		req.AddCookie(ck)
		h.ServeHTTP(rec, req)
		return rec
	}
	wContent := withCookie(http.MethodGet)
	if wContent.Code != http.StatusOK || !strings.Contains(wContent.Body.String(), `id="page-css"`) {
		t.Fatalf("confirmed GET status = %d, want content page", wContent.Code)
	}
	if strings.Contains(wContent.Body.String(), "这是一条一次性分享") {
		t.Fatal("confirmed GET must not render the confirmation page")
	}
	if got := wContent.Header().Get("X-Robots-Tag"); got != "noindex" {
		t.Fatalf("content page X-Robots-Tag = %q, want noindex", got)
	}
	if wRefresh := withCookie(http.MethodGet); wRefresh.Code != http.StatusOK {
		t.Fatalf("in-window refresh status = %d, want 200", wRefresh.Code)
	}
	if shares.armed != 1 {
		t.Fatalf("refresh must not re-arm, armed = %d", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("refresh must not count, got %d", n)
	}
	if n := flushViewTotal(svc); n != 0 {
		t.Fatalf("refresh must not audit, got %d", n)
	}
	// HEAD 带 cookie 也不计数（探测不是「被看」）
	if wHead := withCookie(http.MethodHead); wHead.Code != http.StatusOK {
		t.Fatalf("confirmed HEAD status = %d, want 200", wHead.Code)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("HEAD must not count, got %d", n)
	}

	// 重复提交（浏览器回退重放/双击）：幂等，不重复计数
	wRepeat := httptest.NewRecorder()
	reqRepeat := viewPost(tok)
	reqRepeat.AddCookie(ck)
	h.ServeHTTP(wRepeat, reqRepeat)
	if wRepeat.Code != http.StatusSeeOther {
		t.Fatalf("repeat confirm status = %d, want 303", wRepeat.Code)
	}
	if shares.armed != 1 {
		t.Fatalf("repeat confirm must not re-arm, armed = %d", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("repeat confirm must not count, got %d", n)
	}
	if n := flushViewTotal(svc); n != 0 {
		t.Fatalf("repeat confirm must not audit, got %d", n)
	}

	// 非一次性分享保持既有 GET 计数路径（存量语义零变化）
	plain := fixedToken("plain")
	shares.fakeShares[plain] = &store.Share{
		Token: plain, Kind: store.ShareKindFile, ProjectID: "p1", ProjectName: "proj",
		Name: "docs", Path: "docs", IsDir: true,
	}
	wPlain := httptest.NewRecorder()
	h.ServeHTTP(wPlain, httptest.NewRequest(http.MethodGet, "/s/"+plain, nil))
	if wPlain.Code != http.StatusOK {
		t.Fatalf("plain GET status = %d, want 200", wPlain.Code)
	}
	if n := flushHitTotal(svc); n != 1 {
		t.Fatalf("plain GET must keep counting, got %d", n)
	}
	if n := flushViewTotal(svc); n != 1 {
		t.Fatalf("plain GET must keep auditing, got %d", n)
	}
	// HEAD 是探测不是「被看」：非一次性记录同样不计数不留痕（防御性收口）
	wPlainHead := httptest.NewRecorder()
	h.ServeHTTP(wPlainHead, httptest.NewRequest(http.MethodHead, "/s/"+plain, nil))
	if wPlainHead.Code != http.StatusOK {
		t.Fatalf("plain HEAD status = %d, want 200", wPlainHead.Code)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("plain HEAD must not count, got %d", n)
	}
	if n := flushViewTotal(svc); n != 0 {
		t.Fatalf("plain HEAD must not audit, got %d", n)
	}
}

// TestViewOnceDownloadRequiresConfirmation 下载也是内容出域：未确认 → 303
// 回确认页（不武装不计数）；确认后下载可用且不重复计数（hits 只记确认访问）
func TestViewOnceDownloadRequiresConfirmation(t *testing.T) {
	_, shares, svc, tok := newOnceServer(t, func(sh *store.Share) {
		sh.IsDir, sh.Path = false, "docs/readme.md"
	})
	h := svc.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok+"/download", nil))
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/s/"+tok {
		t.Fatalf("unconfirmed download = %d %q, want 303 to confirmation page", w.Code, w.Header().Get("Location"))
	}
	if shares.armed != 0 || !shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("unconfirmed download must not arm (armed=%d)", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("unconfirmed download must not count, got %d", n)
	}

	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, viewPost(tok))
	ck := viewCookieOf(t, w2, tok)

	w3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/download", nil)
	req3.AddCookie(ck)
	h.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK || !strings.Contains(w3.Body.String(), "Title") {
		t.Fatalf("confirmed download status = %d, want file content", w3.Code)
	}
	if n := flushHitTotal(svc); n != 1 {
		t.Fatalf("hits must only count the explicit confirmation, got %d", n)
	}

	// HEAD 下载（带 cookie）同样不计数
	w4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodHead, "/s/"+tok+"/download", nil)
	req4.AddCookie(ck)
	h.ServeHTTP(w4, req4)
	if w4.Code != http.StatusOK {
		t.Fatalf("confirmed HEAD download status = %d, want 200", w4.Code)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("HEAD download must not count, got %d", n)
	}
}

// TestViewOnceContentSubresourcesRequireConfirmation 内容子资源同门（P-20261020-3
// 守卫第二道门）：未持查看 cookie 直取 raw/meta 一律 303 回内容页入口——否则
// 知道 token 的人可绕过确认页直取内容，显式确认只剩页面层装饰；确认后同一
// cookie 取数正常，且子资源取数不重复计数（hits 只记确认访问）
func TestViewOnceContentSubresourcesRequireConfirmation(t *testing.T) {
	_, shares, svc, tok := newOnceServer(t, nil)
	h := svc.Handler()

	for _, target := range []string{
		"/s/" + tok + "/meta",
		"/s/" + tok + "/raw?path=readme.md",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/s/"+tok {
			t.Fatalf("%s unconfirmed = %d %q, want 303 to confirmation page", target, w.Code, w.Header().Get("Location"))
		}
	}
	if shares.armed != 0 || !shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("unconfirmed subresources must not arm (armed=%d)", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("unconfirmed subresources must not count, got %d", n)
	}

	// 显式确认 → 查看 cookie；同 cookie 取子资源正常（内容页渲染的取数面）
	w := httptest.NewRecorder()
	h.ServeHTTP(w, viewPost(tok))
	ck := viewCookieOf(t, w, tok)

	wMeta := httptest.NewRecorder()
	reqMeta := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil)
	reqMeta.AddCookie(ck)
	h.ServeHTTP(wMeta, reqMeta)
	if wMeta.Code != http.StatusOK {
		t.Fatalf("confirmed meta status = %d, want 200", wMeta.Code)
	}

	wRaw := httptest.NewRecorder()
	reqRaw := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/raw?path=readme.md", nil)
	reqRaw.AddCookie(ck)
	h.ServeHTTP(wRaw, reqRaw)
	if wRaw.Code != http.StatusOK || !strings.Contains(wRaw.Body.String(), "Title") {
		t.Fatalf("confirmed raw = %d %q, want file content", wRaw.Code, wRaw.Body.String())
	}
	if n := flushHitTotal(svc); n != 1 {
		t.Fatalf("hits must only count the explicit confirmation, got %d", n)
	}
}

// TestViewOnceConsumedPastWindow 窗外全端点矩阵：页面 410 专页文案
// （「已被查看并失效」，区别于「已过期」/404）、meta/download JSON code
// share_consumed、记录不惰性删除（失效态留管理器）
func TestViewOnceConsumedPastWindow(t *testing.T) {
	past := time.Now().Add(-store.ViewOnceGrace - time.Minute)
	srv, shares, _, tok := newOnceServer(t, func(sh *store.Share) { sh.ViewedAt = past })

	// 页面：410 + 专页文案（zh 语境），且不是「已过期」文案
	code, body := getWith(t, srv.URL+"/s/"+tok, "zh-CN")
	if code != http.StatusGone {
		t.Fatalf("consumed page status = %d, want 410", code)
	}
	if !strings.Contains(body, "此分享已被查看并失效") {
		t.Fatalf("consumed page missing distinct copy: %s", body)
	}
	if strings.Contains(body, "链接已过期") {
		t.Fatal("consumed page must not reuse TTL-expired copy")
	}

	// meta：410 JSON share_consumed（页内错误卡据此呈现同款文案）
	code2, body2 := getWith(t, srv.URL+"/s/"+tok+"/meta", "")
	if code2 != http.StatusGone || !strings.Contains(body2, "share_consumed") {
		t.Fatalf("consumed meta = %d %s, want 410 share_consumed", code2, body2)
	}

	// download：410 share_consumed（直链也不能借尸）
	code3, body3 := getWith(t, srv.URL+"/s/"+tok+"/download", "")
	if code3 != http.StatusGone || !strings.Contains(body3, "share_consumed") {
		t.Fatalf("consumed download = %d %s, want 410 share_consumed", code3, body3)
	}

	// 记录仍在（不惰性删除——管理器要能呈现失效态）；TTL 过期记录首踩即删
	// 的既有行为由 store/访客面既有用例锚定，此处锚定的是差异
	if _, ok := shares.fakeShares[tok]; !ok {
		t.Fatal("consumed record must not be lazily deleted (manager shows consumed state)")
	}
}

// TestViewOnceWindowBoundary 宽限窗边界：还剩 1 秒且持查看 cookie 仍可见，
// 恰走完即失效（Consumed 的 !After 语义——窗界=失效）
func TestViewOnceWindowBoundary(t *testing.T) {
	// 窗内还剩 1 秒：带有效查看 cookie 的内容页 200
	_, shares, svc, tok := newOnceServer(t, func(sh *store.Share) {
		sh.ViewedAt = time.Now().Add(-store.ViewOnceGrace + time.Second)
	})
	h := svc.Handler()
	ck := svc.view.issue(shares.fakeShares[tok], time.Now(), false)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req.AddCookie(ck)
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `id="page-css"`) {
		t.Fatalf("1s-before-deadline page status = %d, want content page", w.Code)
	}
	// 窗内无 cookie：仍只出确认页（内容要求显式确认）
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/s/"+tok, nil))
	if w2.Code != http.StatusOK || strings.Contains(w2.Body.String(), `id="page-css"`) {
		t.Fatalf("in-window page without cookie must stay confirmation (code=%d)", w2.Code)
	}

	// 恰好走完：410
	srv3, _, _, tok3 := newOnceServer(t, func(sh *store.Share) {
		sh.ViewedAt = time.Now().Add(-store.ViewOnceGrace)
	})
	if code, _ := getWith(t, srv3.URL+"/s/"+tok3+"/meta", ""); code != http.StatusGone {
		t.Fatalf("at-deadline meta status = %d, want 410", code)
	}
	if code, _ := getWith(t, srv3.URL+"/s/"+tok3, ""); code != http.StatusGone {
		t.Fatalf("at-deadline page status = %d, want 410", code)
	}
}

// TestViewOnceWithPassphraseGate 一次性+口令正交叠加：口令页打开不武装；
// gate 会话不能被当作一次性确认（页面仍是确认页）；带门口令的显式确认才
// 武装 + 计数；查看 cookie 不解锁口令门（两类会话分离）；窗外确认/验证
// 入口都给 consumed 专页
func TestViewOnceWithPassphraseGate(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("open sesame"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	_, shares, svc, tok := newOnceServer(t, func(sh *store.Share) {
		sh.PassphraseHash = string(hash)
	})
	h := svc.Handler()

	// 口令页：200 但零武装（口令页被打开 = 内容未出域，不触发焚毁倒计时）
	w := httptest.NewRecorder()
	req0 := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req0.Header.Set("Accept-Language", "zh-CN")
	h.ServeHTTP(w, req0)
	if w.Code != http.StatusOK || shares.armed != 0 {
		t.Fatalf("gate page must not arm (code=%d armed=%d)", w.Code, shares.armed)
	}
	if !strings.Contains(w.Body.String(), "此分享受口令保护") {
		t.Fatalf("expected gate page, got: %s", w.Body.String())
	}

	// 未过口令门的确认 POST：回入口重新走 gate，不武装不计数
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, viewPost(tok))
	if w1.Code != http.StatusSeeOther || w1.Header().Get("Location") != "/s/"+tok {
		t.Fatalf("confirm without gate = %d %q, want 303 back to gate", w1.Code, w1.Header().Get("Location"))
	}
	if shares.armed != 0 {
		t.Fatalf("confirm without gate must not arm, armed = %d", shares.armed)
	}
	if n := flushHitTotal(svc); n != 0 {
		t.Fatalf("confirm without gate must not count, got %d", n)
	}

	// 正确口令 → 303 + 门 cookie（验证动作本身不武装）
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, gatePost(tok, "open sesame"))
	if w2.Code != http.StatusSeeOther {
		t.Fatalf("gate post status = %d, want 303", w2.Code)
	}
	if shares.armed != 0 {
		t.Fatalf("gate post must not arm, armed = %d", shares.armed)
	}
	gateCk := cookieOf(t, w2, tok)

	// gate cookie ≠ 查看确认：页面仍是确认页
	w3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req3.Header.Set("Accept-Language", "zh-CN")
	req3.AddCookie(gateCk)
	h.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK || !strings.Contains(w3.Body.String(), "这是一条一次性分享") {
		t.Fatalf("gate cookie alone must not confirm one-time share (code=%d)", w3.Code)
	}
	if shares.armed != 0 {
		t.Fatalf("gate cookie alone must not arm, armed = %d", shares.armed)
	}

	// 带门口令的显式确认：303 + 查看 cookie → 武装 + 计数
	w4 := httptest.NewRecorder()
	req4 := viewPost(tok)
	req4.AddCookie(gateCk)
	h.ServeHTTP(w4, req4)
	if w4.Code != http.StatusSeeOther {
		t.Fatalf("confirm with gate status = %d, want 303", w4.Code)
	}
	viewCk := viewCookieOf(t, w4, tok)
	if shares.armed != 1 || shares.fakeShares[tok].ViewedAt.IsZero() {
		t.Fatalf("confirm with gate must arm (armed=%d)", shares.armed)
	}
	if n := flushHitTotal(svc); n != 1 {
		t.Fatalf("confirm with gate must count one hit, got %d", n)
	}

	// 查看 cookie 不解锁口令门：仅带 view cookie 的子资源仍 401
	w5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil)
	req5.AddCookie(viewCk)
	h.ServeHTTP(w5, req5)
	if w5.Code != http.StatusUnauthorized || !strings.Contains(w5.Body.String(), "passphrase_required") {
		t.Fatalf("view cookie must not unlock gate: %d %s", w5.Code, w5.Body.String())
	}

	// 两 cookie 齐备：内容页 200
	w6 := httptest.NewRecorder()
	req6 := httptest.NewRequest(http.MethodGet, "/s/"+tok, nil)
	req6.AddCookie(gateCk)
	req6.AddCookie(viewCk)
	h.ServeHTTP(w6, req6)
	if w6.Code != http.StatusOK || !strings.Contains(w6.Body.String(), `id="page-css"`) {
		t.Fatalf("unlocked confirmed page status = %d, want content page", w6.Code)
	}

	// 窗外后的口令验证入口：consumed 专页而非口令页（验证入口不给已焚毁
	// 记录借尸还魂，文案与页面入口同款区分）
	shares.fakeShares[tok].ViewedAt = time.Now().Add(-store.ViewOnceGrace - time.Minute)
	w7 := httptest.NewRecorder()
	h.ServeHTTP(w7, gatePost(tok, "open sesame"))
	if w7.Code != http.StatusGone || !strings.Contains(w7.Body.String(), "此分享已被查看并失效") {
		t.Fatalf("gate on consumed share = %d, want 410 consumed copy", w7.Code)
	}
}

// TestViewOnceConfirmRateLimit 确认 POST 限流：同 (token,IP) 每分钟超过
// viewMaxConfirms 次回 429 + Retry-After（复用 middleware.RateLimiter）；
// 武装仍只发生一次
func TestViewOnceConfirmRateLimit(t *testing.T) {
	_, shares, svc, tok := newOnceServer(t, nil)
	h := svc.Handler()

	var last *httptest.ResponseRecorder
	for i := 0; i < viewMaxConfirms+1; i++ {
		last = httptest.NewRecorder()
		h.ServeHTTP(last, viewPost(tok))
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit confirm status = %d, want 429", last.Code)
	}
	if last.Header().Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
	if !strings.Contains(last.Body.String(), "操作过于频繁") {
		t.Fatalf("rate-limited page missing copy: %s", last.Body.String())
	}
	if shares.armed != 1 {
		t.Fatalf("repeated confirms must arm only once, armed = %d", shares.armed)
	}
}
