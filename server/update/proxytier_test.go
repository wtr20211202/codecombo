package update

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
)

// ── S6 系统代理探测接入（proxytier.go / noproxy.go）单测 ────────────────────
//
// 全部经 SetProxyProbeHooksForTest / resetOutboundForTest 注入假探测器与假 env，
// 零读取、零改动宿主真实系统代理态（开发机常开着 localhost 系统代理，任何断言
// 不得依赖它）。装配链会真跑探测，故注入必须先于 ApplySource。

// detectCounter 假探测器：返回固定值并记录调用次数
type detectCounter struct {
	calls  int
	proxy  string
	source string
	err    error
}

func (d *detectCounter) probe(context.Context) (string, string, error) {
	d.calls++
	return d.proxy, d.source, d.err
}

// sysdetectState 装配「开关开 + 探测到 detectedProxy」出站态（真实 ApplySource→
// 装配点探测全链），返回计数器。前置条件：调用方已注入 env/NO_PROXY 钩子并经
// resetOutboundForTest/SetProxyProbeHooksForTest 登记回滚——本助手只替换探测器，
// 不覆盖调用方钩子（探测注入用包内直赋值，回滚归 resetOutboundForTest）
func sysdetectState(t *testing.T, detectedProxy string) *detectCounter {
	t.Helper()
	d := &detectCounter{proxy: detectedProxy, source: SystemProxySourceWindowsRegistry}
	detectSystemProxyFn = d.probe
	ApplySource(&config.Config{Server: config.ServerConfig{UpdateProxyAutoDetect: true}})
	if d.calls == 0 {
		t.Fatal("ApplySource with autoDetect on must probe once at the assembly point")
	}
	return d
}

// TestTierPriorityAllCombos ①四档优先级全组合：显式 > env > 系统探测（开）> 直连；
// NO_PROXY 命中让探测档让位直连（显式档不解读 NO_PROXY，不受影响）；开关关探测档
// 不存在
func TestTierPriorityAllCombos(t *testing.T) {
	target := mustParseRaw(t, "https://github.com/some/repo")
	envProxy := mustParseRaw(t, "http://env.example:3128")
	explicit := "http://explicit.example:8080"

	type fixture struct {
		explicit string
		env      bool
		detect   bool // 开关开 + 探测到
		noProxy  bool // 目标命中 NO_PROXY
	}
	cases := []struct {
		name string
		f    fixture
		want string
	}{
		{"explicit wins over env+detect", fixture{explicit: explicit, env: true, detect: true}, ProxyTierExplicit},
		{"explicit alone", fixture{explicit: explicit}, ProxyTierExplicit},
		{"explicit ignores NO_PROXY", fixture{explicit: explicit, detect: true, noProxy: true}, ProxyTierExplicit},
		{"env wins over detect", fixture{env: true, detect: true}, ProxyTierEnv},
		{"env under NO_PROXY list (env 层语义在其探询口内部)", fixture{env: true, detect: true, noProxy: true}, ProxyTierEnv},
		{"sysdetect", fixture{detect: true}, ProxyTierSysDetect},
		{"sysdetect yields to NO_PROXY", fixture{detect: true, noProxy: true}, ProxyTierDirect},
		{"nothing = direct", fixture{}, ProxyTierDirect},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resetOutboundForTest(t)
			d := &detectCounter{proxy: "http://sys.example:7890", source: "windows-registry"}
			restore := SetProxyProbeHooksForTest(d.probe, func(*url.URL) (*url.URL, error) {
				if c.f.env {
					return envProxy, nil
				}
				return nil, nil
			}, map[bool]string{false: "", true: "github.com"}[c.f.noProxy])
			t.Cleanup(restore)
			if err := SetOutbound(c.f.explicit, "", c.f.detect); err != nil {
				t.Fatal(err)
			}
			if c.f.detect {
				refreshSystemProxyDetection(context.Background())
				if d.calls != 1 {
					t.Fatalf("detect calls = %d, want 1", d.calls)
				}
			}
			tier, p, err := selectOutbound(target)
			if err != nil {
				t.Fatalf("selectOutbound: %v", err)
			}
			if tier != c.want {
				t.Fatalf("tier = %q, want %q", tier, c.want)
			}
			switch tier {
			case ProxyTierExplicit:
				if p.String() != explicit {
					t.Fatalf("proxy = %q, want explicit %q", p, explicit)
				}
			case ProxyTierEnv:
				if p != envProxy {
					t.Fatalf("proxy = %q, want env %q", p, envProxy)
				}
			case ProxyTierSysDetect:
				if p == nil || p.Host != "sys.example:7890" {
					t.Fatalf("proxy = %v, want detected sys.example:7890", p)
				}
			case ProxyTierDirect:
				if p != nil {
					t.Fatalf("direct tier must have no proxy, got %q", p)
				}
			}
		})
	}
}

