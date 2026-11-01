package project

import (
	"context"
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}

// TestPublishLifecycle 生命周期事件发布：模块 Init 装配后 handler 的
// publishLifecycle 落到总线；未装配时静默跳过
func TestPublishLifecycle(t *testing.T) {
	t.Cleanup(func() { publisher = nil })

	envCh := make(chan kernel.Envelope, 1)
	k := kernel.New(nil)
	unsub := k.Events().Subscribe(TopicProjectAdded, func(env kernel.Envelope) { envCh <- env })
	defer unsub()

	if err := NewModule().Init(context.Background(), k); err != nil {
		t.Fatal(err)
	}

	publishLifecycle(TopicProjectAdded, "p1", "/tmp/repo")
	env := <-envCh
	if env.Topic != TopicProjectAdded {
		t.Fatalf("topic = %q", env.Topic)
	}
	m, ok := env.Payload.(map[string]string)
	if !ok || m["id"] != "p1" || m["path"] != "/tmp/repo" {
		t.Fatalf("payload = %+v", env.Payload)
	}

	// 卸载后静默
	_ = NewModule().Stop(context.Background(), nil)
	publishLifecycle(TopicProjectRemoved, "p2", "/tmp/x") // 不应 panic
}
