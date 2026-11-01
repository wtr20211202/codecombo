package files

import (
	"testing"

	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
)

// TestModuleConformance 契约一致性自检（M1.6）
func TestModuleConformance(t *testing.T) {
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}
