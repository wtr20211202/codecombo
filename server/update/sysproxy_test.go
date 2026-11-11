package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 系统代理探测（P-20261110-1 S5）面测试：三平台原始形态（注册表值 / scutil 输出 /
// gsettings 输出文本）一律以夹具注入读取器——不读开发机真实代理状态、不改任何系统
// 设置（护栏硬性）；解析层平台无关，每个平台都跑全三套夹具。子进程执行路径由测试
// 二进制自身充当查询命令验证（不调真实 scutil/gsettings）。

// leakMarker 畸形值夹具里的标记：断言错误文本不回显原始配置值（可能内嵌凭据）
const leakMarker = "leak-check"

const leakHost = leakMarker + ".example.com"

// wantProxy 期望结果：url 为归一结果；url 空且 !malformed = 未配置（无错）
type wantProxy struct {
	url       string
	malformed bool
}

// assertDetect 经生产同款编排（超时 / 归一 / 校验单点）跑夹具探测器并核对
func assertDetect(t *testing.T, name string, p sysProxyProbe, wantSource string, w wantProxy) {
	t.Helper()
	got, src, err := detectSystemProxyWith(context.Background(), p, 5*time.Second)
	if src != wantSource {
		t.Errorf("%s: source = %q, want %q", name, src, wantSource)
	}
	if w.malformed {
		// 畸形串静默：URL 空 + ErrSystemProxyMalformed（调用方落下一档），不回显原值
		if got != "" || !errors.Is(err, ErrSystemProxyMalformed) {
			t.Errorf("%s: got (%q, %v), want silent malformed fallthrough", name, got, err)
		}
		if err != nil && strings.Contains(err.Error(), leakMarker) {
			t.Errorf("%s: error echoes raw setting value: %v", name, err)
		}
		return
	}
	if err != nil || got != w.url {
		t.Errorf("%s: got (%q, %v), want %q", name, got, err, w.url)
	}
}

// ── Windows：注册表值夹具 ────────────────────────────────────────────────

func registryFixture(enable uint64, server string) sysProxyProbe {
	return winInetProbe(func() (winInetValues, error) {
		return winInetValues{proxyEnable: enable, proxyServer: server}, nil
	})
}

func TestSystemProxyWindowsRegistry(t *testing.T) {
	cases := []struct {
		name   string
		enable uint64
		server string
		want   wantProxy
	}{
		// scheme 归一定案：无 scheme 补 http://（本机代理端口是明文 CONNECT），绝非 https://
		{"host:port 补 http", 1, "127.0.0.1:7890", wantProxy{url: "http://127.0.0.1:7890"}},
		{"https= 键是目标类别非代理协议，同样补 http", 1, "https=127.0.0.1:7890", wantProxy{url: "http://127.0.0.1:7890"}},
		{"socks= 归 socks5", 1, "socks=127.0.0.1:7891", wantProxy{url: "socks5://127.0.0.1:7891"}},
		// 分协议串档序：全协议裸串 > https > http > socks
		{"分协议串取 https 档", 1, "http=127.0.0.1:8080;https=127.0.0.1:8443;ftp=127.0.0.1:2121;socks=127.0.0.1:1080", wantProxy{url: "http://127.0.0.1:8443"}},
		{"缺 https 档取 http 档", 1, "ftp=proxy.example.com:2121;http=proxy.example.com:3128", wantProxy{url: "http://proxy.example.com:3128"}},
		{"http 档先于 socks 档", 1, "socks=127.0.0.1:1080;http=127.0.0.1:8080", wantProxy{url: "http://127.0.0.1:8080"}},
		{"全协议裸串先于分协议档", 1, "https=127.0.0.1:8443;127.0.0.1:7890", wantProxy{url: "http://127.0.0.1:7890"}},
		{"键名大小写与空白容忍", 1, " HTTPS = 127.0.0.1:8443 ; ", wantProxy{url: "http://127.0.0.1:8443"}},
		{"空值档视同缺项", 1, "https=;http=127.0.0.1:8080", wantProxy{url: "http://127.0.0.1:8080"}},
		// 值自带 scheme 照用（socks 族归 socks5）
		{"值自带 http scheme", 1, "https=http://127.0.0.1:7890", wantProxy{url: "http://127.0.0.1:7890"}},
		{"裸串自带 socks5 scheme", 1, "socks5://127.0.0.1:7891", wantProxy{url: "socks5://127.0.0.1:7891"}},
		{"socks:// 归 socks5", 1, "socks://127.0.0.1:7891", wantProxy{url: "socks5://127.0.0.1:7891"}},
		{"结尾单斜杠容忍", 1, "http://127.0.0.1:7890/", wantProxy{url: "http://127.0.0.1:7890"}},
		{"缺端口补默认", 1, "proxy.example.com", wantProxy{url: "http://proxy.example.com:80"}},
		{"空端口冒号按缺端口", 1, "proxy.example.com:", wantProxy{url: "http://proxy.example.com:80"}},
		{"IPv6 字面量", 1, "[::1]:7890", wantProxy{url: "http://[::1]:7890"}},
		// ProxyEnable=0 视为未配置：关代理后 ProxyServer 常残留旧值，不得误用
		{"ProxyEnable=0 残留 ProxyServer", 0, "127.0.0.1:7890", wantProxy{}},
		{"值全缺省", 0, "", wantProxy{}},
		{"启用但 ProxyServer 空白", 1, "  ", wantProxy{}},
		{"仅 ftp 档与更新链无关", 1, "ftp=127.0.0.1:2121", wantProxy{}},
		// 畸形串：静默落下一档，不冒泡原值
		{"端口越界", 1, leakHost + ":99999", wantProxy{malformed: true}},
		{"端口为 0", 1, leakHost + ":0", wantProxy{malformed: true}},
		{"非数字端口", 1, leakHost + ":abc", wantProxy{malformed: true}},
		{"带路径", 1, "http://" + leakHost + ":7890/proxy.pac", wantProxy{malformed: true}},
		{"不支持的 scheme", 1, "socks4://" + leakHost + ":1080", wantProxy{malformed: true}},
		{"主机含空白", 1, leakMarker + " host:7890", wantProxy{malformed: true}},
		{"选中档畸形不降格取低档", 1, "https=" + leakHost + ":abc;http=127.0.0.1:8080", wantProxy{malformed: true}},
	}
	for _, c := range cases {
		assertDetect(t, c.name, registryFixture(c.enable, c.server), SystemProxySourceWindowsRegistry, c.want)
	}
}

