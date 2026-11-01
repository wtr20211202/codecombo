package git

// 全局 git 子进程并发上限（P-20261004-125）：8 并行 agent × 各自的面板刷新/
// 搜索/状态轮询可叠加出数十个并发 git 进程（Windows 进程创建贵、大仓 git 单
// 进程吃内存），弱机自托管形态的进程风暴面；git 自身 index.lock 只护写写冲突
// 不护进程总量。本文件给 execGit 家族的进程启动点挂一道全局计数信号量：起
// 进程前必须取得槽位，超出上限的调用方在 chan 上排队。读写共池起步（治理
// 总量优先于精细分池）——P-78 写队列在更上层管 per-repo 写互斥，本条兜底
// 全局总量；与 P-124 搜索频率限流构成 git 面「频率×并发×串行」三层防线。
//
// 死锁审查（调用图注记，改代码须复核）：槽位作用域 = 各启动点 runWithTimeout
// 一段的进程生命周期（execGitStreaming 为整个流式克隆），临界区内只有进程
// 启动/等待/整组清理，不回调任何 execGit*/runWithTimeout——「信号量内不得
// 嵌套 execGit」由构造保证。与 P-78 写队列的取锁顺序恒为「写槽位 → 全局
// 槽位」（写队列在汇流点先取），不存在反向路径，无环。abortRebaseInSlot 的
// 裸 exec 豁免（恢复路径不排队，理由见其注释）。
//
// 指标：sc_git_running（当前占用槽位的并发进程数）/ sc_git_waiting（排队
// 等待数）/ sc_git_waiting_peak（进程内峰值——上限标定的实测依据）/
// sc_git_gate_timeouts_total（排队超时失败数）。经 GET /api/metrics 出口；
// 前三项另由健康摘要 GET /api/system/health 直取（值班大屏健康卡族）。

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"codecombo/server/errmarkers"
	"codecombo/server/metrics"
)

// GitGateBusyMarker 错误原文中的稳定英文标记：全局并发门排队超时（命令未
// 执行）时随错误返回，前端 http.ts KNOWN_ERROR_I18N 按此子串映射本地化文案
// （对齐 GitWriteBusyMarker 的「服务端稳定英文原文 → 子串匹配」机制）。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29），此处保名别名
const GitGateBusyMarker = errmarkers.GitGateBusy

// errGitGateTimeout 全局门等待超时（sentinel，调用方 errors.Is 可判）
var errGitGateTimeout = errors.New("gate wait timeout")

// 指标名（metrics 出口的事实源）。健康摘要（server/api/system/health.go）
// 直取前三项 gauge，导出常量防两端字符串漂移；超时计数仅 Prometheus 出口
const (
	MetricRunning     = "sc_git_running"
	MetricWaiting     = "sc_git_waiting"
	MetricWaitingPeak = "sc_git_waiting_peak"

	metricGateTimeouts = "sc_git_gate_timeouts_total"
)

// gitGlobalConcurrencyLimit 全局并发上限（起步 8）：常规单 agent 的面板刷新/
// 状态轮询峰值远达不到（零感知），多 agent 并行的数十进程风暴被钳到 8。
// 常量起步、不设运行时配置面——资源治理底线不该被随手调大；标定依据看
// sc_git_waiting_peak 实测峰值（长期贴顶再考虑上调）
const gitGlobalConcurrencyLimit = 8

// gitGateWaitTimeout 排队等待上限 20s：正常竞争毫秒~秒级（8 个槽位被
// status/diff 等毫秒级读快速轮转排空），等 20s 还没轮到说明槽位被长操作
// 占满——按超时失败让调用方稍后重试。取 20s 而非写队列的 30s：前端 axios
// 全局超时 30s（web/src/api/http.ts），须留余量让稳定标记先于客户端超时
// 到达，否则用户只看到无差别的网络错误。var 便于单测注入短超时
var gitGateWaitTimeout = 20 * time.Second

// gitGateSlots 全局槽位（容量 = gitGlobalConcurrencyLimit）。
// chan 天然支持带超时的 select 获取，无需轮询
var gitGateSlots = make(chan struct{}, gitGlobalConcurrencyLimit)

// 排队等待数与峰值（atomic 单一事实源；gauge 是旁路投影，best-effort 快照）
var (
	gitWaitingNow  atomic.Int64
	gitWaitingPeak atomic.Int64
)

// gateWaitBegin 排队等待开始：等待数 +1 落 gauge，峰值到达新高时递推更新
func gateWaitBegin() {
	n := gitWaitingNow.Add(1)
	metrics.SetGauge(MetricWaiting, n)
	for {
		p := gitWaitingPeak.Load()
		if n <= p || gitWaitingPeak.CompareAndSwap(p, n) {
			break
		}
	}
	metrics.SetGauge(MetricWaitingPeak, gitWaitingPeak.Load())
}

// gateWaitEnd 排队等待结束（拿到槽位/超时/ctx 取消三路共用）
func gateWaitEnd() {
	metrics.SetGauge(MetricWaiting, gitWaitingNow.Add(-1))
}

// acquireGlobalGate 取一个全局槽位（常规路径：不可取消、用默认等待上限）。
// 成功返回释放函数（必须执行，通常 defer——释放同时维护 sc_git_running）；
// 排队超时返回含稳定标记的错误（命令未执行）。本函数不做任何阻塞型子操作，
// 杜绝门自身成为挂起点
func acquireGlobalGate(args []string) (func(), error) {
	return acquireGlobalGateCtx(context.Background(), args, gitGateWaitTimeout)
}

// acquireGlobalGateCtx acquireGlobalGate 的完整形态：等待上限与取消信号由
// 调用方给（流式克隆传用户 ctx——排队中被取消不应继续傻等）。ctx 取消返回
// 包裹 ctx.Err() 的错误（无稳定标记：取消是调用方意图，不是限流事件）
func acquireGlobalGateCtx(ctx context.Context, args []string, timeout time.Duration) (func(), error) {
	gateWaitBegin()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case gitGateSlots <- struct{}{}:
	case <-timer.C:
		gateWaitEnd()
		metrics.IncCounter(metricGateTimeouts)
		slog.Warn("git global gate wait timeout", "args", redactArgs(args), "queued", timeout)
		return nil, fmt.Errorf("git %s: %w: %s (queued %v, command not executed)",
			redactArgs(args), errGitGateTimeout, GitGateBusyMarker, timeout)
	case <-ctx.Done():
		gateWaitEnd()
		return nil, fmt.Errorf("git %s: %w", redactArgs(args), ctx.Err())
	}
	gateWaitEnd()
	metrics.AddGauge(MetricRunning, 1)
	return func() {
		metrics.AddGauge(MetricRunning, -1)
		<-gitGateSlots
	}, nil
}
