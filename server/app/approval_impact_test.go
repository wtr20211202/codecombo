package app

import (
	"testing"

	"codecombo/server/terminal"
)

// guarded 审批卡服务端 impact 自动填充（P-20261006-35）：删除项目影响面的
// 计数口径 / 双语文案 / 降级形态。会话清单换桩注入，不依赖真实终端管理器

func impactSessions() []*terminal.Session {
	// d 无项目绑定（kind=agent 系统会话 projectId 恒空），不随项目删除级联，
	// 不该被数进任何项目的删除影响面
	return []*terminal.Session{
		{ID: "s1", ProjectID: "p1"},
		{ID: "s2", ProjectID: "p1"},
		{ID: "s3", ProjectID: "p2"},
		{ID: "s4"},
	}
}

func TestDeleteProjectApprovalImpact_LangAndCount(t *testing.T) {
	// zh 系（zh / zh-CN 两种头形态）→ 中文摘要，计数只含该项目绑定会话
	for _, lang := range []string{"zh", "zh-CN", "zh-TW"} {
		imp := deleteProjectApprovalImpact("/api/projects/p1", lang, impactSessions())
		if imp == nil {
			t.Fatalf("lang %q: impact 不应为 nil", lang)
		}
		if imp.Kind != "delete" {
			t.Errorf("lang %q: kind = %q, want delete", lang, imp.Kind)
		}
		if imp.Summary != "将终止该项目 2 个终端会话" {
			t.Errorf("lang %q: summary = %q", lang, imp.Summary)
		}
	}

	// 非 zh 与空值 → 英文默认（defaultSessionNumberedName 同款约定）
	for _, lang := range []string{"", "en-US", "fr"} {
		imp := deleteProjectApprovalImpact("/api/projects/p1", lang, impactSessions())
		if imp == nil || imp.Summary != "Will terminate 2 terminal session(s) of this project" {
			t.Errorf("lang %q: summary = %+v, want 英文默认", lang, imp)
		}
	}

	// 单会话 / 零会话照实计数（诚实报数，0 也不虚构也不隐藏）
	if imp := deleteProjectApprovalImpact("/api/projects/p2", "zh", impactSessions()); imp == nil ||
		imp.Summary != "将终止该项目 1 个终端会话" {
		t.Errorf("p2 summary = %+v, want 1 个", imp)
	}
	if imp := deleteProjectApprovalImpact("/api/projects/p9", "zh", impactSessions()); imp == nil ||
		imp.Summary != "将终止该项目 0 个终端会话" {
		t.Errorf("p9 summary = %+v, want 0 个", imp)
	}
}

func TestDeleteProjectApprovalImpact_Degrade(t *testing.T) {
	// target 形态不符（空 / 前缀缺失 / 带尾段）一律降级 nil 老卡形态
	for _, target := range []string{"", "/api/projects/", "/api/projects/p1/extra", "p1"} {
		if imp := deleteProjectApprovalImpact(target, "zh", impactSessions()); imp != nil {
			t.Errorf("target %q 应降级 nil, got %+v", target, imp)
		}
	}
}

func TestNewApprovalImpactFiller_Dispatch(t *testing.T) {
	f := newApprovalImpactFiller()

	// 删除项目守卫模式 → 填充
	if imp := f("/api/projects/:id", "删除项目", "/api/projects/p1", "zh"); imp == nil {
		t.Fatal("删除项目模式应填充 impact")
	}
	// 其余高危路由（有可靠数据前一律 nil）/ 敏感写入表 glob → nil 降级
	for _, tc := range []struct{ pattern, op, target string }{
		{"/api/credentials/:id", "删除凭据", "/api/credentials/c1"},
		{"/api/instances/:id", "删除实例", "/api/instances/i1"},
		{"/api/terminals/broadcast-write", "终端广播输入", "/api/terminals/broadcast-write"},
		{"**/.git/hooks/**", "写入敏感路径 .git/hooks/pre-commit", ".git/hooks/pre-commit"},
	} {
		if imp := f(tc.pattern, tc.op, tc.target, "zh"); imp != nil {
			t.Errorf("pattern %q 应降级 nil, got %+v", tc.pattern, imp)
		}
	}
}
