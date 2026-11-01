package agentops

import (
	"strings"
	"testing"

	"codecombo/server/api/shared"
)

// P-20261003-305 门禁：ops 手册「错误码对照」分节（error-codes）必须覆盖共享
// 注册表内的每一个错误码——注册表新增码而手册漏登记在此翻红（文档不漂移）。
// 反向不要求（手册可含前瞻性迁移说明）。
func TestErrorCodesManualCoversRegistry(t *testing.T) {
	var sec *Section
	for _, s := range Sections() {
		if s.ID == "error-codes" {
			cp := s
			sec = &cp
			break
		}
	}
	if sec == nil {
		t.Fatal("manual section \"error-codes\" not registered (sections_builtin.go)")
	}
	for _, code := range shared.AllCodes() {
		if !strings.Contains(sec.Body, string(code)) {
			t.Errorf("manual error-codes section missing code %q", code)
		}
	}
}