// ── macOS：scutil --proxy 输出夹具 ───────────────────────────────────────

// scutilClash Clash 类工具开启系统代理后的 scutil --proxy 输出（三档同址同端口）
const scutilClash = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}
`

// scutilScopedOnly 顶层关闭、仅 __SCOPED__ 网卡作用域嵌套字典里有启用键
const scutilScopedOnly = `<dictionary> {
  HTTPSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 7890
      HTTPSProxy : 127.0.0.1
    }
  }
}
`

// scutilDict 以顶层键行拼一份 scutil 字典输出
func scutilDict(lines ...string) string {
	var b strings.Builder
	b.WriteString("<dictionary> {\n")
	for _, l := range lines {
		b.WriteString("  " + l + "\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func scutilFixture(out string) sysProxyProbe {
	return scutilProbe(func(context.Context) ([]byte, error) { return []byte(out), nil })
}

func TestSystemProxyMacOSScutil(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want wantProxy
	}{
		{"三档同址取 HTTPS 档且补 http", scutilClash, wantProxy{url: "http://127.0.0.1:7890"}},
		{"HTTPS 档先于 HTTP 档", scutilDict(
			"HTTPEnable : 1", "HTTPPort : 3128", "HTTPProxy : proxy.example.com",
			"HTTPSEnable : 1", "HTTPSPort : 3129", "HTTPSProxy : proxy.example.com"),
			wantProxy{url: "http://proxy.example.com:3129"}},
		{"HTTPS 关闭取 HTTP 档", scutilDict(
			"HTTPEnable : 1", "HTTPPort : 3128", "HTTPProxy : proxy.example.com",
			"HTTPSEnable : 0", "HTTPSPort : 3129", "HTTPSProxy : proxy.example.com"),
			wantProxy{url: "http://proxy.example.com:3128"}},
		{"仅 SOCKS 归 socks5", scutilDict("SOCKSEnable : 1", "SOCKSPort : 7891", "SOCKSProxy : 127.0.0.1"),
			wantProxy{url: "socks5://127.0.0.1:7891"}},
		{"端口缺省补默认", scutilDict("HTTPSEnable : 1", "HTTPSProxy : proxy.example.com"),
			wantProxy{url: "http://proxy.example.com:80"}},
		{"端口 0 视同缺省", scutilDict("HTTPSEnable : 1", "HTTPSPort : 0", "HTTPSProxy : proxy.example.com"),
			wantProxy{url: "http://proxy.example.com:80"}},
		{"IPv6 主机补方括号", scutilDict("HTTPSEnable : 1", "HTTPSPort : 7890", "HTTPSProxy : ::1"),
			wantProxy{url: "http://[::1]:7890"}},
		{"CRLF 行尾", strings.ReplaceAll(scutilClash, "\n", "\r\n"), wantProxy{url: "http://127.0.0.1:7890"}},
		// 未配置
		{"全关残留主机", scutilDict(
			"HTTPEnable : 0", "HTTPPort : 7890", "HTTPProxy : 127.0.0.1",
			"HTTPSEnable : 0", "HTTPSPort : 7890", "HTTPSProxy : 127.0.0.1"), wantProxy{}},
		{"启用但无主机", scutilDict("HTTPSEnable : 1", "HTTPSPort : 7890"), wantProxy{}},
		{"仅 PAC 不求值", scutilDict("ProxyAutoConfigEnable : 1",
			"ProxyAutoConfigURLString : http://pac.example.com/proxy.pac"), wantProxy{}},
		{"空字典", "<dictionary> {\n}\n", wantProxy{}},
		{"__SCOPED__ 嵌套键不覆盖顶层", scutilScopedOnly, wantProxy{}},
		// 畸形：静默
		{"非字典输出", "unexpected output\n", wantProxy{malformed: true}},
		{"端口越界", scutilDict("HTTPSEnable : 1", "HTTPSPort : 70000", "HTTPSProxy : "+leakHost),
			wantProxy{malformed: true}},
		{"主机含空白", scutilDict("HTTPSEnable : 1", "HTTPSPort : 7890", "HTTPSProxy : "+leakMarker+" host"),
			wantProxy{malformed: true}},
	}
	for _, c := range cases {
		assertDetect(t, c.name, scutilFixture(c.out), SystemProxySourceMacOSScutil, c.want)
	}
}

// ── Linux：gsettings list-recursively 输出夹具 ───────────────────────────

// gsettingsManual GNOME 手动代理（Clash 类工具写法：三档同址）的
// `gsettings list-recursively org.gnome.system.proxy` 输出；认证字段为空串占位
const gsettingsManual = `org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.ftp host ''
org.gnome.system.proxy.ftp port 0
org.gnome.system.proxy.http authentication-password ''
org.gnome.system.proxy.http authentication-user ''
org.gnome.system.proxy.http enabled false
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.http use-authentication false
org.gnome.system.proxy.https host '127.0.0.1'
org.gnome.system.proxy.https port 7890
org.gnome.system.proxy.socks host '127.0.0.1'
org.gnome.system.proxy.socks port 7891
`

// gsettingsVariant 在基准夹具上按 old → new 成对替换，构造单一差异变体
func gsettingsVariant(pairs ...string) string {
	return strings.NewReplacer(pairs...).Replace(gsettingsManual)
}

func gsettingsFixture(out string) sysProxyProbe {
	return gsettingsProbe(func(context.Context) ([]byte, error) { return []byte(out), nil })
}

func TestSystemProxyGnomeGsettings(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want wantProxy
	}{
		{"manual 三档同址取 https 档且补 http", gsettingsManual, wantProxy{url: "http://127.0.0.1:7890"}},
		{"https 档空取 http 档", gsettingsVariant(
			"proxy.https host '127.0.0.1'", "proxy.https host ''",
			"proxy.http host '127.0.0.1'", "proxy.http host 'proxy.example.com'",
			"proxy.http port 7890", "proxy.http port 3128"),
			wantProxy{url: "http://proxy.example.com:3128"}},
		{"仅 socks 档归 socks5", gsettingsVariant(
			"proxy.https host '127.0.0.1'", "proxy.https host ''",
			"proxy.http host '127.0.0.1'", "proxy.http host ''"),
			wantProxy{url: "socks5://127.0.0.1:7891"}},
		{"端口 0 补默认", gsettingsVariant("proxy.https port 7890", "proxy.https port 0"),
			wantProxy{url: "http://127.0.0.1:80"}},
		{"双引号字符串", gsettingsVariant("proxy.https host '127.0.0.1'", `proxy.https host "127.0.0.1"`),
			wantProxy{url: "http://127.0.0.1:7890"}},
		{"带类型注解的端口", gsettingsVariant("proxy.https port 7890", "proxy.https port uint16 7890"),
			wantProxy{url: "http://127.0.0.1:7890"}},
		{"CRLF 行尾", strings.ReplaceAll(gsettingsManual, "\n", "\r\n"), wantProxy{url: "http://127.0.0.1:7890"}},
		// 未配置
		{"mode none 残留主机", gsettingsVariant("mode 'manual'", "mode 'none'"), wantProxy{}},
		{"mode auto 为 PAC 不求值", gsettingsVariant("mode 'manual'", "mode 'auto'"), wantProxy{}},
		{"manual 但三档皆无主机", gsettingsVariant("'127.0.0.1'", "''"), wantProxy{}},
		// 畸形：静默
		{"缺 mode 键（空输出）", "", wantProxy{malformed: true}},
		{"主机含空白", gsettingsVariant("proxy.https host '127.0.0.1'", "proxy.https host '"+leakMarker+" host'"),
			wantProxy{malformed: true}},
		{"端口越界", gsettingsVariant("proxy.https port 7890", "proxy.https port 70000"),
			wantProxy{malformed: true}},
		{"负端口", gsettingsVariant("proxy.https port 7890", "proxy.https port -1"),
			wantProxy{malformed: true}},
	}
	for _, c := range cases {
		assertDetect(t, c.name, gsettingsFixture(c.out), SystemProxySourceGnomeGsettings, c.want)
	}
}

// ── 编排：降级语义 ───────────────────────────────────────────────────────

// TestSystemProxyReaderErrorFallsThrough 读取失败（注册表打不开 / 命令缺失 / 非零
// 退出）：URL 空、错误原样供诊断、来源标识保留——调用方静默落下一档
func TestSystemProxyReaderErrorFallsThrough(t *testing.T) {
	readErr := errors.New("probe unavailable")
	run := func(context.Context) ([]byte, error) { return nil, readErr }
	for _, p := range []sysProxyProbe{
		winInetProbe(func() (winInetValues, error) { return winInetValues{}, readErr }),
		scutilProbe(run),
		gsettingsProbe(run),
	} {
		got, src, err := detectSystemProxyWith(context.Background(), p, time.Second)
		if got != "" || src != p.source || !errors.Is(err, readErr) {
			t.Errorf("%s: got (%q, %q, %v), want reader error fallthrough", p.source, got, src, err)
		}
	}
}

// TestDetectSystemProxyTimeoutFallsThrough 超时降级：读取器挂死且不理 ctx（同步
// 系统调用卡住形态）时到点即返回超时错误、URL 空，调用方不被拖住；尊重 ctx 的
// 读取器因到期失败（子进程被杀形态）同归超时口径；调用方 ctx 已取消立即返回
func TestDetectSystemProxyTimeoutFallsThrough(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	hung := sysProxyProbe{source: SystemProxySourceWindowsRegistry, probe: func(context.Context) (string, error) {
		<-release
		return "http://127.0.0.1:7890", nil
	}}

	start := time.Now()
	got, src, err := detectSystemProxyWith(context.Background(), hung, 50*time.Millisecond)
	if got != "" || src != SystemProxySourceWindowsRegistry || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("hung reader: got (%q, %q, %v), want deadline fallthrough", got, src, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("hung reader must not hold detection past the deadline, took %v", elapsed)
	}

	killed := sysProxyProbe{source: SystemProxySourceMacOSScutil, probe: func(ctx context.Context) (string, error) {
		<-ctx.Done()
		return "", errors.New("signal: killed")
	}}
	if got, _, err := detectSystemProxyWith(context.Background(), killed, 50*time.Millisecond); got != "" ||
		!errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ctx-killed reader: got (%q, %v), want deadline fallthrough", got, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, _, err := detectSystemProxyWith(ctx, hung, time.Minute); got != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled caller ctx: got (%q, %v), want canceled fallthrough", got, err)
	}
}

// TestDetectSystemProxyContainsPanic 读取器 panic（解析缺陷被畸形值触发）被收住转
// 错误，不传染主进程
func TestDetectSystemProxyContainsPanic(t *testing.T) {
	boom := sysProxyProbe{source: SystemProxySourceGnomeGsettings, probe: func(context.Context) (string, error) {
		panic("parser defect")
	}}
	got, src, err := detectSystemProxyWith(context.Background(), boom, time.Second)
	if got != "" || src != SystemProxySourceGnomeGsettings || err == nil {
		t.Fatalf("panicking reader: got (%q, %q, %v), want contained error", got, src, err)
	}
}

// TestDetectSystemProxyUnsupported 三平台外 GOOS 的空探测器：不支持错误，落下一档
func TestDetectSystemProxyUnsupported(t *testing.T) {
	got, src, err := detectSystemProxyWith(context.Background(), sysProxyProbe{}, time.Second)
	if got != "" || src != "" || !errors.Is(err, ErrSystemProxyUnsupported) {
		t.Fatalf("got (%q, %q, %v), want ErrSystemProxyUnsupported", got, src, err)
	}
}

// TestPlatformSysProxyProbeWiring 构建标签装配：本平台探测器来源与 GOOS 对应（只看
// 装配不调用读取器——不碰真实系统状态）
func TestPlatformSysProxyProbeWiring(t *testing.T) {
	want := map[string]string{
		"windows": SystemProxySourceWindowsRegistry,
		"darwin":  SystemProxySourceMacOSScutil,
		"linux":   SystemProxySourceGnomeGsettings,
	}[runtime.GOOS]
	p := platformSysProxyProbe()
	if p.source != want || (p.probe == nil) != (want == "") {
		t.Fatalf("GOOS %s probe = {source %q, probe set %v}, want source %q", runtime.GOOS, p.source, p.probe != nil, want)
	}
}

// ── 子进程执行路径 ───────────────────────────────────────────────────────

// sysProxyHelperEnv 子进程角色开关：测试二进制自身充当「查询命令」——打印夹具或
// 挂死，验证子进程执行路径（stdout 捕获 / ctx 到期杀进程）而不调真实 scutil/gsettings
const sysProxyHelperEnv = "SC_SYSPROXY_PROBE_HELPER"

// TestSysProxyProbeHelperProcess 子进程入口（常规测试运行时环境变量未设，空过）
func TestSysProxyProbeHelperProcess(t *testing.T) {
	switch os.Getenv(sysProxyHelperEnv) {
	case "print":
		fmt.Print(scutilClash)
		os.Exit(0)
	case "hang":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

// helperProbeCommand 以测试二进制作查询命令的执行器（角色经环境变量下发给子进程）
func helperProbeCommand(t *testing.T, role string) func(ctx context.Context) ([]byte, error) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("test binary path unavailable: %v", err)
	}
	t.Setenv(sysProxyHelperEnv, role)
	return func(ctx context.Context) ([]byte, error) {
		return runProbeCommand(ctx, exe, "-test.run=^TestSysProxyProbeHelperProcess$")
	}
}

// TestRunProbeCommand 子进程执行路径：stdout 原样捕获并贯通解析链；ctx 到期杀
// 子进程且编排按超时降级；命令缺失（无 gsettings 的服务器形态）返回错误落下一档
func TestRunProbeCommand(t *testing.T) {
	t.Run("stdout 贯通解析链", func(t *testing.T) {
		run := helperProbeCommand(t, "print")
		got, src, err := detectSystemProxyWith(context.Background(), scutilProbe(run), 30*time.Second)
		if err != nil || got != "http://127.0.0.1:7890" || src != SystemProxySourceMacOSScutil {
			t.Fatalf("got (%q, %q, %v), want http://127.0.0.1:7890 via scutil chain", got, src, err)
		}
	})
	t.Run("ctx 到期杀子进程", func(t *testing.T) {
		run := helperProbeCommand(t, "hang")
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		start := time.Now()
		if _, err := run(ctx); err == nil {
			t.Fatal("hung probe command must fail once ctx expires")
		}
		if elapsed := time.Since(start); elapsed > 10*time.Second {
			t.Fatalf("probe command must be killed promptly on ctx expiry, took %v", elapsed)
		}
	})
	t.Run("子进程挂死编排到点降级", func(t *testing.T) {
		run := helperProbeCommand(t, "hang")
		got, _, err := detectSystemProxyWith(context.Background(), gsettingsProbe(run), 300*time.Millisecond)
		if got != "" || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got (%q, %v), want deadline fallthrough", got, err)
		}
	})
	t.Run("命令缺失", func(t *testing.T) {
		if _, err := runProbeCommand(context.Background(), "sc-sysproxy-no-such-command"); err == nil {
			t.Fatal("missing probe command must return an error")
		}
	})
}
