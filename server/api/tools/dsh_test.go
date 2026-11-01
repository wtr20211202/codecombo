package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestMain 隔离令牌自动回收的副作用：真实用户设置（saveDshToken 落盘）与
// 真实日志路径不得被测试触碰
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "sc-dsh-test")
	if err != nil {
		panic(err)
	}
	logPath := filepath.Join(dir, "dsh-web.log")
	origLogFn, origSaveFn := dshWebLogPathFn, saveDshTokenFn
	dshWebLogPathFn = func() string { return logPath }
	saveDshTokenFn = func(string) {}
	code := m.Run()
	dshWebLogPathFn, saveDshTokenFn = origLogFn, origSaveFn
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// tokenStateFor：dsh 令牌换发会话的完整流程（303 + Secure cookie → 跟随请求
// 带 cookie → 应用页）必须判 valid——cookiejar 尊重 Secure 语义会误判 stale，
// 探测客户端须手动回贴响应 cookie。反向：无效令牌（直出鉴权页）判 stale
func TestTokenStateForSecureCookieExchange(t *testing.T) {
	_ = os.Remove(dshWebLogPathFn()) // 清日志防自动回收干扰 stale 用例
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") == "good" {
			http.SetCookie(w, &http.Cookie{Name: "dsh-auth-x", Value: "sess", Path: "/", HttpOnly: true, Secure: true})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		if ck, err := r.Cookie("dsh-auth-x"); err == nil && ck.Value == "sess" {
			fmt.Fprint(w, "<html>dsh web home</html>")
			return
		}
		fmt.Fprint(w, "dsh web authentication required; reopen the URL printed by dsh web.")
	}))
	defer srv.Close()

	if got := tokenStateFor(dshConfig{Base: srv.URL, Token: "good"}, localTargetID); got != "valid" {
		t.Errorf("tokenStateFor(good) = %q, want valid (303 + Secure cookie exchange)", got)
	}
	if got := tokenStateFor(dshConfig{Base: srv.URL, Token: "bad"}, localTargetID); got != "stale" {
		t.Errorf("tokenStateFor(bad) = %q, want stale", got)
	}
}

// rewriteRejectedTokenExchange：换发被拒（30x 弹回、无会话 cookie、请求带
// token=）改写 401 止住补签↔弹回死循环；成功换发与普通 30x 不碰
func TestRewriteRejectedTokenExchange(t *testing.T) {
	mkResp := func(status int, setCookie []string, query string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, "http://u/?"+query, nil)
		resp := &http.Response{StatusCode: status, Header: http.Header{}, Request: req}
		for _, ck := range setCookie {
			resp.Header.Add("Set-Cookie", ck)
		}
		return resp
	}

	resp := mkResp(http.StatusSeeOther, nil, "token=stale")
	rewriteRejectedTokenExchange(resp)
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("Location") != "" {
		t.Errorf("rejected exchange: status=%d location=%q, want 401 with Location stripped",
			resp.StatusCode, resp.Header.Get("Location"))
	}

	resp = mkResp(http.StatusSeeOther, []string{"dsh-auth-x=1; Path=/"}, "token=good")
	rewriteRejectedTokenExchange(resp)
	if resp.StatusCode != http.StatusSeeOther {
		t.Errorf("successful exchange rewritten: status=%d, want untouched 303", resp.StatusCode)
	}

	resp = mkResp(http.StatusSeeOther, nil, "")
	rewriteRejectedTokenExchange(resp)
	if resp.StatusCode != http.StatusSeeOther {
		t.Errorf("plain site redirect rewritten: status=%d, want untouched 303", resp.StatusCode)
	}
}

// tokenStateFor 自动回收：设置存量令牌失效而启动日志里有新令牌时，重取写回
// 并复探为 valid（dsh 重启后的零操作自愈路径）
func TestTokenStateForAutoRecapture(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") == "fresh" {
			fmt.Fprint(w, "<html>dsh web home</html>")
			return
		}
		fmt.Fprint(w, "dsh web authentication required; reopen the URL printed by dsh web.")
	}))
	defer srv.Close()

	logPath := dshWebLogPathFn()
	if err := os.WriteFile(logPath, []byte("[sc] launch: dsh web --no-open\ndsh web: http://127.0.0.1:3080/?token=fresh\n"), 0600); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(logPath) }()
	var saved []string
	origSave := saveDshTokenFn
	saveDshTokenFn = func(tok string) { saved = append(saved, tok) }
	defer func() { saveDshTokenFn = origSave }()

	got := tokenStateFor(dshConfig{Base: srv.URL, Token: "stale"}, localTargetID)
	if got != "valid" {
		t.Errorf("tokenStateFor = %q, want valid (auto-recaptured fresh token from launch log)", got)
	}
	if len(saved) != 1 || saved[0] != "fresh" {
		t.Errorf("saved tokens = %v, want [fresh]", saved)
	}
}

