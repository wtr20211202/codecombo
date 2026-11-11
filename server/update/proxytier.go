// 系统代理探测接入选路（P-20261110-1 S6）：开关 + 探测挂点 + 生效档位透出。
//
// 探测能力本身只有一处实现——S5 能力层 DetectSystemProxy（sysproxy.go，只读、2s
// 短超时、失败/畸形静默返回空）；本文件只负责「何时探测、结果放哪、怎么透出」：
//   - 何时：只在挂点探测——装配点（ApplySource：启动 Init + 设置保存）与更新尝试
//     边界（检查更新真出网取数前、受理后下载前、中心分发缓存下载前），一次尝试
//     探测一次；状态端点 ?refresh=1 同挂点语义。选路热路径（roundTripperFor，每个
//     重定向跳都进）只读快照绝不探测——GitHub 资产至少 302 两跳，逐跳 2s 超时会
//     叠加成下载卡顿。开关关 = 零探测（零子进程 / 零注册表读取）；
//   - 放哪：outbound 原子快照的探测字段（urlsafety.go outboundState），整体替换
//     Store、读侧 Load 现读，不引入新锁面（探测串行化锁只护探测本身，不在读侧）；
//   - 透出：CurrentProxyStatus → GET /api/updates/proxy-status，档位按更新目标
//     github.com 口径经 selectOutbound 裁决——与实际选路同一函数，显示不漂移；
//     任何代理地址回显前脱敏 userinfo。
package update

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// detectSystemProxyFn 探测入口取值口（默认 S5 能力层 DetectSystemProxy——唯一探测
// 实现，本层不另建）。独立变量仅为测试注入假探测器：单测断言不依赖、也不读取
// 宿主真实系统代理态
var detectSystemProxyFn = DetectSystemProxy

// detectMu 探测串行化：并发的挂点调用（设置保存 × 检查更新 × 状态端点刷新）不并发
// 起子进程/注册表读；排队者按取号代际合并（见下）。
// detectReqGen/detectDoneGen 排队合并的取号代际：每次挂点调用进入时取号，探测
// 落地时记完成号——完成号 ≥ 我的取号 = 有人比我晚进入且已探测完，本次合并复用。
// 刻意不用时间戳比较（低精度时钟上两次相邻 Now() 可相等，会把「探测刚做完」
// 误判成「晚于我发起」而漏探）
var (
	detectMu      sync.Mutex
	detectReqGen  atomic.Uint64
	detectDoneGen atomic.Uint64
)

// refreshSystemProxyDetection 探测挂点（只许装配点与更新尝试边界调用，禁止进
// roundTripperFor/RoundTrip 逐跳热路径）：
//   - 开关关（或出站态尚未装配）：立即返回，零探测；
//   - 开关开：同步探测一次（S5 层 2s 短超时兜底），结果整体替换快照。CAS 落盘——
//     探测期间快照被重新装配（设置保存）则丢弃本次结果：新装配自有挂点探测，旧
//     结果不得覆盖新态（尤其「探测途中开关被关」不能把结果写回去）；
//   - 失败/空 = 本档无代理（detected=nil），原因留 detectErr 供状态端点诊断，不冒泡；
//     调用方 ctx 在探测期间被取消则不落结果——取消不是系统代理态的证据，保留旧快照；
//   - 合并：排队等锁期间若已有一次「取号晚于本次」的探测落地，直接复用——
//     多标签页同时刷新状态之类的并发不放大成 N 次探测。
func refreshSystemProxyDetection(ctx context.Context) {
	gen := detectReqGen.Add(1)
	detectMu.Lock()
	defer detectMu.Unlock()

	st := outbound.Load()
	if st == nil || !st.autoDetect {
		return
	}
	if detectDoneGen.Load() >= gen {
		return // 等锁期间已有更晚取号的探测落地
	}

	startedAt := time.Now()
	raw, source, err := detectSystemProxyFn(ctx)
	if ctx.Err() != nil {
		return
	}
	next := *st
	next.detected, next.detectedSource, next.detectedAt, next.detectErr = nil, source, startedAt, ""
	switch {
	case err != nil:
		// S5 层错误文本不回显原始配置值（可能内嵌凭据），可直接留作诊断
		next.detectErr = err.Error()
	case raw != "":
		if u, perr := parseProxyURL(raw); perr == nil {
			next.detected = u
		} else {
			// 能力层承诺结果已过同规校验，走到这里只可能是实现漂移——按畸形处置，
			// 不回显原值
			next.detectErr = ErrSystemProxyMalformed.Error()
		}
	}
	if !outbound.CompareAndSwap(st, &next) {
		return
	}
	detectDoneGen.Store(gen)
	prev, cur := redactProxyURL(st.detected), redactProxyURL(next.detected)
	switch {
	case prev == cur:
		slog.Debug("update: system proxy detection unchanged", "proxy", cur, "source", source)
	case cur != "":
		slog.Info("update: system proxy detected — used when neither updateProxy nor proxy env vars apply",
			"proxy", cur, "source", source)
	default:
		slog.Info("update: system proxy no longer detected", "source", source, "err", next.detectErr)
	}
}

