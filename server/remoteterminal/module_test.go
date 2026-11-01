package remoteterminal

import (
	"context"
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）。
// dialer 传 nil：生命周期内不拨号，Manager 仅被装配/卸载
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module { return NewModule(nil) })
}

// TestModuleInstallsManager Init 装配包级单例、Stop 卸载
func TestModuleInstallsManager(t *testing.T) {
	mod := NewModule(nil)
	if GetManager() != nil {
		t.Fatal("manager should be nil before module Init")
	}
	if err := mod.Init(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if GetManager() == nil {
		t.Fatal("manager should be installed after module Init")
	}
	if err := mod.Stop(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if GetManager() != nil {
		t.Fatal("manager should be uninstalled after module Stop")
	}
}