// stripCookieAttribute：剥 Secure、大小写不敏感、其余属性与 name=value 保留
func TestStripCookieAttribute(t *testing.T) {
	cases := []struct{ in, attr, want string }{
		{"dsh-auth-x=abc; Path=/; HttpOnly; Secure", "Secure", "dsh-auth-x=abc; Path=/; HttpOnly"},
		{"dsh-auth-x=abc; Path=/; secure", "Secure", "dsh-auth-x=abc; Path=/"},
		{"dsh-auth-x=abc; Path=/", "Secure", "dsh-auth-x=abc; Path=/"},
		{"dsh-auth-x=ab=cd; Secure; SameSite=Lax", "Secure", "dsh-auth-x=ab=cd; SameSite=Lax"},
	}
	for _, tc := range cases {
		if got := stripCookieAttribute(tc.in, tc.attr); got != tc.want {
			t.Errorf("stripCookieAttribute(%q, %q) = %q, want %q", tc.in, tc.attr, got, tc.want)
		}
	}
}

// captureLaunchToken：单条/多条 token 行取最后一条、非预设字母表不截断、
// prose 尾部标点裁剪、无 token 报缺
func TestCaptureLaunchToken(t *testing.T) {
	cases := []struct {
		name string
		log  string
		want string
		ok   bool
	}{
		{
			name: "single line",
			log:  "[sc] launch: dsh web --no-open\ndsh web: http://127.0.0.1:3080/?token=Abc_123-xyz\n",
			want: "Abc_123-xyz", ok: true,
		},
		{
			name: "supervisor restart appends newer token line",
			log: "dsh web: http://127.0.0.1:3080/?token=old\n" +
				"dsh web: http://127.0.0.1:3080/?token=new\n",
			want: "new", ok: true,
		},
		{
			name: "token alphabet beyond [A-Za-z0-9_-] not truncated",
			log:  "dsh web: http://127.0.0.1:3080/?token=aa.bb~cc_dd\n",
			want: "aa.bb~cc_dd", ok: true,
		},
		{
			name: "trailing prose punctuation trimmed",
			log:  "ready at http://127.0.0.1:3080/?token=tok123.\n",
			want: "tok123", ok: true,
		},
		{
			name: "token stops at query ampersand",
			log:  "dsh web: http://127.0.0.1:3080/?token=tok&x=1\n",
			want: "tok", ok: true,
		},
		{name: "no token", log: "listening on 3080\n", want: "", ok: false},
	}
	for _, tc := range cases {
		got, ok := captureLaunchToken([]byte(tc.log))
		if ok != tc.ok || got != tc.want {
			t.Errorf("%s: captureLaunchToken = (%q, %v), want (%q, %v)",
				tc.name, got, ok, tc.want, tc.ok)
		}
	}
}

// injectHeadStyle：<head> 后插入 + 边界校验 + 无 head 回退
func TestInjectHeadStyle(t *testing.T) {
	const style = `<style id="x">a{b:c}</style>`

	cases := []struct {
		name  string
		in    string
		want  string // 空串 = 断言原样未变
		count int    // style 出现次数
	}{
		{
			name:  "head 基础",
			in:    "<html><head><title>t</title></head></html>",
			want:  "<html><head><style id=\"x\">a{b:c}</style><title>t</title></head></html>",
			count: 1,
		},
		{
			name:  "head 带属性",
			in:    "<html><HEAD lang=en><body></body></html>",
			want:  "<html><HEAD lang=en><style id=\"x\">a{b:c}</style><body></body></html>",
			count: 1,
		},
		{
			name:  "header 不误匹配（回退到文档开头）",
			in:    "<html><header>nav</header></html>",
			count: 1,
		},
		{
			name:  "无 head 回退到开头",
			in:    "<html><body>hi</body></html>",
			want:  style + "<html><body>hi</body></html>",
			count: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(injectHeadStyle([]byte(tc.in), style))
			if got != tc.want && tc.want != "" {
				t.Fatalf("got %q want %q", got, tc.want)
			}
			if n := strings.Count(got, style); n != tc.count {
				t.Fatalf("style count = %d want %d", n, tc.count)
			}
		})
	}
}

