package agentops

import (
	"strings"
	"testing"
)

func TestSectionRegistry(t *testing.T) {
	before := len(Sections())
	RegisterSection(Section{ID: "x-test", Title: "测试能力 X", Summary: "X 能力摘要", Body: "GET /x", Order: 5})
	RegisterSection(Section{ID: "x-test", Title: "测试能力 X2", Summary: "X2 摘要", Body: "GET /x2", Order: 5}) // 同 ID 覆盖
	after := Sections()

	if len(after) != before+1 {
		t.Fatalf("同 ID 注册应覆盖而非新增：before=%d after=%d", before, len(after))
	}
	// Order 小者在前
	if after[0].ID != "x-test" {
		t.Fatalf("Order=5 应排最前，实际首节=%s", after[0].ID)
	}
	// Manual 自动包含注册节
	manual := Manual("http://t")
	if !strings.Contains(manual, "## 测试能力 X2") || !strings.Contains(manual, "GET /x2") {
		t.Fatal("Manual 未包含注册节")
	}
	if !strings.Contains(manual, "http://t") || !strings.Contains(manual, "X-Lock-Token") {
		t.Fatal("Manual 缺 baseURL 替换或认证说明")
	}

	// 渐进式披露：SKILL.md 为索引形态（含摘要与 references 指引），细节在参考文件
	skill := SkillMarkdown("http://t")
	if !strings.HasPrefix(skill, "---\nname: codecombo-ops") {
		t.Fatal("SkillMarkdown 缺 front matter")
	}
	if !strings.Contains(skill, "测试能力 X2（X2 摘要）") || !strings.Contains(skill, "references/x-test.md") {
		t.Fatal("SkillMarkdown 索引未包含分节摘要与参考文件指引")
	}
	if strings.Contains(skill, "GET /x2") {
		t.Fatal("SkillMarkdown 第一层不应包含分节端点细节（渐进式披露）")
	}
	if !strings.Contains(skill, "TASK_DONE") || !strings.Contains(skill, "ops-notify") {
		t.Fatal("SkillMarkdown 工作流段缺任务标记/前端联动说明")
	}
	// 触发判据必须写进 description：claude 靠它决定是否加载技能——只写「操作
	// 本系统时使用」会让普通编码任务（用户未提及本系统）不触发，会话自命名落空
	if !strings.Contains(skill, "CC_TERMINAL_ID 或 CC_BASE_URL 存在即适用") {
		t.Fatal("SkillMarkdown description 缺宽触发判据")
	}
	if !strings.Contains(skill, "$CC_TERMINAL_ID/rename") {
		t.Fatal("SkillMarkdown 工作流段缺会话自命名约定")
	}

	refs := SkillReferences("http://t")
	var xref *SkillRef
	for i := range refs {
		if refs[i].Path == "references/x-test.md" {
			xref = &refs[i]
		}
	}
	if xref == nil {
		t.Fatalf("SkillReferences 未生成 x-test 参考文件：%v", refs)
	}
	if !strings.Contains(xref.Content, "# 测试能力 X2") || !strings.Contains(xref.Content, "GET /x2") {
		t.Fatal("参考文件未包含分节标题与端点细节")
	}

	// 清理，避免影响其他用例
	RegisterSection(Section{ID: "x-test", Title: "", Body: "", Order: 9999})
}

func TestProviderSelection(t *testing.T) {
	names := ProviderNames()
	if len(names) < 2 {
		t.Fatalf("内置 Provider 应已注册（claude/dsh），实际=%v", names)
	}
	// 选型逻辑测试用注入链——宿主可能没有任何 CLI（GitHub runner 干净环境
	// 全链 nil，真实环境冒烟曾假红；与 systemdUnit 门控同类教训：环境探测
	// 不进断言）。注册表是包内可换的全局，用完即恢复
	old := providers
	t.Cleanup(func() { providers = old })

	fakeOK := &fakeProvider{name: "fake-ok", available: true}
	fakeDown := &fakeProvider{name: "fake-down", available: false}

	providers = []Provider{fakeDown, fakeOK}
	if p := SelectProvider(); p == nil || p.Name() != "fake-ok" {
		t.Fatalf("SelectProvider 应选链上首个 Available 项，got %v", p)
	}

	providers = []Provider{fakeDown}
	if p := SelectProvider(); p != nil {
		t.Fatalf("全链不可用应返回 nil，got %v", p)
	}
}

// fakeProvider 选型逻辑测试桩（仅实现接口面，无 CLI 探测）
type fakeProvider struct {
	name      string
	available bool
}

func (f *fakeProvider) Name() string                       { return f.name }
func (f *fakeProvider) Available() bool                    { return f.available }
func (f *fakeProvider) InteractiveCommand() (string, bool) { return "", false }
