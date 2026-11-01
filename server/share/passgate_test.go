package share

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"

	"golang.org/x/crypto/bcrypt"
)

// gateTestEnv 口令门测试环境：SC_DATA_DIR 隔离（gate 签名密钥惰性派生自
// master-key，首个门操作会触盘）+ 空 fakeShares
func gateTestEnv(t *testing.T) (*Service, fakeShares) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	config.ResetForTest()
	t.Cleanup(config.ResetForTest)
	shares := fakeShares{}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	return svc, shares
}

// putLockedShare 放一条带口令的分享记录（MinCost 哈希——单测比对路径用，
// 生产入口走 handlers.hashPassphrase 的 DefaultCost）
func putLockedShare(t *testing.T, shares fakeShares, token, pass string, mut func(*store.Share)) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	sh := &store.Share{Token: token, Kind: store.ShareKindFile, ProjectID: "p1", Name: "locked", PassphraseHash: string(hash)}
	if mut != nil {
		mut(sh)
	}
	shares[token] = sh
}

// gatePost 向验证端点提交一次口令（表单形态=口令页的真实提交；中文语境
// 断言错误文案）
func gatePost(token, pass string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/s/"+token+"/gate",
		strings.NewReader(url.Values{"passphrase": {pass}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept-Language", "zh-CN")
	return req
}

// cookieOf 从响应提取门会话 cookie
func cookieOf(t *testing.T, resp *httptest.ResponseRecorder, token string) *http.Cookie {
	t.Helper()
	for _, c := range resp.Result().Cookies() {
		if c.Name == gateCookieName(token) {
			return c
		}
	}
	t.Fatalf("gate cookie %s not set", gateCookieName(token))
	return nil
}

// TestGatePageAndGuardLocked 锁定分享：页面出口令页（不计访问语义由 hits
// 口径保证，此处验 HTML 形态），全部内容子资源无 cookie 一律 401
func TestGatePageAndGuardLocked(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("locked1")
	putLockedShare(t, shares, tok, "open sesame", nil)
	h := svc.Handler()

	// 页面：口令页（含表单指向 /gate），不是内容页
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("gate page status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `action="/s/`+tok+`/gate"`) {
		t.Fatalf("gate page missing form action: %s", body)
	}
	if !strings.Contains(body, "gateHeading") == false && !strings.Contains(body, "此分享受口令保护") {
		t.Fatalf("gate page missing heading")
	}
	// 口令页 CSP 放行同源表单（默认页是 form-action 'none'）
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "form-action 'self'") {
		t.Fatalf("gate page CSP missing form-action 'self'")
	}

	// 子资源直取：全部 401 passphrase_required（守卫统一，防绕口令页）
	for _, ep := range []string{"/meta", "/list", "/render", "/raw", "/download", "/f/x.txt"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok+ep, nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401", ep, w.Code)
		}
		if !strings.Contains(w.Body.String(), "passphrase_required") {
			t.Fatalf("%s body missing passphrase_required: %s", ep, w.Body.String())
		}
	}
}

