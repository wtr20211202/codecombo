package app

// guarded 审批卡服务端 impact 自动填充（P-20261006-35）：AgentGuard 428 拦截
// 建的审批此前恒无结构化影响面（审批卡退化为静态 op 文案）——本文件提供
// middleware.ImpactFiller 的组合根计算函数，服务端按守卫模式单方填充有可靠
// 数据的操作（agent 不附也在的兜底；与 P-191 agent 主动 command-preview 预检
// 自附互补不叠）。窄域初批只做「删除项目」一条：DeleteProject 会级联关闭该
// 项目全部终端会话（server/api/project DeleteProject 级联清理段同源语义），
// 会话计数即裁决知情面。运行态不下断言：OSC 133 运行态（P-20261004-63）只
// 覆盖本进程见过的帧，shell 集成未注入/重启恢复等形态运行态未知——宁漏报
// 不误报，计数是本面唯一无歧义信号。计算失败由 middleware 侧 panic 兜底降级
// nil 老卡形态，本函数内不做阻塞审批创建的重活。

import (
	"fmt"
	"strings"

	"codecombo/server/store"
	"codecombo/server/terminal"
)

// approvalImpactDeleteProjectPattern 删除项目的守卫模式（guardedRoutes 的
// gin FullPath 形态）。按模式而非 op 文案分发：op 是展示/规则匹配用的文案，
// FullPath 才是路由身份。模式漂移（路由改名未同步此处）的失效形态是静默
// 降级 nil 老卡——知情增强面缺失无害于审批语义
const approvalImpactDeleteProjectPattern = "/api/projects/:id"

// newApprovalImpactFiller 组合根注入 middleware.ImpactFiller 的计算函数：
// 按守卫模式分发到各操作的 impact 构造，无可靠数据的模式返回 nil（降级）。
// target 为未脱敏请求目标原文（仅用于提取目标 ID，不得回填进返回值——
// Summary 只构造计数文案，落盘面另有 mask.MaskApprovalText 收口）
func newApprovalImpactFiller() func(pattern, op, target, lang string) *store.ApprovalImpact {
	return func(pattern, op, target, lang string) *store.ApprovalImpact {
		if pattern == approvalImpactDeleteProjectPattern {
			return deleteProjectApprovalImpact(target, lang, terminal.DefaultManager.ListSessions())
		}
		return nil
	}
}

// deleteProjectApprovalImpact 删除项目的影响面：按 ProjectID 计数该项目现存
// 终端会话（与 DeleteProject 级联清理的判定同源——数到的就是将被终止的），
// 摘要随 Accept-Language 双语（defaultSessionNumberedName 同款约定：zh 系中文，
// 其余英文）。会话清单经参数注入（生产 terminal.DefaultManager.ListSessions，
// 单测换桩）；目标 ID 从 URL 路径尾段提取，非 /api/projects/ 前缀的规范形态
// 一律返回 nil 降级（误接线的 target 拿到空计数比拒绝填充更误导）
func deleteProjectApprovalImpact(target, lang string, sessions []*terminal.Session) *store.ApprovalImpact {
	const prefix = "/api/projects/"
	if !strings.HasPrefix(target, prefix) {
		return nil
	}
	id := target[len(prefix):]
	if id == "" || strings.Contains(id, "/") {
		return nil
	}
	n := 0
	for _, s := range sessions {
		if s.ProjectID == id {
			n++
		}
	}
	summary := fmt.Sprintf("Will terminate %d terminal session(s) of this project", n)
	if strings.HasPrefix(strings.ToLower(lang), "zh") {
		summary = fmt.Sprintf("将终止该项目 %d 个终端会话", n)
	}
	return &store.ApprovalImpact{Kind: "delete", Summary: summary}
}
