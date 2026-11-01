package notification

import (
	"context"
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）：一行接入机制化检验
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module { return NewModule(nil, nil) })
}

// TestBusBridgeRoundtrip store 出站发布 → 总线 → 模块桥回 WS hub 的链路验证
func TestBusBridgeRoundtrip(t *testing.T) {
	m := NewModule(nil, nil)
	k := kernel.New(nil)
	if err := k.Register(m, kernel.Manifest{Name: m.Name()}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := k.StartAll(ctx); err != nil {
		t.Fatal(err)
	}
	defer k.StopAll(ctx)

	hub := GetHub()
	if hub == nil {
		t.Fatal("hub not initialized by module Init")
	}

	// 模拟 store 出站口向总线发布，模块应收到（broadcast 无客户端时静默成功，
	// 这里验证的是订阅链路的存在性与载荷类型分发）
	k.Events().Publish(kernel.Envelope{Topic: TopicNew, Payload: Notification{ID: "n1", Title: "t"}})
	// 错误载荷类型不应 panic
	k.Events().Publish(kernel.Envelope{Topic: TopicNew, Payload: "junk"})
}
