package platforms

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/git/auth"
)

// setProbeClientTransport 临时替换 probeClient 的 Transport，返回 restore 函数
//
// 仅测试用——生产代码不应调用
//
// 用途：让 Match 内的 Probe 走 httptest.NewTLSServer 启动的测试 server，
// 通过注入 server 的 TLS transport 让 https://host 请求被路由到 mock
func setProbeClientTransport(rt http.RoundTripper) func() {
	orig := probeClient.Transport
	probeClient.Transport = rt
	return func() { probeClient.Transport = orig }
}

// PlatformRegistry 静态注册表：按顺序遍历，命中即返回
// 注意：GenericAdapter 不在此处——它的 MatchHost 永远返回 true，
// 若放入本表会让所有 host 在此命中，导致 Probe 兜底与 Generic 兜底成为死代码。
// GenericAdapter 仅在 Match() 末尾作为最终兜底显式返回。
var PlatformRegistry = []auth.PlatformAdapter{
	&GitHubAdapter{},
	&GitLabAdapter{},
	&GiteaAdapter{},
	&GiteeAdapter{},
}

// ProbeRegistry 探测兜底：静态注册表 miss 后调用
// 仅注册支持 Probe 的 adapter
var ProbeRegistry = []auth.PlatformProber{
	&GiteaAdapter{},
	&GitLabAdapter{},
}

var registryMu sync.RWMutex

// RegisterPlatform 追加注册一个平台适配器（扩展点：新增 git 托管平台
// 不再需要修改本文件的静态 slice，实现 PlatformAdapter 后调用即可）。
// 追加到静态表尾部——内置四平台的命中优先级保持不变
func RegisterPlatform(a auth.PlatformAdapter) {
	registryMu.Lock()
	defer registryMu.Unlock()
	PlatformRegistry = append(PlatformRegistry, a)
}

// RegisterProbe 追加注册一个探测兜底 adapter（需同时实现 PlatformProber）
func RegisterProbe(p auth.PlatformProber) {
	registryMu.Lock()
	defer registryMu.Unlock()
	ProbeRegistry = append(ProbeRegistry, p)
}

// registrySnapshot 返回两表的快照（注册表读路径统一走锁，
// 保证运行期注册对 Match/MatchStatic 立即可见且无数据竞争）
func registrySnapshot() ([]auth.PlatformAdapter, []auth.PlatformProber) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return PlatformRegistry, ProbeRegistry
}

// probeTimeout Probe 阶段的总超时
//
// 平台不可达时单次 Probe 可能挂 30s+（http.DefaultClient 无 Timeout），
// 串行执行会让 Match 整体延迟至 60s。并发 + 5s 超时把上限压到 5s
const probeTimeout = 5 * time.Second

// MatchStatic 仅遍历静态注册表（不触发 Probe），用于已知 host 的快速 platform 分类
//
// 区别于 Match：Match 在静态未命中时会并发 Probe（5s 超时），适合首次 clone 等需要精准识别的场景；
// MatchStatic 永远 O(n) 同步返回，适合保存凭据等高频写入路径——只关心已知平台 tag，未知 host 走 generic
func MatchStatic(host string) auth.PlatformAdapter {
	registry, _ := registrySnapshot()
	for _, a := range registry {
		if a.MatchHost(host) {
			return a
		}
	}
	return &GenericAdapter{}
}

// Match 静态优先 → Probe 并发兜底 → GenericAdapter
//
// Probe 改并发的原因：自建平台 host 探测时（如目标真是 GitLab 但 Gitea Probe 先跑），
// 串行会让 Gitea Probe 的 30s timeout 阻塞 GitLab Probe，整体延迟不可控
//
// 实现细节：
//   - 第一命中即返回（CAS 抢占），其他 goroutine 继续跑完但不影响结果
//   - ctx 5s 超时兜底，所有 Probe 都失败后等 wg 收尾再返 Generic
//   - 选用 atomic.Value + WaitGroup 而非 errgroup：errgroup 是间接依赖，避免改 go.mod
func Match(ctx context.Context, host string) auth.PlatformAdapter {
	// 1. 静态注册表（命中即返回，不进 Probe 路径）
	registry, probes := registrySnapshot()
	for _, a := range registry {
		if a.MatchHost(host) {
			return a
		}
	}

	// 2. Probe 并发兜底（5s 超时）
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	baseURL := "https://" + host
	var matched atomic.Value // 存 auth.PlatformAdapter
	var wg sync.WaitGroup
	for _, p := range probes {
		wg.Add(1)
		go func(p auth.PlatformProber) {
			defer wg.Done()
			ok, err := p.Probe(probeCtx, baseURL)
			if err != nil {
				slog.Warn("platform probe failed", "host", host, "err", err)
				return
			}
			if ok {
				// 反查 adapter（ProbeRegistry 元素本身是 adapter）
				// CAS：首个命中的 adapter 写入，后续被忽略
				if a, ok := p.(auth.PlatformAdapter); ok {
					matched.CompareAndSwap(nil, a)
				}
			}
		}(p)
	}
	wg.Wait()

	// 3. 命中 Probe 的 adapter；否则显式返回 GenericAdapter
	if a := matched.Load(); a != nil {
		return a.(auth.PlatformAdapter)
	}
	return &GenericAdapter{}
}