// Director 转发必须逐字节保留 RawQuery（dsh 非标插件 URL 依赖原样字节：
// /plugins/??a,b&rev=x 若经 url.Values 重编码会 404）。锁定约定形态——
// 实现侧禁止 url.Values.Encode() 重写
func TestDirectorPreservesRawQueryBytes(t *testing.T) {
	raw := "/plugins/??a,b&rev=cddf5581d5d5"
	// url.Values 重编码会把 "??a,b" 打碎成 "a=b"（实测导致上游 404）
	reencoded := (&url.Values{}).Encode()
	if reencoded == raw {
		t.Fatalf("re-encoding unexpectedly preserved %q", raw)
	}
	if !strings.Contains(raw, "??") {
		t.Fatalf("fixture lost the non-standard double-question form: %q", raw)
	}
}

// stripQueryParam 保字节剔除：dsh 插件 URL 非标形态（/plugins/??a,b&rev=x）
// 经 url.Values 重编码会 404——必须纯文本级剔除，其余部分逐字节保留
func TestStripQueryParam(t *testing.T) {
	cases := []struct {
		name, in, key, want string
	}{
		{"单参数剔除", "a=1&scDshTarget=x&b=2", "scDshTarget", "a=1&b=2"},
		{"尾部参数剔除", "a=1&scDshTarget=x", "scDshTarget", "a=1"},
		{"头部参数剔除", "scDshTarget=x&a=1", "scDshTarget", "a=1"},
		{"非标插件 URL 保字节", "@deepseek-ai/dsh-client.js,@x/b.js&rev=cddf5581d5d5&scDshTarget=t1",
			"scDshTarget", "@deepseek-ai/dsh-client.js,@x/b.js&rev=cddf5581d5d5"},
		{"无该参数原样", "a=1&b=2", "scDshTarget", "a=1&b=2"},
		{"同前缀参数不误删", "scDshTargetFoo=1", "scDshTarget", "scDshTargetFoo=1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripQueryParam(tc.in, tc.key); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

// isLoopbackBrowserHost：回环判定（含 IPv6 括号/带端口形态），决定是否做
// Secure-Context 降级改写——回环浏览器走零改写快路径
func TestIsLoopbackBrowserHost(t *testing.T) {
	loop := []string{"", "127.0.0.1", "127.0.0.1:3081", "[::1]:3081", "localhost", "localhost:9999", "LOCALHOST:80"}
	for _, h := range loop {
		if !isLoopbackBrowserHost(h) {
			t.Fatalf("%q should be loopback", h)
		}
	}
	// RFC1918 夹具而非真实内网地址：测试面随发布拷贝包外发，不得携带开发环境拓扑（P-20261025-2 敏感扫描门禁）
	remote := []string{"10.10.0.10", "10.10.0.10:3081", "example.com:80", "[fe80::1]:3081"}
	for _, h := range remote {
		if isLoopbackBrowserHost(h) {
			t.Fatalf("%q should NOT be loopback", h)
		}
	}
}

// shouldIssueToken 自动签发门：仅无 cookie 的首页 GET/HEAD 首访 + 已知 token
func TestShouldIssueToken(t *testing.T) {
	yes := []struct {
		name, method, path, rawQuery string
	}{
		{"首页 GET", "GET", "/", ""},
		{"首页 HEAD", "HEAD", "/", ""},
		{"带无关查询", "GET", "/", "foo=bar"},
	}
	for _, c := range yes {
		t.Run(c.name, func(t *testing.T) {
			if !shouldIssueToken(c.method, c.path, c.rawQuery, false, true) {
				t.Fatal("expected issue")
			}
		})
	}
	no := []struct {
		name, method, path, rawQuery string
		authCookie, hasToken         bool
	}{
		{"POST 不签发", "POST", "/", "", false, true},
		{"非首页不签发", "GET", "/api/settings", "", false, true},
		{"URL 已带 token 不签发", "GET", "/", "token=abc", false, true},
		{"已有会话 cookie 不签发", "GET", "/", "", true, true},
		{"token 未知不签发", "GET", "/", "", false, false},
	}
	for _, c := range no {
		t.Run(c.name, func(t *testing.T) {
			if shouldIssueToken(c.method, c.path, c.rawQuery, c.authCookie, c.hasToken) {
				t.Fatal("expected NOT issue")
			}
		})
	}
}

// baseForTarget/tokenForTarget 多目标解析：未知目标回退本机（目标删除后残留
// cookie/URL 自动回落，不 404）
func TestTargetResolution(t *testing.T) {
	cfg := dshConfig{
		Base:  "http://127.0.0.1:3080",
		Token: "local-tok",
		Targets: []config.DshTarget{
			{ID: "t1", Name: "gpu-box", Base: "http://192.168.1.10:3080/", Token: "t1-tok"},
		},
	}
	if got := baseForTarget(cfg, "local"); got != cfg.Base {
		t.Fatalf("local base = %q", got)
	}
	if got := baseForTarget(cfg, "t1"); got != "http://192.168.1.10:3080" {
		t.Fatalf("t1 base = %q（应规整去尾斜杠）", got)
	}
	if got := tokenForTarget(cfg, "t1"); got != "t1-tok" {
		t.Fatalf("t1 token = %q", got)
	}
	// 未知目标回退本机
	if got := baseForTarget(cfg, "gone"); got != cfg.Base {
		t.Fatalf("unknown fallback = %q", got)
	}
	if got := tokenForTarget(cfg, "gone"); got != "local-tok" {
		t.Fatalf("unknown fallback token = %q", got)
	}
}

// normalizeDshBase 上游规整：去尾斜杠/路径、仅留 scheme://host[:port]
func TestNormalizeDshBase(t *testing.T) {
	cases := map[string]string{
		"http://127.0.0.1:3080":        "http://127.0.0.1:3080",
		"http://127.0.0.1:3080/":       "http://127.0.0.1:3080",
		"https://box.lan:8080/dsh/web": "https://box.lan:8080",
	}
	for in, want := range cases {
		if got := normalizeDshBase(in); got != want {
			t.Fatalf("normalize %q = %q want %q", in, got, want)
		}
	}
}

// withLoopbackNoProxy：no_proxy 必须覆盖回环（吸收自 dsh-web 脚本——防止进程
// 内部到 127.0.0.1 的请求被误送代理），已有则不动
func TestWithLoopbackNoProxy(t *testing.T) {
	if got := withLoopbackNoProxy(""); got != "localhost,127.0.0.1" {
		t.Fatalf("empty = %q", got)
	}
	if got := withLoopbackNoProxy("internal.corp"); got != "localhost,127.0.0.1,internal.corp" {
		t.Fatalf("append = %q", got)
	}
	if got := withLoopbackNoProxy("localhost,127.0.0.1,internal.corp"); got != "localhost,127.0.0.1,internal.corp" {
		t.Fatalf("existing loopback should be untouched, got %q", got)
	}
}

// lastDshPathLine：交互 shell 探测输出混有 motd/告警噪声时，取最后一个
// 形如绝对路径且指向 dsh 的词；无命中返回空
func TestLastDshPathLine(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"纯净输出", "/home/u/.nvm/versions/node/v20.5.1/bin/dsh\n", "/home/u/.nvm/versions/node/v20.5.1/bin/dsh"},
		{"motd 噪声在前", "Welcome to Ubuntu 24.04 LTS\n * docs: https://help.ubuntu.com\n/usr/local/bin/dsh\n", "/usr/local/bin/dsh"},
		{"作业控制告警在前", "bash: cannot set terminal process group (-1): Inappropriate ioctl\nbash: no job control in this shell\n/home/u/.local/bin/dsh\n", "/home/u/.local/bin/dsh"},
		{"命令不存在", "Welcome\nbash: line 1: dsh: command not found\n", ""},
		{"相对名不算（alias/函数）", "dsh\n", ""},
	}
	for _, tc := range cases {
		if got := lastDshPathLine(tc.in); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

// pickNewestNvmDsh：多版本目录取 semver 最新（字典序 v9 < v18 会误导，
// 必须数值比较）；无法解析版本时回退最后一个
func TestPickNewestNvmDsh(t *testing.T) {
	got := pickNewestNvmDsh([]string{
		"/home/u/.nvm/versions/node/v9.11.2/bin/dsh",
		"/home/u/.nvm/versions/node/v18.16.0/bin/dsh",
		"/home/u/.nvm/versions/node/v20.5.1/bin/dsh",
	})
	if got != "/home/u/.nvm/versions/node/v20.5.1/bin/dsh" {
		t.Fatalf("newest = %q", got)
	}
	if got := pickNewestNvmDsh([]string{"/x/unknown-layout/dsh"}); got != "" {
		t.Fatalf("unparsable should be empty, got %q", got)
	}
}

// dshQuoteIfNeeded：含空白的全路径加双引号（经 /bin/sh -c 执行），常规路径原样
func TestDshQuoteIfNeeded(t *testing.T) {
	if got := dshQuoteIfNeeded("/usr/local/bin/dsh"); got != "/usr/local/bin/dsh" {
		t.Fatalf("plain = %q", got)
	}
	if got := dshQuoteIfNeeded("/home/a b/.nvm/x/bin/dsh"); got != `"/home/a b/.nvm/x/bin/dsh"` {
		t.Fatalf("spaced = %q", got)
	}
}

// lastPathLine：lastDshPathLine 的通用形，needle 匹配 npm 时行为一致
func TestLastPathLineNpm(t *testing.T) {
	in := "Welcome to Ubuntu 24.04 LTS\nbash: cannot set terminal process group\n/home/u/.nvm/versions/node/v24.3.0/bin/npm\n"
	if got := lastPathLine(in, "npm"); got != "/home/u/.nvm/versions/node/v24.3.0/bin/npm" {
		t.Fatalf("npm hit = %q", got)
	}
	// needle 不匹配的绝对路径不算
	if got := lastPathLine("/usr/bin/dsh\n", "npm"); got != "" {
		t.Fatalf("mismatched needle should be empty, got %q", got)
	}
}

// pickNewestNvmWindows：nvm-windows 多版本目录（版本是父目录）取 semver 最新。
// 输入契约是反斜杠路径——filepath.Dir 在 Linux 不认 `\`（整串一个 segment），
// 该函数生产侧也只在 windows 分支被调用：非 Windows 跳过（WSL/Linux 实测踩中）
func TestPickNewestNvmWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("nvm-windows 反斜杠路径契约仅 Windows 语义")
	}
	got := pickNewestNvmWindows([]string{
		`C:\Users\u\AppData\Roaming\nvm\v18.16.0\npm.cmd`,
		`C:\Users\u\AppData\Roaming\nvm\v9.11.2\npm.cmd`,
		`C:\Users\u\AppData\Roaming\nvm\v22.14.0\npm.cmd`,
	})
	if got != `C:\Users\u\AppData\Roaming\nvm\v22.14.0\npm.cmd` {
		t.Fatalf("newest = %q", got)
	}
	if got := pickNewestNvmWindows([]string{`C:\nvm\junk\npm.cmd`}); got != "" {
		t.Fatalf("unparsable should be empty, got %q", got)
	}
}

// runNpmCmd PATH 失败回退：服务进程 PATH 缺 npm（守护进程/systemd 场景）时，
// 经 nvm 多版本 glob + pickExecutable 解析出绝对路径后仍可执行。
// 端到端伪造：临时 USERPROFILE/Home 下放 nvm 两个版本的 fake npm（取最新），
// PATH 剥到只剩 System32，断言 runNpmCmd 拿到最新版输出
func TestRunNpmCmdPathFallback(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		t.Skip("fake npm launcher only scripted for windows/linux")
	}
	// 回退路径的可隔离前提：系统 npm 与登录 shell npm 都不存在。产品在
	// Linux 的候选链含硬编码 /usr/local/bin/npm、/usr/bin/npm 与 bash -lic
	// 登录 shell 探测（后者会重建完整 PATH，测试沙箱拦不住）——任一存在时
	// 主解析必命中真 npm，回退分支无从验证，跳过（WSL/Linux 实测踩中）
	if runtime.GOOS != "windows" {
		if _, err := os.Stat("/usr/local/bin/npm"); err == nil {
			t.Skip("本机存在 /usr/local/bin/npm，回退路径无法隔离")
		}
		if _, err := os.Stat("/usr/bin/npm"); err == nil {
			t.Skip("本机存在 /usr/bin/npm，回退路径无法隔离")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := exec.CommandContext(ctx, "bash", "-lic", "command -v npm").CombinedOutput()
		cancel()
		if err == nil && lastPathLine(string(out), "npm") != "" {
			t.Skip("登录 shell 可解析到 npm，回退路径无法隔离")
		}
	}
	home := t.TempDir()
	binRel := filepath.Join(".nvm", "versions", "node")
	var script string
	if runtime.GOOS == "windows" {
		// Windows 无 nvm（用户级）布局：借用 nvm-windows 多版本目录伪造
		for _, v := range []string{"v9.9.9", "v22.14.0"} {
			dir := filepath.Join(home, "AppData", "Roaming", "nvm", v)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			p := filepath.Join(dir, "npm.cmd")
			body := "@echo off\r\necho fake-npm-" + v + "\r\n"
			if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		script = "windows"
	} else {
		for _, v := range []string{"v9.9.9", "v22.14.0"} {
			dir := filepath.Join(home, binRel, v, "bin")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			p := filepath.Join(dir, "npm")
			// 模拟真实 npm（env node 脚本）：自身目录不在子进程 PATH 时
			// exit 127——验证 runNpmCmd 必须把解析出的 bin 目录注入 PATH
			body := "#!/bin/sh\nd=$(cd \"$(dirname \"$0\")\" && pwd)\n" +
				"case \":$PATH:\" in *\":$d:\"*) echo fake-npm-" + v + " ;; *) echo \"env: node: No such file or directory\" >&2; exit 127 ;; esac\n"
			if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		script = "unix"
	}
	_ = script
	// npmCmd() 经 store 读设置：纯单测环境装上最小 store（npmCmd 也会容忍 nil）
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	resetNpmResolveCacheForTest()
	defer resetNpmResolveCacheForTest()

	t.Setenv("PATH", `C:\Windows\System32`)
	if runtime.GOOS != "windows" {
		t.Setenv("PATH", "/usr/bin/nowhere")
	}
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	stdout, stderr, err := runNpmCmd(10*time.Second, "-v")
	if err != nil {
		t.Fatalf("fallback exec failed: %v stderr=%s", err, stderr)
	}
	if got := strings.TrimSpace(stdout); got != "fake-npm-v22.14.0" {
		t.Fatalf("want newest fake npm output, got %q (stderr=%s)", got, stderr)
	}
}

// pickExecutable：候选里第一个存在的常规文件（执行位仅 Unix 校验——
// Windows 文件系统不携带权限位，noexec 分支只在 Unix 跑）
func TestPickExecutable(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing", "dsh")
	if got := pickExecutable([]string{missing}); got != "" {
		t.Fatalf("missing = %q", got)
	}
	noExec := filepath.Join(dir, "noexec")
	if err := os.WriteFile(noExec, []byte("#!/bin/sh\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ok := filepath.Join(dir, "ok")
	if err := os.WriteFile(ok, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if got := pickExecutable([]string{missing, noExec, ok}); got != noExec {
			t.Fatalf("windows picked %q want %q", got, noExec)
		}
		return
	}
	if got := pickExecutable([]string{missing, noExec, ok}); got != ok {
		t.Fatalf("picked %q want %q", got, ok)
	}
}

// tailFile：日志尾部截取（超长按行对齐，短文原样，缺文件空串）
func TestTailFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "log.txt")
	if got := tailFile(p, 100); got != "" {
		t.Fatalf("missing file = %q", got)
	}
	if err := os.WriteFile(p, []byte("line1\nline2\nline3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := tailFile(p, 100); got != "line1\nline2\nline3" {
		t.Fatalf("short file = %q", got)
	}
	if got := tailFile(p, 12); got != "line2\nline3" {
		t.Fatalf("truncated file = %q", got)
	}
}

// dshCmdDir：仅识别首 token 为绝对路径的启动命令（全路径直启含引号包裹），
// 裸命令/包装形态/相对路径一律空——空 = 不做 PATH 注入
func TestDshCmdDir(t *testing.T) {
	abs := "/opt/tools/dsh"
	spaced := "/opt/my tools/dsh"
	if runtime.GOOS == "windows" {
		abs = `C:\opt\tools\dsh`
		spaced = `C:\opt\my tools\dsh`
	}
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"裸命令", "dsh web --no-open", ""},
		{"wsl 包装", "wsl.exe dsh web --no-open", ""},
		{"相对路径", "tools/dsh web", ""},
		{"空", "", ""},
		{"全路径", abs + " web --no-open", filepath.Dir(abs)},
		{"全路径无参数", abs, filepath.Dir(abs)},
		{"引号包裹全路径", `"` + spaced + `" web --no-open`, filepath.Dir(spaced)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dshCmdDir(tc.in); got != tc.want {
				t.Fatalf("dshCmdDir(%q) = %q want %q", tc.in, got, tc.want)
			}
		})
	}
}

// prependEnvPath：既有 PATH 插最前（无重复键），缺失则新增；Windows 下 Path
// 键名按大小写不敏感匹配
func TestPrependEnvPath(t *testing.T) {
	sep := ":"
	if runtime.GOOS == "windows" {
		sep = ";"
	}
	env := prependEnvPath([]string{"A=1", "PATH=/usr/bin", "B=2"}, "/opt/bin")
	want := []string{"A=1", "PATH=/opt/bin" + sep + "/usr/bin", "B=2"}
	if len(env) != len(want) {
		t.Fatalf("len = %d want %d (%q)", len(env), len(want), env)
	}
	for i := range want {
		if env[i] != want[i] {
			t.Fatalf("env[%d] = %q want %q", i, env[i], want[i])
		}
	}
	env = prependEnvPath([]string{"A=1"}, "/opt/bin")
	if len(env) != 2 || env[1] != "PATH=/opt/bin" {
		t.Fatalf("missing PATH appended: %q", env)
	}
	if runtime.GOOS == "windows" {
		env = prependEnvPath([]string{"Path=C:\\bin"}, "C:\\opt\\bin")
		if env[0] != `Path=C:\opt\bin;C:\bin` {
			t.Fatalf("Path key = %q", env[0])
		}
	}
}

// dshChildEnv：全路径启动命令 → PATH 首项为 dsh 同目录（shebang env node 的
// 根因治理）；代理环境存在时补 NODE_USE_ENV_PROXY 与回环 no_proxy
func TestDshChildEnv(t *testing.T) {
	abs := "/opt/tools/dsh"
	if runtime.GOOS == "windows" {
		abs = `C:\opt\tools\dsh`
	}
	env := dshChildEnv(abs + " web --no-open")
	sep := ":"
	if runtime.GOOS == "windows" {
		sep = ";"
	}
	wantPrefix := filepath.Dir(abs) + sep
	var pathVal string
	for _, kv := range env {
		if k, v, _ := strings.Cut(kv, "="); strings.EqualFold(k, "PATH") {
			pathVal = v
			break
		}
	}
	if !strings.HasPrefix(pathVal, wantPrefix) {
		t.Fatalf("PATH value = %q want prefix %q", pathVal, wantPrefix)
	}

	t.Setenv("https_proxy", "http://127.0.0.1:7890")
	env = dshChildEnv("dsh web --no-open") // 裸命令：仅代理注入，不动 PATH
	hasProxyFlag, hasNoProxy := false, false
	for _, kv := range env {
		switch {
		case kv == "NODE_USE_ENV_PROXY=1":
			hasProxyFlag = true
		case strings.HasPrefix(kv, "no_proxy=") && strings.Contains(kv, "127.0.0.1"):
			hasNoProxy = true
		}
	}
	if !hasProxyFlag || !hasNoProxy {
		t.Fatalf("proxy env missing: proxyFlag=%v noProxy=%v", hasProxyFlag, hasNoProxy)
	}
}

// dshProxyHandler 独立标签页守卫矩阵：设置关闭「允许独立标签页访问」时，
// 顶层导航（Sec-Fetch-Dest: document）返回 403 引导页而非透传；iframe 嵌入
// （dest=iframe/frame）与子资源/XHR（dest=empty/script）及无 Sec-Fetch 头的
// 旧浏览器（礼貌层宽容降级）一律放行到上游；开关打开全放行
func TestDshProxyHandlerStandaloneGuard(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "<html>dsh upstream</html>")
	}))
	defer upstream.Close()

	mk := func() http.Handler {
		doc := filestore.New(t.TempDir())
		store.SetDefault(store.New(doc))
		t.Cleanup(func() { store.SetDefault(nil) })
		// 上游 base 指向假上游（守卫路径不触上游，放行路径直连假 handler）
		sc := store.Get().Settings.Get()
		sc.Server.DshWebBase = upstream.URL
		return dshProxyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, "upstream-reached")
		}))
	}
	setStandalone := func(allow bool) {
		sc := store.Get().Settings.Get()
		sc.Server.DshAllowStandalone = &allow
	}

	run := func(h http.Handler, headers map[string]string) int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	t.Run("关闭+顶层导航=403引导页", func(t *testing.T) {
		h := mk()
		setStandalone(false)
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Sec-Fetch-Dest", "document")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "Codecombo") || !strings.Contains(body, "<html") {
			t.Fatal("blocked page should be friendly HTML mentioning Codecombo")
		}
	})

	t.Run("关闭+iframe嵌入=放行", func(t *testing.T) {
		h := mk()
		setStandalone(false)
		for _, dest := range []string{"iframe", "frame", "empty", "script", ""} {
			if code := run(h, map[string]string{"Sec-Fetch-Dest": dest}); code != 200 {
				t.Fatalf("dest=%q code = %d, want 200 (passthrough)", dest, code)
			}
		}
	})

	t.Run("关闭+无SecFetch头旧浏览器=宽容放行", func(t *testing.T) {
		h := mk()
		setStandalone(false)
		if code := run(h, nil); code != 200 {
			t.Fatalf("no-sec-fetch code = %d, want 200", code)
		}
	})

	t.Run("开启+顶层导航=放行", func(t *testing.T) {
		h := mk()
		setStandalone(true)
		if code := run(h, map[string]string{"Sec-Fetch-Dest": "document"}); code != 200 {
			t.Fatalf("allowed-standalone code = %d, want 200", code)
		}
	})
}

