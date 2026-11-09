package share

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/store"
)

// 同源访客面（P-20261020-2）：Handler 发布/收回、资产白名单单一事实源、
// 访客 IP 上下文注入优先于 RemoteAddr（主应用可信代理链的进程内通道）。

func TestSameOriginHandlerPublishAndClear(t *testing.T) {
	t.Cleanup(ClearSameOriginHandler)
	ClearSameOriginHandler()
	if SameOriginHandler() != nil {
		t.Fatal("handler should be nil before publish")
	}
	called := false
	SetSameOriginHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	if SameOriginHandler() == nil {
		t.Fatal("handler should be published")
	}
	rec := httptest.NewRecorder()
	SameOriginHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/s/x", nil))
	if !called {
		t.Fatal("published handler not invoked")
	}
	ClearSameOriginHandler()
	if SameOriginHandler() != nil {
		t.Fatal("handler should be nil after clear")
	}
}

func TestAssetNamesWhitelist(t *testing.T) {
	names := AssetNames()
	// xterm 三件 + unicode11 宽度表 + JetBrains Mono 双字重（P-20261107-4 渲染保真）
	want := map[string]string{
		"xterm.js":                    "application/javascript; charset=utf-8",
		"addon-fit.js":                "application/javascript; charset=utf-8",
		"xterm.css":                   "text/css; charset=utf-8",
		"addon-unicode11.js":          "application/javascript; charset=utf-8",
		"JetBrainsMono-Regular.woff2": "font/woff2",
		"JetBrainsMono-Bold.woff2":    "font/woff2",
	}
	if len(names) != len(want) {
		t.Fatalf("AssetNames() = %v, want the %d vendored assets", names, len(want))
	}
	for _, name := range names {
		data, ct, ok := assetByName(name)
		if !ok || len(data) == 0 {
			t.Fatalf("whitelisted asset %q not servable", name)
		}
		if ct != want[name] {
			t.Fatalf("asset %q content-type = %q, want %q", name, ct, want[name])
		}
	}
	// woff2 魔数（wOF2）：字体文件是真字体而非误拷的文本
	for _, name := range []string{"JetBrainsMono-Regular.woff2", "JetBrainsMono-Bold.woff2"} {
		data, _, _ := assetByName(name)
		if len(data) < 4 || string(data[:4]) != "wOF2" {
			t.Fatalf("asset %q is not a woff2 font", name)
		}
	}
	if _, _, ok := assetByName("index-abc123.js"); ok {
		t.Fatal("main-app bundle name must not be in the share asset whitelist")
	}
}

// clientIPOf：同源入口注入的上下文值优先（主应用已按 trustedProxies 解析），
// 直连分享子服务没有上下文时回落 RemoteAddr——两种形态各自不可伪造。
func TestClientIPPrefersInjectedContext(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/s/x", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	if got := clientIPOf(req); got != "127.0.0.1" {
		t.Fatalf("direct clientIPOf = %q, want RemoteAddr host", got)
	}
	req = req.WithContext(WithClientIP(req.Context(), "203.0.113.9"))
	if got := clientIPOf(req); got != "203.0.113.9" {
		t.Fatalf("injected clientIPOf = %q, want context value", got)
	}
}

// 审计与口令门限流共用同一 IP 口径：注入后审计事件不再记成代理回环地址。
func TestViewAuditAndGateKeyUseInjectedClientIP(t *testing.T) {
	s := NewService(nil, nil, nil)
	sh := &store.Share{Name: "demo", Token: "abcd1234efgh5678"}
	req := httptest.NewRequest(http.MethodGet, "/s/"+sh.Token, nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req = req.WithContext(WithClientIP(req.Context(), "198.51.100.7"))

	s.recordView(req, sh)
	events, dropped := s.views.Drain()
	if dropped != 0 || len(events) != 1 {
		t.Fatalf("view audit events = %d (dropped %d), want 1", len(events), dropped)
	}
	if events[0].IP != "198.51.100.7" {
		t.Fatalf("audit IP = %q, want injected client IP", events[0].IP)
	}
	if key := gateFailKey(sh.Token, req); !strings.HasSuffix(key, "\x00"+"198.51.100.7") {
		t.Fatalf("gate fail key = %q, want injected client IP suffix", key)
	}
}

// 分享子服务自己的响应头不被主应用基线削弱：X-Frame-Options DENY（同源
// 代理继承主应用 SAMEORIGIN 时必须覆盖）。
func TestHandlerSetsFrameDeny(t *testing.T) {
	rec := httptest.NewRecorder()
	NewService(nil, nil, nil).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/s/x", nil))
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q, want DENY", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}

// 文档面 DENY 不能误伤分享页自己的同源 iframe 预览：/html（html 类）与 /raw
// （PDF 类）放宽到 SAMEORIGIN——否则页内预览在浏览器侧被 XFO 拦死
func TestFrameOptionsAllowOwnPreviews(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "site"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "site", "index.html"), []byte("<html><body>hi</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	token := fixedToken("frame")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "site",
		Path: "site", IsDir: true,
	}}
	srv := httptest.NewServer(NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil).Handler())
	t.Cleanup(srv.Close)

	page := get(t, srv.URL+"/s/"+token)
	defer page.Body.Close()
	if got := page.Header.Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("visitor page X-Frame-Options = %q, want DENY", got)
	}
	for _, path := range []string{
		"/s/" + token + "/html?path=index.html", // 页内 html 预览 iframe
		"/s/" + token + "/raw?path=index.html",  // raw 通用分支（PDF 预览同路）
	} {
		resp := get(t, srv.URL+path)
		if got := resp.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
			t.Errorf("%s: X-Frame-Options = %q, want SAMEORIGIN", path, got)
		}
		if got := resp.Header.Get("Content-Security-Policy"); got != "sandbox" {
			t.Errorf("%s: Content-Security-Policy = %q, want sandbox", path, got)
		}
		_ = resp.Body.Close()
	}
}
