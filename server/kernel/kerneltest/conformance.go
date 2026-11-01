// Package kerneltest 内核模块契约一致性测试套件（roadmap M1.6）。
//
// 契约检验从「一次性人工」变「机制化」：任何 kernel.Module 一行接入即可自检——
//
//	import "codecombo/server/kernel/kerneltest"
//
//	func TestModuleConformance(t *testing.T) {
//	    kerneltest.Conformance(t, func() kernel.Module { return NewModule(...) })
//	 }
//
// 覆盖的契约面：
//  1. Name 命名空间（[a-z0-9-]+，同时是 topic 与 API 前缀命名空间）；
//  2. 生命周期时序：Init → Start → Stop，各恰好一次、顺序正确；
//  3. 事件信封格式：生命周期内发布的 Envelope 必须带非空 Topic、
//     TS 由总线盖章非零、Payload 可 JSON 序列化（WS 桥接前提）；
//  4. Stop 后无副作用：内核 StopAll 后调度器不再触发任务、事件总线不再派发；
//  5. Stop 幂等：重复调用不得 panic。
//
// 注意：套件用真实 StdKernel 驱动完整生命周期，模块 Init 里依赖 store 等
// 全局的服务需在调用前自行准备好测试态。
package kerneltest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"testing"
	"time"

	"codecombo/server/kernel"
)

var nameRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// Conformance 对 factory 构造的模块运行完整契约检查。
// 使用真实 StdKernel：Register → StartAll → StopAll，外加 Stop 幂等探测。
func Conformance(t *testing.T, factory func() kernel.Module) {
	t.Helper()

	m := factory()
	if m == nil {
		t.Fatal("kerneltest: factory returned nil module")
	}

	// 契约 1：Name 命名空间
	if !nameRe.MatchString(m.Name()) {
		t.Errorf("module name %q does not match [a-z0-9-]+", m.Name())
	}

	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	k := kernel.New(quiet)

	// 采集生命周期内发布的全部事件（契约 3 用）
	var mu sync.Mutex
	var envelopes []kernel.Envelope
	unsub := k.Events().Subscribe("*", func(env kernel.Envelope) {
		mu.Lock()
		envelopes = append(envelopes, env)
		mu.Unlock()
	})
	defer unsub()

	rec := &recorder{target: m}
	if err := k.Register(rec, kernel.Manifest{Name: m.Name()}); err != nil {
		t.Fatalf("kerneltest: register: %v", err)
	}

	ctx := context.Background()
	if err := k.StartAll(ctx); err != nil {
		t.Fatalf("kerneltest: StartAll: %v", err)
	}

	// 契约 2a：StartAll 后 init → start 已按序发生
	if err := rec.expectOrder("init", "start"); err != nil {
		t.Error(err)
	}

	k.StopAll(ctx)

	// 契约 2b：StopAll 后 stop 恰好发生一次，且整体顺序 init → start → stop
	if err := rec.expectOrder("init", "start", "stop"); err != nil {
		t.Error(err)
	}
	if got := rec.count("stop"); got != 1 {
		t.Errorf("Stop called %d times, want exactly 1", got)
	}

	// 契约 3：事件信封格式
	mu.Lock()
	for i, env := range envelopes {
		if env.Topic == "" {
			t.Errorf("envelope[%d] has empty Topic", i)
		}
		if env.TS.IsZero() {
			t.Errorf("envelope[%d] (topic=%q) has zero TS: bus must stamp publish time", i, env.Topic)
		}
		if _, err := json.Marshal(env.Payload); err != nil {
			t.Errorf("envelope[%d] (topic=%q) payload not JSON-marshalable: %v", i, env.Topic, err)
		}
	}
	published := len(envelopes)
	mu.Unlock()

	// 契约 4：Stop 后无副作用。
	// 4a. 调度器：StopAll 后新注册的 ticker 不得再触发（ctx 已取消）
	fired := 0
	k.Scheduler().AddTicker("post-stop-probe", 10*time.Millisecond, func(context.Context) { fired++ })
	time.Sleep(80 * time.Millisecond)
	if fired != 0 {
		t.Errorf("scheduler fired %d times after StopAll: module ticker lifecycle leaked", fired)
	}
	// 4b. 事件总线：Close 后 Publish 为 no-op，不得再派发
	k.Events().Publish(kernel.Envelope{Topic: "post.stop.probe"})
	mu.Lock()
	after := len(envelopes)
	mu.Unlock()
	if after != published {
		t.Errorf("event bus dispatched %d → %d envelopes after StopAll: bus not closed", published, after)
	}

	// 契约 5：Stop 幂等——重复调用不得 panic（副作用由模块自行保证幂等）
	_ = m.Stop(ctx, k)
}

// recorder 契约探测代理：记录生命周期调用序列，逐调用委托给被测模块
type recorder struct {
	target kernel.Module

	mu    sync.Mutex
	calls []string
}

func (r *recorder) Name() string        { return r.target.Name() }
func (r *recorder) DependsOn() []string { return r.target.DependsOn() }
func (r *recorder) Init(ctx context.Context, k kernel.Kernel) error {
	r.record("init")
	return r.target.Init(ctx, k)
}
func (r *recorder) Start(ctx context.Context, k kernel.Kernel) error {
	r.record("start")
	return r.target.Start(ctx, k)
}
func (r *recorder) Stop(ctx context.Context, k kernel.Kernel) error {
	r.record("stop")
	return r.target.Stop(ctx, k)
}

func (r *recorder) record(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, name)
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, c := range r.calls {
		if c == name {
			n++
		}
	}
	return n
}

// expectOrder 校验 calls 的前 len(want) 项与 want 完全一致
func (r *recorder) expectOrder(want ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) < len(want) {
		return fmt.Errorf("lifecycle %v not fully reached, calls so far: %v", want, r.calls)
	}
	for i := range want {
		if r.calls[i] != want[i] {
			return errors.New("lifecycle order mismatch: want " + fmt.Sprint(want) + ", got " + fmt.Sprint(r.calls))
		}
	}
	return nil
}
