package update

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/store"
)

// newTestStore 模块生命周期依赖 store，先装独立测试 store（避免污染全局）
func newTestStore(t *testing.T) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// TestModuleConformance 契约一致性自检（M1.6）
func TestModuleConformance(t *testing.T) {
	newTestStore(t)
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}