// TestAutoDetectOffZeroProbeAndLegacyParity ②开关关：装配与挂点刷新均零探测调用，
// 出站态无探测结果——选路退化为 09-12 三态原语义（直连/env 逐字节同现状）
func TestAutoDetectOffZeroProbeAndLegacyParity(t *testing.T) {
	resetOutboundForTest(t)
	d := &detectCounter{proxy: "http://sys.example:7890"}
	restore := SetProxyProbeHooksForTest(d.probe, func(*url.URL) (*url.URL, error) { return nil, nil }, "")
	t.Cleanup(restore)

	// 装配点：开关关零探测
	ApplySource(&config.Config{Server: config.ServerConfig{UpdateProxyAutoDetect: false}})
	if d.calls != 0 {
		t.Fatalf("detect calls with switch off = %d, want 0", d.calls)
	}
	st := outbound.Load()
	if st == nil || st.autoDetect || st.detected != nil {
		t.Fatalf("switch-off state must have no detect wiring, got %+v", st)
	}

	// 挂点直调同样零探测（防御性：挂点自身判开关）
	refreshSystemProxyDetection(context.Background())
	if d.calls != 0 {
		t.Fatalf("refresh with switch off must not probe, got %d calls", d.calls)
	}

	// 行为同现状：无显式无 env = 直连档；env 命中 = env 档（探测字段不参与）
	rt, err := roundTripperFor(mustParseRaw(t, "https://github.com/x"))
	if err != nil || rt != http.RoundTripper(directTransport) {
		t.Fatalf("switch-off selection must equal legacy direct, got %v (%v)", rt, err)
	}
	envProxy := mustParseRaw(t, "http://env.example:3128")
	envProxyFor = func(*url.URL) (*url.URL, error) { return envProxy, nil }
	rt, err = roundTripperFor(mustParseRaw(t, "https://github.com/x"))
	if err != nil || rt != proxyTransportFor(envProxy) {
		t.Fatalf("switch-off env selection must equal legacy env tier, got %v (%v)", rt, err)
	}
}

