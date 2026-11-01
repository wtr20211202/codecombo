package git

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/metrics"
)

// 全局 git 子进程并发门（P-20261004-125）单测：
//   - 上限语义：12 个并发获取方实测峰值 ≤ 8（chan 容量的硬不变量）
//   - 排队平滑：未达上限零感知（其余 git 测试即常规路径回归）、达上限后
//     排队等待而非拒绝
//   - 超时：等待上限到达返回 sentinel + 稳定标记（前端 KNOWN_ERROR_I18N
//     匹配契约），经 execGit 汇流点同样成立（命令未执行的措辞留痕）
//   - 指标：sc_git_running / sc_git_waiting / sc_git_waiting_peak 三 gauge
//     与 sc_git_gate_timeouts_total 计数随事件如实涨落
//
// 测试间串行执行（本包无 t.Parallel），共享的 gitGateSlots/metrics 注册表
// 无并发测试污染；holdAllGateSlots 以 t.Cleanup 兜底归还槽位防失败路径泄漏。

// holdAllGateSlots 占满全部全局槽位。释放函数经 sync.OnceFunc 幂等化：
// 用例手动释放 + t.Cleanup 兜底同持一份引用，双重调用不误 drain 他人槽位
func holdAllGateSlots(t *testing.T) []func() {
	t.Helper()
	releases := make([]func(), 0, gitGlobalConcurrencyLimit)
	t.Cleanup(func() {
		for _, r := range releases {
			r()
		}
	})
	for i := 0; i < gitGlobalConcurrencyLimit; i++ {
		release, err := acquireGlobalGate(nil)
		if err != nil {
			t.Fatalf("acquire slot %d: %v", i, err)
		}
		releases = append(releases, sync.OnceFunc(release))
	}
	return releases
}

// gateCounterFromRender 从 Prometheus 文本出口读计数器值（metrics 包无
// counter getter，文本出口即消费面；顺带覆盖 Render 序列化形态）
func gateCounterFromRender(t *testing.T, name string) int64 {
	t.Helper()
	for _, line := range strings.Split(metrics.Render(), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == name {
			v, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil {
				t.Fatalf("parse %q: %v", line, err)
			}
			return v
		}
	}
	return 0
}

