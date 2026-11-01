package deploy

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/store"
)

// TestModuleConformance 契约一致性自检（M1.6）。模块 Init 依赖 store，
// 先装独立测试 store；Stop 卸载 defaultManager，不污染其他测试
func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}
