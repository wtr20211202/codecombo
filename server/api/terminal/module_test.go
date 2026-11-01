package terminal

import (
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）。
// Start 会清理系统临时目录的过期 sc-paste-* 文件——真实执行，无外部依赖
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}