// TestNOProxySkipsSysdetectOnly ③NO_PROXY 命中跳过探测档（探测档尊重 NO_PROXY，
// 显式档不解读——两档立场差异的选路级钉死）。NO_PROXY 条目取 release-assets 域，
// 避免 github.com 的子域语义（foo.com 匹配 bar.foo.com）顺带覆盖 api.github.com
func TestNOProxySkipsSysdetectOnly(t *testing.T) {
	resetOutboundForTest(t)
	restore := SetProxyProbeHooksForTest(nil, func(*url.URL) (*url.URL, error) { return nil, nil },
		"release-assets.githubusercontent.com")
	t.Cleanup(restore)
	sysdetectState(t, "http://sys.example:7890")

	// 命中 NO_PROXY 的官方域：探测档让位，直连（IP 守卫档）
	rt, err := roundTripperFor(mustParseRaw(t, "https://release-assets.githubusercontent.com/y"))
	if err != nil || rt != http.RoundTripper(directTransport) {
		t.Fatalf("NO_PROXY hit must send sysdetect target direct, got %v (%v)", rt, err)
	}
	// 未命中的官方域：探测档照常
	sysProxy := mustParseRaw(t, "http://sys.example:7890")
	rt, err = roundTripperFor(mustParseRaw(t, "https://api.github.com/repos/o/r"))
	if err != nil {
		t.Fatalf("non-NO_PROXY target under sysdetect: %v", err)
	}
	if rt != proxyTransportFor(sysProxy) {
		t.Fatal("non-NO_PROXY target must use detected proxy transport")
	}
	// 显式档不解读 NO_PROXY：同一命中目标仍走显式代理
	if err := SetOutbound("http://explicit.example:8080", "", true); err != nil {
		t.Fatal(err)
	}
	rt, err = roundTripperFor(mustParseRaw(t, "https://github.com/x"))
	if err != nil {
		t.Fatalf("explicit tier must ignore NO_PROXY: %v", err)
	}
	if rt != proxyTransportFor(mustParseRaw(t, "http://explicit.example:8080")) {
		t.Fatal("explicit tier must use explicit proxy even under NO_PROXY hit")
	}
}

// TestHotPathZeroDetection ④跨重定向链探测调用次数不随跳数增长：模拟 GitHub 资产
// 下载的真实跳链逐跳选路（roundTripperFor 每跳进一次），探测只在挂点发生过一次，
// 热路径零探测
func TestHotPathZeroDetection(t *testing.T) {
	resetOutboundForTest(t)
	d := sysdetectState(t, "http://sys.example:7890")
	before := d.calls

	// GitHub 更新链典型跳序：API 取数 → 资产 302 链（≥2 跳）→ 重定向回已选过档
	// 的域——跳数无论多少，选路只读快照
	hops := []string{
		"https://api.github.com/repos/o/r/releases/latest",
		"https://github.com/o/r/releases/download/v1/a",
		"https://objects.githubusercontent.com/x",
		"https://release-assets.githubusercontent.com/y",
		"https://api.github.com/repos/o/r/releases/latest",
	}
	for i, hop := range hops {
		if _, err := roundTripperFor(mustParseRaw(t, hop)); err != nil {
			t.Fatalf("hop %d %s: %v", i, hop, err)
		}
	}
	if d.calls != before {
		t.Fatalf("detection calls grew on hot path: %d → %d across %d hops", before, d.calls, len(hops))
	}
}

// TestSysdetectTierWhitelistGuard ⑤探测档与显式/env 档同一安全口径：官方域白名单
// （∪ 显式配置的更新源 host）+ 仅 https
func TestSysdetectTierWhitelistGuard(t *testing.T) {
	resetOutboundForTest(t)
	restore := SetProxyProbeHooksForTest(nil, func(*url.URL) (*url.URL, error) { return nil, nil }, "")
	t.Cleanup(restore)
	sysdetectState(t, "http://sys.example:7890")

	// 非官方域：白名单拒（探测档不得放宽信任面）
	if _, err := roundTripperFor(mustParseRaw(t, "https://mirror.example.com/x")); err == nil ||
		!strings.Contains(err.Error(), "not an official trusted domain") {
		t.Fatalf("sysdetect tier must enforce official-domain whitelist, got %v", err)
	}
	// 明文 http 目标：代理档仅 https
	if _, err := roundTripperFor(mustParseRaw(t, "http://github.com/x")); err == nil ||
		!strings.Contains(err.Error(), "must use https") {
		t.Fatalf("sysdetect tier must reject http targets, got %v", err)
	}
	// 官方域全放行
	for _, ok := range []string{
		"https://github.com/o/r/releases/download/v1/a",
		"https://www.github.com/o/r",
		"https://api.github.com/repos/o/r",
		"https://objects.githubusercontent.com/x",
		"https://release-assets.githubusercontent.com/y",
	} {
		if _, err := roundTripperFor(mustParseRaw(t, ok)); err != nil {
			t.Fatalf("official domain %s must pass sysdetect whitelist: %v", ok, err)
		}
	}
	// 显式配置的更新源 host 进白名单（自建镜像不被官方域白名单误伤）
	if err := SetOutbound("", "gitea.example.com", true); err != nil {
		t.Fatal(err)
	}
	refreshSystemProxyDetection(context.Background())
	if _, err := roundTripperFor(mustParseRaw(t, "https://gitea.example.com/o/r/releases/latest")); err != nil {
		t.Fatalf("configured source host must pass sysdetect whitelist: %v", err)
	}
}