// TestGateFlowWrongRightRateLimit 验证全流程：错口令 401 → 连错超限 429
// （Retry-After 到窗口末）→ 正确口令 303 + 签发 cookie → 带 cookie 子资源
// 全通
func TestGateFlowWrongRightRateLimit(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("locked2")
	putLockedShare(t, shares, tok, "open sesame", nil)
	h := svc.Handler()

	// 错口令 ×10 → 401（窗口上限内）
	for i := 0; i < gateMaxFailures; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, gatePost(tok, "wrong-"+strings.Repeat("x", i)))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("wrong pass #%d status = %d, want 401", i+1, w.Code)
		}
	}
	// 第 11 次起 429 + Retry-After
	w := httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(tok, "wrong-again"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limited status = %d, want 429", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatalf("429 missing Retry-After")
	}
	if !strings.Contains(w.Body.String(), "尝试次数过多") {
		t.Fatalf("429 body missing limited message")
	}
	// 限流期间连正确口令也拒（IsLimited 前置），且同样带 Retry-After
	//（两条 429 路径同一出口——e2e 首轮抓到的缺口）
	w = httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(tok, "open sesame"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("limited gate should reject even correct pass, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatalf("IsLimited-path 429 missing Retry-After")
	}

	// 换新 Service（新限流窗口）走正确口令：303 + cookie。这里用带真实
	// 项目根的文件分享——解锁后的子资源断言（meta/raw）走完整解析链
	root := fixture(t)
	svc2, shares2 := gateTestEnv(t)
	putLockedShare(t, shares2, tok, "open sesame", nil)
	shares2[tok].Path = "docs/readme.md"
	shares2[tok].Name = "readme.md"
	svc2.roots = fakeRoots{byID: map[string]string{"p1": root}}
	h2 := svc2.Handler()
	w = httptest.NewRecorder()
	h2.ServeHTTP(w, gatePost(tok, "open sesame"))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("correct pass status = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "/s/"+tok {
		t.Fatalf("redirect Location = %q", loc)
	}
	ck := cookieOf(t, w, tok)
	if !ck.HttpOnly || ck.Path != "/s/"+tok {
		t.Fatalf("cookie flags wrong: path=%q httponly=%v", ck.Path, ck.HttpOnly)
	}

	// 带 cookie：meta/list/raw 全通
	get := func(ep string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/s/"+tok+ep, nil)
		req.AddCookie(ck)
		w := httptest.NewRecorder()
		h2.ServeHTTP(w, req)
		return w
	}
	if code := get("/meta").Code; code != http.StatusOK {
		t.Fatalf("meta with cookie status = %d", code)
	}
	if code := get("/raw").Code; code != http.StatusOK {
		t.Fatalf("raw with cookie status = %d", code)
	}

	// 篡改 cookie 值 → 401（签名不符）
	bad := *ck
	bad.Value = ck.Value[:strings.IndexByte(ck.Value, '.')+1] + "000000000000000000000000000000000000000000000000000000000000"
	req := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil)
	req.AddCookie(&bad)
	w = httptest.NewRecorder()
	h2.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("tampered cookie status = %d, want 401", w.Code)
	}
}

// TestGateSessionInvalidation 会话失效三通道：改口令（哈希变→旧 cookie 失效）、
// 轮换（token 变→旧 cookie 名与目标不匹配）、撤销（记录消失→404）
func TestGateSessionInvalidation(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("locked3")
	putLockedShare(t, shares, tok, "open sesame", nil)
	h := svc.Handler()

	// 解锁拿 cookie
	w := httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(tok, "open sesame"))
	ck := cookieOf(t, w, tok)

	// 改口令：旧 cookie 立即失效（cookie 绑定记录当前哈希，无需会话表）
	hash2, _ := bcrypt.GenerateFromPassword([]byte("new pass"), bcrypt.MinCost)
	shares[tok].PassphraseHash = string(hash2)
	req := httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil)
	req.AddCookie(ck)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("old cookie after passphrase change status = %d, want 401", w.Code)
	}
	// 新口令可重新解锁
	w = httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(tok, "new pass"))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("re-unlock with new pass status = %d", w.Code)
	}

	// 轮换（rotate 迁键语义在 store，这里等价模拟：新 token 记录 + 删旧记录）
	tok2 := fixedToken("locked3r")
	shares[tok2] = &store.Share{Token: tok2, Kind: store.ShareKindFile, ProjectID: "p1", Name: "locked", PassphraseHash: shares[tok].PassphraseHash}
	delete(shares, tok)
	req = httptest.NewRequest(http.MethodGet, "/s/"+tok2+"/meta", nil)
	req.AddCookie(ck)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("meta on rotated token status = %d, want 401", w.Code)
	}

	// 撤销：记录消失 → 友好 404（守卫不遮蔽，handler 语义呈现）
	delete(shares, tok2)
	req = httptest.NewRequest(http.MethodGet, "/s/"+tok2, nil)
	req.AddCookie(ck)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("revoked share page status = %d, want 404", w.Code)
	}
}

