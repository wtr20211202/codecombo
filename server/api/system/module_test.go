package system

import (
	"context"
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module {
		return NewModule("test-v", "abc", "2026-09-13")
	})
}

// TestInitSetsBuildInfo Init 装配构建信息（原组合根 SetBuildInfo 启动调用迁入）
func TestInitSetsBuildInfo(t *testing.T) {
	if err := NewModule("9.9.9-test", "deadbeef", "2026-09-13").Init(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if buildVersion != "9.9.9-test" {
		t.Fatalf("buildVersion = %q", buildVersion)
	}
}