// TestRefreshDetectionLifecycle 探测挂点生命周期：失败/空 = 本档无代理不冒泡；
// 晚于请求发起的探测落地则排队者合并；探测途中重新装配则结果按 CAS 丢弃（旧结果
// 不得覆盖新态，尤其探测途中开关被关不能把结果写回去）；取消中的尝试不动快照
func TestRefreshDetectionLifecycle(t *testing.T) {
	newState := func(t *testing.T, d *detectCounter) {
		t.Helper()
		restore := SetProxyProbeHooksForTest(d.probe, func(*url.URL) (*url.URL, error) { return nil, nil }, "")
		t.Cleanup(restore)
		ApplySource(&config.Config{Server: config.ServerConfig{UpdateProxyAutoDetect: true}})
	}

	t.Run("failure and empty degrade silently", func(t *testing.T) {
		resetOutboundForTest(t)
		newState(t, &detectCounter{}) // 装配点探测：未配置（空结果）

		d := &detectCounter{err: errors.New("boom")}
		detectSystemProxyFn = d.probe
		refreshSystemProxyDetection(context.Background())
		if st := outbound.Load(); st.detected != nil || st.detectErr == "" {
			t.Fatalf("failed probe must leave no detected proxy with diagnose err, got %+v", st)
		}

		d = &detectCounter{} // 系统未启用静态代理（proxyURL 空、err nil）
		detectSystemProxyFn = d.probe
		refreshSystemProxyDetection(context.Background())
		if st := outbound.Load(); st.detected != nil || st.detectErr != "" {
			t.Fatalf("empty probe must be a clean no-proxy, got %+v", st)
		}
	})

	t.Run("probe newer than request merges queued callers", func(t *testing.T) {
		resetOutboundForTest(t)
		newState(t, &detectCounter{proxy: "http://sys.example:7890"})
		// 模拟「一次取号晚于本次的探测已落地」（真实并发中：排队等锁期间他人探测
		// 完成）——完成号置满，任何后续取号都应合并复用而非再探测
		prevDone := detectDoneGen.Load()
		detectDoneGen.Store(math.MaxUint64)
		t.Cleanup(func() { detectDoneGen.Store(prevDone) })

		d := &detectCounter{proxy: "http://sys.example:7890"}
		detectSystemProxyFn = d.probe
		refreshSystemProxyDetection(context.Background())
		if d.calls != 0 {
			t.Fatalf("refresh older than finished probe must merge, calls=%d", d.calls)
		}
	})

	t.Run("reassembled mid-flight state discards stale result", func(t *testing.T) {
		resetOutboundForTest(t)
		newState(t, &detectCounter{proxy: "http://sys.example:7890"})

		// 探测器返回前把出站态换成「开关关」（设置保存竞态形态）
		d := &detectCounter{proxy: "http://sys.example:7890"}
		detectSystemProxyFn = func(ctx context.Context) (string, string, error) {
			proxyURL, source, err := d.probe(ctx)
			_ = SetOutbound("", "github.com", false) // 新装配：开关关
			return proxyURL, source, err
		}
		refreshSystemProxyDetection(context.Background())
		st := outbound.Load()
		if st.autoDetect || st.detected != nil {
			t.Fatalf("stale probe result must be discarded after re-assembly, got %+v", st)
		}
	})

	t.Run("cancelled context keeps previous snapshot", func(t *testing.T) {
		resetOutboundForTest(t)
		newState(t, &detectCounter{proxy: "http://sys.example:7890"})
		good := outbound.Load()

		// 取消中的尝试（更新请求被放弃）：探测结果不是系统代理态的证据，不落
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		detectSystemProxyFn = func(context.Context) (string, string, error) { return "", "", nil }
		refreshSystemProxyDetection(ctx)
		if st := outbound.Load(); st != good {
			t.Fatalf("cancelled refresh must keep previous snapshot, got %+v", st)
		}
	})
}