// TestGateFourKinds 四形态统一守卫：snippet/terminal/frozen 的子资源同门
// （frozen 的守卫先于快照解析——即便快照未装配也先 401 而非 target_gone）
func TestGateFourKinds(t *testing.T) {
	svc, shares := gateTestEnv(t)
	h := svc.Handler()

	mk := func(prefix, kind string, mut func(*store.Share)) string {
		tok := fixedToken(prefix)
		putLockedShare(t, shares, tok, "pw", mut)
		return tok
	}
	// snippet
	sn := mk("snippetlocked", "snippet", func(sh *store.Share) {
		sh.Kind = store.ShareKindSnippet
		sh.Content = "body"
		sh.ProjectID = ""
	})
	// terminal
	tm := mk("terminallocked", "terminal", func(sh *store.Share) {
		sh.Kind = store.ShareKindTerminal
		sh.TerminalID = "sess-1"
		sh.ExpiresAt = time.Now().Add(time.Hour)
	})
	// frozen
	fz := mk("frozenlocked", "frozen", func(sh *store.Share) {
		sh.Frozen = true
	})

	for _, tok := range []string{sn, tm, fz} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok, nil))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `action="/s/`+tok+`/gate"`) {
			t.Fatalf("token %s page not gate (code=%d)", tok, w.Code)
		}
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("token %s meta status = %d, want 401", tok, w.Code)
		}
	}
	// terminal 的 stream 端点同门
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tm+"/stream", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("stream status = %d, want 401", w.Code)
	}
	// frozen 的 raw（快照未装配：守卫先拦，不给 target_gone 误导）
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+fz+"/raw", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("frozen raw status = %d, want 401 (guard precedes snapshot resolution)", w.Code)
	}
}

// TestGateNoPassphraseUnchanged 无口令分享：既有语义零变化——页面直出内容页、
// 子资源无 cookie 可访问
func TestGateNoPassphraseUnchanged(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("plainshare")
	shares[tok] = &store.Share{Token: tok, Kind: store.ShareKindSnippet, Content: "hello", Name: "plain"}
	h := svc.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok, nil))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "/gate\"") {
		t.Fatalf("plain share page should not be gate page")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/s/"+tok+"/meta", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("plain meta status = %d, want 200", w.Code)
	}
}

// TestGateEdgePosts 验证端点边界：无门记录 303 直通、未知 token 404 页、
// 已过期 410、空口令按错口令计
func TestGateEdgePosts(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("nopass")
	shares[tok] = &store.Share{Token: tok, Kind: store.ShareKindSnippet, Content: "b", Name: "n"}
	h := svc.Handler()

	// 无门记录：303 直通内容页
	w := httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(tok, ""))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("gate on unlocked share status = %d, want 303", w.Code)
	}

	// 未知 token：404 页
	w = httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(fixedToken("unknownxx"), "x"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("gate on unknown token status = %d, want 404", w.Code)
	}

	// 已过期：410（验证入口不给过期记录借尸还魂）
	exp := fixedToken("expired")
	putLockedShare(t, shares, exp, "pw", func(sh *store.Share) {
		sh.ExpiresAt = time.Now().Add(-time.Minute)
	})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(exp, "pw"))
	if w.Code != http.StatusGone {
		t.Fatalf("gate on expired share status = %d, want 410", w.Code)
	}

	// 空口令：按错口令计（401 + 失败计数）
	locked := fixedToken("locked9")
	putLockedShare(t, shares, locked, "pw", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(locked, ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("empty pass status = %d, want 401", w.Code)
	}
}

// TestGateJSONVerify JSON 形态验证（agent/脚本口径）：正确口令同样签发 cookie
func TestGateJSONVerify(t *testing.T) {
	svc, shares := gateTestEnv(t)
	tok := fixedToken("lockedjson")
	putLockedShare(t, shares, tok, "open sesame", func(sh *store.Share) {
		// 片段形态：raw 直接回落库内容，不依赖项目根装配
		sh.Kind = store.ShareKindSnippet
		sh.Content = "secret body"
		sh.ProjectID = ""
	})
	h := svc.Handler()

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/s/"+tok+"/gate", strings.NewReader(`{"passphrase":"open sesame"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("json verify status = %d, want 303", w.Code)
	}
	ck := cookieOf(t, w, tok)
	req = httptest.NewRequest(http.MethodGet, "/s/"+tok+"/raw", nil)
	req.AddCookie(ck)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("raw with json-issued cookie status = %d", w.Code)
	}
}

// TestGateCookieCrossShareNotInterchange cookie 按分享隔离：A 分享的会话
// 不能解锁 B 分享（名称与签名双重隔离）
func TestGateCookieCrossShareNotInterchange(t *testing.T) {
	svc, shares := gateTestEnv(t)
	a, b := fixedToken("shareaaaaa"), fixedToken("sharebbbbb")
	putLockedShare(t, shares, a, "pw-a", nil)
	putLockedShare(t, shares, b, "pw-b", nil)
	h := svc.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, gatePost(a, "pw-a"))
	ca := cookieOf(t, w, a)

	req := httptest.NewRequest(http.MethodGet, "/s/"+b+"/meta", nil)
	req.AddCookie(ca)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("cross-share cookie status = %d, want 401", w.Code)
	}
}