// ProxyStatus 更新链出站档位快照（GET /api/updates/proxy-status 的 data 载荷）。
// 字段恒在场（空串/false = 无），agent 编程消费免判 null
type ProxyStatus struct {
	// Tier 对 Target 生效的出站档位：explicit / env / sysdetect / direct
	Tier string `json:"tier"`
	// Target 档位裁决口径的更新目标 host（官方更新源 github.com）
	Target string `json:"target"`
	// Proxy 生效代理地址（userinfo 脱敏）；direct 档为空
	Proxy string `json:"proxy"`
	// AutoDetect 系统代理探测开关（settings.updateProxyAutoDetect 的已装配值）
	AutoDetect bool `json:"autoDetect"`
	// DetectedProxy 最近一次探测到的系统代理（userinfo 脱敏）；未探测/未启用/
	// 探测失败为空。显式或 env 档优先时它不生效，仍如实回显供排障
	DetectedProxy string `json:"detectedProxy"`
	// DetectedSource 探测机制（windows-registry / macos-scutil / gnome-gsettings）；
	// 未探测为空
	DetectedSource string `json:"detectedSource"`
	// DetectedAt 最近一次探测发起时刻（RFC3339 UTC）；未探测为空
	DetectedAt string `json:"detectedAt"`
	// DetectError 最近一次探测失败原因（诊断用，不含原始配置值）；成功/未探测为空
	DetectError string `json:"detectError"`
	// NoProxyMatch Target 命中 NO_PROXY（探测档对其让位直连；env 档同样不代理）
	NoProxyMatch bool `json:"noProxyMatch"`
}

// proxyStatusTarget 档位裁决口径目标：官方更新链起点 github.com（资产下载自此
// 302 至 githubusercontent 域，同走白名单代理档）
var proxyStatusTarget = &url.URL{Scheme: "https", Host: "github.com", Path: "/"}

// CurrentProxyStatus 当前出站档位只读快照。refresh=true 时先按挂点语义即时探测
// 一次（写快照，开关关仍零探测）；档位经 selectOutbound 与实际选路同源裁决
func CurrentProxyStatus(ctx context.Context, refresh bool) ProxyStatus {
	if refresh {
		refreshSystemProxyDetection(ctx)
	}
	out := ProxyStatus{Tier: ProxyTierDirect, Target: proxyStatusTarget.Hostname()}
	// https 目标下 ProxyFromEnvironment 不会报错（CGI 拒绝只针对 http 目标）；
	// 防御性兜底：报错即按直连回显，不让状态端点 500
	if tier, p, err := selectOutbound(proxyStatusTarget); err == nil {
		out.Tier, out.Proxy = tier, redactProxyURL(p)
	}
	if st := outbound.Load(); st != nil {
		out.AutoDetect = st.autoDetect
		out.DetectedProxy = redactProxyURL(st.detected)
		out.DetectedSource = st.detectedSource
		if !st.detectedAt.IsZero() {
			out.DetectedAt = st.detectedAt.UTC().Format(time.RFC3339)
		}
		out.DetectError = st.detectErr
	}
	out.NoProxyMatch = noProxyMatchFor(proxyStatusTarget)
	return out
}

// redactProxyURL 代理地址回显形态：userinfo（user:pass@ / user@）一律脱敏为 ***@
// ——显式设置、环境变量、系统探测三个来源同口径（代理串可能内嵌凭据，状态端点
// 不得成为新的凭据展示面）。nil = 空串
func redactProxyURL(u *url.URL) string {
	if u == nil {
		return ""
	}
	if u.User == nil {
		return u.String()
	}
	c := *u
	c.User = nil
	s := c.String()
	if prefix := c.Scheme + "://"; c.Scheme != "" && strings.HasPrefix(s, prefix) {
		return prefix + "***@" + s[len(prefix):]
	}
	return "***@" + c.Host
}

// SetProxyProbeHooksForTest 替换系统代理探测 / 环境变量代理 / NO_PROXY 三个取值口
// （detect、envProxy 传 nil 即保持生产实现；noProxy 为 NO_PROXY 串），返回还原函数
// （连同出站快照一并复原）。仅供测试使用：跨包单测（api 层设置与状态端点）注入
// 假探测器与假 env——本机开发环境常开着系统代理/代理环境变量，断言绝不能依赖
// 宿主代理态（git.SetMergeTreeProbeForTest 同款测试辅助注记）
func SetProxyProbeHooksForTest(
	detect func(ctx context.Context) (proxyURL, source string, err error),
	envProxy func(*url.URL) (*url.URL, error),
	noProxy string,
) (restore func()) {
	prevDetect, prevEnv, prevNoProxy, prevState := detectSystemProxyFn, envProxyFor, noProxyMatchFor, outbound.Load()
	if detect != nil {
		detectSystemProxyFn = detect
	}
	if envProxy != nil {
		envProxyFor = envProxy
	}
	l := parseNoProxy(noProxy)
	noProxyMatchFor = l.match
	return func() {
		detectSystemProxyFn, envProxyFor, noProxyMatchFor = prevDetect, prevEnv, prevNoProxy
		outbound.Store(prevState)
	}
}