// TestApplySourceAutoDetectWiring ApplySource 装配探测开关：开=装配点探测一次并把
// 结果写进出站态；关=清探测结果；开灯重装配重新探测；非法显式代理回退仍带开关态
func TestApplySourceAutoDetectWiring(t *testing.T) {
	resetOutboundForTest(t)
	d := &detectCounter{proxy: "socks5://127.0.0.1:7891", source: SystemProxySourceWindowsRegistry}
	restore := SetProxyProbeHooksForTest(d.probe, func(*url.URL) (*url.URL, error) { return nil, nil }, "")
	t.Cleanup(restore)

	cfg := &config.Config{Server: config.ServerConfig{UpdateProxyAutoDetect: true}}
	ApplySource(cfg)
	st := outbound.Load()
	if st == nil || !st.autoDetect || st.detected == nil || st.detected.Host != "127.0.0.1:7891" {
		t.Fatalf("ApplySource(autoDetect) must probe and wire result, got %+v", st)
	}
	if st.detectedSource != SystemProxySourceWindowsRegistry || st.detectedAt.IsZero() {
		t.Fatalf("detection metadata missing, got %+v", st)
	}
	first := d.calls

	// 关灯重装配：探测字段清空（探测档不存在），零探测
	ApplySource(&config.Config{})
	if st := outbound.Load(); st.autoDetect || st.detected != nil {
		t.Fatalf("switch-off reassembly must clear detection, got %+v", st)
	}

	// 开灯重装配：新探测一次（不沿用关灯期间的空结果）
	ApplySource(cfg)
	if d.calls != first+1 {
		t.Fatalf("switch-on reassembly must re-probe once, calls %d → %d", first, d.calls)
	}

	// 非法显式代理：回退直连态但开关态保留（探测档仍在低优先级待命）
	ApplySource(&config.Config{Server: config.ServerConfig{
		UpdateProxy:           "ftp://bad",
		UpdateProxyAutoDetect: true,
	}})
	st = outbound.Load()
	if st == nil || st.proxy != nil || !st.autoDetect {
		t.Fatalf("invalid explicit proxy must fall back but keep detect switch, got %+v", st)
	}
}

