package ai

import (
	"context"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/store"
)

// TestModuleConformance 契约一致性自检（M1.6：内核模块生命周期契约验证）
func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}

// TestModuleInitRejectsUnreachableStore 存储不可达时 Init 报错（装配期暴露）
func TestModuleInitRejectsUnreachableStore(t *testing.T) {
	store.SetDefault(nil)
	t.Cleanup(func() { store.SetDefault(nil) })

	if err := NewModule().Init(context.Background(), nil); err == nil {
		t.Fatal("Init should fail when store is unreachable")
	}
}