// parseGitHubRepoURL：npm repository.url → owner/repo（仅 github.com https/git
// 形态；owner/repo 字符集校验防注入 API 路径）
func TestParseGitHubRepoURL(t *testing.T) {
	cases := []struct {
		in, owner, repo string
		ok              bool
	}{
		{"git+https://github.com/deepseek-ai/deepseek-harness.git", "deepseek-ai", "deepseek-harness", true},
		{"https://github.com/owner/repo", "owner", "repo", true},
		{"git@github.com:owner/repo.git", "", "", false},  // ssh 形态不支持
		{"https://gitlab.com/owner/repo", "", "", false},  // 非 github
		{"https://github.com/own er/repo", "", "", false}, // 非法字符
		{"https://github.com/owner", "", "", false},       // 缺 repo 段
		{"", "", "", false}, // 空
		{"https://github.com/own$er/repo", "", "", false}, // 注入字符
	}
	for _, tc := range cases {
		owner, repo, ok := parseGitHubRepoURL(tc.in)
		if ok != tc.ok || (ok && (owner != tc.owner || repo != tc.repo)) {
			t.Fatalf("parseGitHubRepoURL(%q) = %q/%q %v, want %q/%q %v", tc.in, owner, repo, ok, tc.owner, tc.repo, tc.ok)
		}
	}
}