// TestCurrentProxyStatusRedaction ⑥proxy-status 载荷：档位与实际选路同源、代理
// 地址回显一律脱敏 userinfo（显式/env/探测三来源同口径）、探测元数据齐备、
// refresh=true 走挂点语义（开关开探测一次、开关关零探测）
func TestCurrentProxyStatusRedaction(t *testing.T) {
	resetOutboundForTest(t)
	restore := SetProxyProbeHooksForTest(nil, func(*url.URL) (*url.URL, error) { return nil, nil }, "")
	t.Cleanup(restore)

	// 显式档 + 带凭据的探测结果
	if err := SetOutbound("socks5://user:pass@proxy.example:3128", "github.com", true); err != nil {
		t.Fatal(err)
	}
	d := &detectCounter{proxy: "http://u:p@127.0.0.1:7890", source: SystemProxySourceMacOSScutil}
	detectSystemProxyFn = d.probe
	refreshSystemProxyDetection(context.Background())

	st := CurrentProxyStatus(context.Background(), false)
	if st.Tier != ProxyTierExplicit {
		t.Fatalf("tier = %q, want explicit", st.Tier)
	}
	if st.Proxy != "socks5://***@proxy.example:3128" {
		t.Fatalf("explicit proxy echo = %q, want redacted userinfo", st.Proxy)
	}
	if st.DetectedProxy != "http://***@127.0.0.1:7890" {
		t.Fatalf("detected proxy echo = %q, want redacted userinfo", st.DetectedProxy)
	}
	if !st.AutoDetect || st.DetectedSource != SystemProxySourceMacOSScutil {
		t.Fatalf("autoDetect/source = %v/%q, want true + scutil marker", st.AutoDetect, st.DetectedSource)
	}
	if st.Target != "github.com" {
		t.Fatalf("target = %q, want github.com", st.Target)
	}
	if at, err := time.Parse(time.RFC3339, st.DetectedAt); err != nil || at.IsZero() {
		t.Fatalf("detectedAt = %q, want RFC3339", st.DetectedAt)
	}
	if st.DetectError != "" || st.NoProxyMatch {
		t.Fatalf("clean detect must have no error/no NO_PROXY hit, got %+v", st)
	}

	// env 档（带凭据的 env 代理）+ 探测失败诊断
	envProxy := mustParseRaw(t, "http://envuser:envpass@env.example:8080")
	envProxyFor = func(*url.URL) (*url.URL, error) { return envProxy, nil }
	if err := SetOutbound("", "github.com", true); err != nil {
		t.Fatal(err)
	}
	d = &detectCounter{err: errors.New("registry read failed")}
	detectSystemProxyFn = d.probe
	refreshSystemProxyDetection(context.Background())
	st = CurrentProxyStatus(context.Background(), false)
	if st.Tier != ProxyTierEnv {
		t.Fatalf("tier = %q, want env", st.Tier)
	}
	if st.Proxy != "http://***@env.example:8080" {
		t.Fatalf("env proxy echo = %q, want redacted userinfo", st.Proxy)
	}
	if st.DetectedProxy != "" || st.DetectError == "" {
		t.Fatalf("failed detect must echo empty proxy + diagnose err, got %+v", st)
	}

	// 直连档 + 未探测（开关关）：探测字段全空（env 探询口复位为无代理）
	envProxyFor = func(*url.URL) (*url.URL, error) { return nil, nil }
	if err := SetOutbound("", "github.com", false); err != nil {
		t.Fatal(err)
	}
	st = CurrentProxyStatus(context.Background(), false)
	if st.Tier != ProxyTierDirect || st.Proxy != "" || st.AutoDetect ||
		st.DetectedProxy != "" || st.DetectedSource != "" || st.DetectedAt != "" {
		t.Fatalf("switch-off status must be direct with empty detect fields, got %+v", st)
	}

	// refresh=true：开关开时按挂点语义即时探测一次并反映最新档位
	d = &detectCounter{proxy: "http://sys.example:7890"}
	detectSystemProxyFn = d.probe
	_ = SetOutbound("", "github.com", true)
	st = CurrentProxyStatus(context.Background(), true)
	if d.calls != 1 || st.Tier != ProxyTierSysDetect || st.DetectedProxy != "http://sys.example:7890" {
		t.Fatalf("refresh=true must probe once and report sysdetect, calls=%d tier=%q detected=%q",
			d.calls, st.Tier, st.DetectedProxy)
	}
	// 开关关：refresh 仍零探测
	if err := SetOutbound("", "github.com", false); err != nil {
		t.Fatal(err)
	}
	CurrentProxyStatus(context.Background(), true)
	if d.calls != 1 {
		t.Fatalf("refresh with switch off must not probe, calls=%d", d.calls)
	}
}

// TestRedactProxyURLForms 脱敏形态表：user:pass@ / user@ / 无 userinfo / nil
func TestRedactProxyURLForms(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://user:pass@h:8080", "http://***@h:8080"},
		{"socks5://user@h:1080", "socks5://***@h:1080"},
		{"http://h:8080", "http://h:8080"},
	}
	for _, c := range cases {
		if got := redactProxyURL(mustParseRaw(t, c.in)); got != c.want {
			t.Errorf("redact(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := redactProxyURL(nil); got != "" {
		t.Errorf("redact(nil) = %q, want empty", got)
	}
}
