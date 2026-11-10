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

// TestModuleConformance 契约一致性自检（M1.6）。数据目录注入临时目录：Start 的
// 启动清理与结果观察窗不得触碰真实数据目录（P-20261109-10）
func TestModuleConformance(t *testing.T) {
	newTestStore(t)
	dd := t.TempDir()
	kerneltest.Conformance(t, func() kernel.Module {
		m := NewModule("")
		m.dataDirGen = func() string { return dd }
		return m
	})
}
