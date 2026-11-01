package app

import (
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/store"
)

// TestRuntimeOpsConformance 契约一致性自检（M1.6）：
// 锁默认配置/实例登记/清理循环依赖 store，先装独立测试 store
func TestRuntimeOpsConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	cfg := &config.Config{}
	kerneltest.Conformance(t, func() kernel.Module { return newRuntimeOpsModule(cfg) })
}