// parseGitHubReleases：tag 去 v 前缀、draft 剔除、字段映射
func TestParseGitHubReleases(t *testing.T) {
	body := []byte(`[
		{"tag_name":"dsh-v0.2.0-rc.2","name":"rc2","body":"notes rc2","published_at":"2026-09-29T14:00:00Z","html_url":"https://github.com/x/y/releases/1"},
		{"tag_name":"0.2.0-rc.1","name":"rc1","body":"notes rc1","published_at":"2026-09-28T14:00:00Z","html_url":"https://github.com/x/y/releases/2"},
		{"tag_name":"v0.1.0","name":"draft","body":"","published_at":null,"html_url":"","draft":true}
	]`)
	got := parseGitHubReleases(body)
	if len(got) != 2 {
		t.Fatalf("want 2 releases (draft excluded), got %d", len(got))
	}
	if got[0].Version != "0.2.0-rc.2" || got[0].Body != "notes rc2" || got[0].URL == "" {
		t.Fatalf("entry[0] = %+v", got[0])
	}
	if got[1].Version != "0.2.0-rc.1" {
		t.Fatalf("tag without v prefix should be kept as-is, got %q", got[1].Version)
	}
	if got := parseGitHubReleases([]byte(`not-json`)); got != nil {
		t.Fatalf("invalid json should return nil, got %v", got)
	}
}