// waitForGauge 轮询等 gauge 到达 want（排队是异步事件，固定 sleep 会既慢
// 又脆），deadline 内未到达即失败
func waitForGauge(t *testing.T, name string, want int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for metrics.GaugeValue(name) < want {
		if time.Now().After(deadline) {
			t.Fatalf("%s never reached %d (now %d)", name, want, metrics.GaugeValue(name))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestGlobalGate_CapsConcurrency 上限语义：12 个并发获取方在 8 槽位门前
// 排队，实测同时持有数 ≤ 8（若门失效则 12 个 holder 重叠、峰值=12）。
// 全部获取方最终成功（排队平滑，不拒绝）
func TestGlobalGate_CapsConcurrency(t *testing.T) {
	const workers = 12
	var cur, maxObs atomic.Int64
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			release, err := acquireGlobalGate(nil)
			if err != nil {
				errs[i] = err
				return
			}
			defer release()
			n := cur.Add(1)
			for {
				m := maxObs.Load()
				if n <= m || maxObs.CompareAndSwap(m, n) {
					break
				}
			}
			time.Sleep(150 * time.Millisecond) // 拉长临界区让重叠可观测
			cur.Add(-1)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", i, err)
		}
	}
	if got := maxObs.Load(); got > gitGlobalConcurrencyLimit {
		t.Fatalf("observed %d concurrent gate holders, want <= %d", got, gitGlobalConcurrencyLimit)
	}
}

// TestGlobalGate_WaitTimeoutWithMarker 超时路径：门占满 + 短等待上限 →
// sentinel + 稳定标记（错误文本「命令未执行」留痕），超时计数 +1
func TestGlobalGate_WaitTimeoutWithMarker(t *testing.T) {
	releases := holdAllGateSlots(t)
	before := gateCounterFromRender(t, metricGateTimeouts)

	_, err := acquireGlobalGateCtx(context.Background(), []string{"status"}, 80*time.Millisecond)
	if !errors.Is(err, errGitGateTimeout) {
		t.Fatalf("err = %v, want errGitGateTimeout", err)
	}
	if !strings.Contains(err.Error(), GitGateBusyMarker) {
		t.Fatalf("err = %v, want marker %q", err, GitGateBusyMarker)
	}

	after := gateCounterFromRender(t, metricGateTimeouts)
	if after != before+1 {
		t.Fatalf("%s = %d, want %d (+1)", metricGateTimeouts, after, before+1)
	}
	for _, r := range releases {
		r()
	}
}

// TestGlobalGate_WaitingGaugeAndPeak 指标面：门占满时 sc_git_running=8；
// 排队者出现后 sc_git_waiting=1、峰值 ≥1；槽位释放、排队者拿到槽位后
// 等待/占用双双归零（排队→执行的闭环）
func TestGlobalGate_WaitingGaugeAndPeak(t *testing.T) {
	releases := holdAllGateSlots(t)
	if got := metrics.GaugeValue(MetricRunning); got != gitGlobalConcurrencyLimit {
		t.Fatalf("%s = %d, want %d (all slots held)", MetricRunning, got, gitGlobalConcurrencyLimit)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		release, err := acquireGlobalGate(nil) // 排队直至槽位释放
		if err != nil {
			t.Error(err)
			return
		}
		release()
	}()

	waitForGauge(t, MetricWaiting, 1)
	if got := metrics.GaugeValue(MetricWaitingPeak); got < 1 {
		t.Errorf("%s = %d, want >= 1 once a waiter queued", MetricWaitingPeak, got)
	}

	for _, r := range releases {
		r()
	}
	<-done
	if got := metrics.GaugeValue(MetricWaiting); got != 0 {
		t.Errorf("%s = %d after drain, want 0", MetricWaiting, got)
	}
	if got := metrics.GaugeValue(MetricRunning); got != 0 {
		t.Errorf("%s = %d after drain, want 0", MetricRunning, got)
	}
}

// TestExecGit_GateTimeoutThroughExecGit 经 execGit 汇流点的超时路径：门占满
// + 短等待上限注入 → 读命令失败且错误含稳定标记（门错误必须穿透「stderr
// 组装」原样上抛——这是门在汇流点接线的核心契约）；释放一格后同命令成功
func TestExecGit_GateTimeoutThroughExecGit(t *testing.T) {
	dir := initRepo(t)
	releases := holdAllGateSlots(t)

	old := gitGateWaitTimeout
	gitGateWaitTimeout = 200 * time.Millisecond
	t.Cleanup(func() { gitGateWaitTimeout = old })

	_, err := execGit(dir, "status")
	if !errors.Is(err, errGitGateTimeout) {
		t.Fatalf("status under full gate: err = %v, want errGitGateTimeout", err)
	}
	if !strings.Contains(err.Error(), GitGateBusyMarker) {
		t.Fatalf("err = %v, want marker %q", err, GitGateBusyMarker)
	}

	releases[0]()
	if _, err := execGit(dir, "status"); err != nil {
		t.Fatalf("status after slot release: %v", err)
	}
}

// TestGlobalGate_CtxCancelWhileQueued 取消路径（流式克隆传用户 ctx）：排队中
// 被取消 → 立即返回包裹 ctx.Err() 的错误（无稳定标记——取消是调用方意图），
// 等待计数归零、槽位无泄漏
func TestGlobalGate_CtxCancelWhileQueued(t *testing.T) {
	releases := holdAllGateSlots(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		_, err := acquireGlobalGateCtx(ctx, nil, 5*time.Second)
		errCh <- err
	}()
	waitForGauge(t, MetricWaiting, 1)
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
		if strings.Contains(err.Error(), GitGateBusyMarker) {
			t.Fatalf("cancel path must not carry the rate-limit marker: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not unblock the queued waiter")
	}
	if got := metrics.GaugeValue(MetricWaiting); got != 0 {
		t.Errorf("%s = %d after cancel, want 0", MetricWaiting, got)
	}
	for _, r := range releases {
		r()
	}
}
