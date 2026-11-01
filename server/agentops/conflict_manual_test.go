package agentops

import (
	"strings"
	"testing"
)

// conflict 节守卫（P-20261004-30）：冲突解决域的 agent 协议面登记在册——
// 端点清单、行为规范（先 ops-ask 上报偏好，未授权不得擅自 resolve）、审批链
// （428→轮询→X-Approval-ID 重试）与逐块解析示例缺一即红（文档不漂移）
func TestConflictSectionDocumentsAgentProtocol(t *testing.T) {
	var sec *Section
	for _, s := range Sections() {
		if s.ID == "conflict" {
			cp := s
			sec = &cp
			break
		}
	}
	if sec == nil {
		t.Fatal("manual section \"conflict\" not registered (sections_builtin.go)")
	}
	for _, fragment := range []string{
		"/api/projects/:id/conflicts", // 列表
		"/conflicts/content",          // 原文读取
		"/conflicts/parsed",           // 逐块解析（P-59 agent 消费面）
		"/conflicts/resolve",          // 整文件 ours/theirs
		"/conflicts/resolve-content",  // 合成写回
		"ops-ask",                     // 行为规范第一步：上报用户偏好
		"X-Approval-ID",               // 审批放行重试链
		"startLine",                   // hunks 结构化字段
		"inProgress",                  // 收尾按进行中操作分流
	} {
		if !strings.Contains(sec.Body, fragment) {
			t.Errorf("conflict section body missing %q", fragment)
		}
	}
	// SKILL.md 索引必须携带摘要（渐进式披露第一层可达）
	if !strings.Contains(SkillMarkdown(""), sec.Title) {
		t.Errorf("SkillMarkdown index missing conflict section title %q", sec.Title)
	}
}
