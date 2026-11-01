package terminal

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/store"
)

// TestModuleConformance 契约一致性自检（M1.6）。
// Start 里 RecoverSessions 依赖 store（tmux 可用平台反查项目），先装独立测试 store
func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}
