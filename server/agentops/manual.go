// Package agentops —— AI 助手的扩展点中枢。
//
// 新增后端能力如何在 AI 助手中「无缝接入」：
//  1. 在自己模块的 init() 里调用 agentops.RegisterSection 注册一节操作手册
//     （手册驱动 Agent 学会调用本系统；/ops-manual 为全文，SKILL.md 按渐进式
//     披露组织：入口索引 + references/ 分域参考文件按需读取）
//  2. 需要新的 Agent 运行时（claude/dsh/其他 CLI）时实现 Provider 并
//     agentops.RegisterProvider 注册，选型按注册顺序自动进行
//
// 两类注册表均并发安全（服务启动期注册、运行期只读）。
package agentops

import (
	"sort"
	"strings"
	"sync"
)

// ============== 操作手册分节注册表 ==============

// Section 操作手册的一节：一个后端能力域一段（项目/设置/Git/远程主机/部署/通道…）。
// 新功能模块注册自己的 Section 后，Manual()/SkillMarkdown()/SkillReferences() 自动包含
type Section struct {
	ID      string // 稳定标识（去重用；同时是参考文件名 references/<ID>.md）
	Title   string // 手册内标题（## 级）
	Summary string // 一句话摘要（SKILL.md 索引用；渐进式披露的第一层）
	Body    string // 正文（不含标题；描述端点、参数与示例；第二层细节在参考文件里）
	Order   int    // 展示顺序（小者在前；同序按 ID 稳定排序）
}

var (
	sectionMu   sync.RWMutex
	sectionRegs = map[string]Section{}
)

// RegisterSection 注册/覆盖一节（同 ID 覆盖，模块热更新语义）
func RegisterSection(s Section) {
	sectionMu.Lock()
	defer sectionMu.Unlock()
	sectionRegs[s.ID] = s
}

// RegisterSections 批量注册
func RegisterSections(ss ...Section) {
	for _, s := range ss {
		RegisterSection(s)
	}
}

// Sections 返回按 Order/ID 排序的全部分节快照
func Sections() []Section {
	sectionMu.RLock()
	defer sectionMu.RUnlock()
	out := make([]Section, 0, len(sectionRegs))
	for _, s := range sectionRegs {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// manualHeader 手册公共头部（认证/约定），非能力域分节
const manualHeader = `# Codecombo AI 操作手册

本系统（Codecombo，本地优先的轻量编码/运维工作台）把全部能力以 REST API 开放，
任何 Agent（Claude Code、dsh、DeepSeek Harness 等）可直接调用完成操作，并通过
智能操作通道（WS）接收前端联动事件。

- 认证：系统启用锁定时，所有 /api 请求需带 header ` + "`X-Lock-Token: <unlock token>`" + `
  （token 通过 POST /api/lock/unlock {"password": ...} 获取；AI 助手场景已由环境变量
  CC_LOCK_TOKEN 注入，直接使用即可）。WS 端点 /ws/* 用子协议（subprotocol）携带同一 token。
- 引导第一步（新会话/脚本启动时先确认凭据与环境，别拿业务端点试错）：
  GET /api/whoami——` + "`curl -s {{BASE}}/api/whoami -H \"X-Lock-Token: $CC_LOCK_TOKEN\"`" + `——返回
  {"tokenKind":"agent|unlock|access","version","capabilities","instance","sessions"[,"terminalId"]}；
  401=令牌失效（错误信息区分 agent/unlock 令牌族，照指重取）；instance 块=
  本实例自定位 {instanceName 登记名（缺省 host:port）, instanceId, port}——
  多机编排形态的日志归属约定：上报（ops-notify 等）带 instanceName 便于按
  实例追溯；sessions 块=会话配额 {max 单进程会话上限, current 查询时刻本进程
  存活会话数快照}——批量开会前先查余量，不足先收尾旧会话或分批创建
  （current 是瞬时快照，与他处并发创建/关闭存在竞态，创建报 too many sessions
  时仍需兜底处理）；terminalId 省略=请求头 X-Session-ID 指向的会话已不在。

## 注意事项

- 所有写操作与用户手工操作等效，请遵循最小权限与谨慎原则（高危命令先向用户确认）。
- 终端 WS 为二进制流：输入直接写字节，输出为原始 PTY 字节（含 ANSI 转义）。
- 本手册亦可作为 Skill 使用：GET /ops-manual?format=skill 返回带 front matter 的
  SKILL.md（AI 助手场景已自动安装，无需手动操作）。
`

// expandPlaceholders 渲染期占位展开：{{BASE}} = 实例入口（{{placeholder}} 语义
// 见各占位注释）；{{PRESENT_ATOMS}} = 原子能力注册表渲染的内置事件目录
// （P-20261022-3）——占位在渲染期而非 init 期展开，规避「sections_builtin.go
// 与 capabilities.go 跨文件 init 顺序」问题，也保证注册表覆盖（同 ID 重注册）
// 后取到的是最终态
func expandPlaceholders(text, baseURL string) string {
	out := strings.ReplaceAll(text, presentAtomsPlaceholder, PresentAtomsDoc())
	if baseURL != "" {
		out = strings.ReplaceAll(out, "{{BASE}}", baseURL)
	}
	return out
}

// presentAtomsPlaceholder ops-channel 节内置事件目录的占位 token
const presentAtomsPlaceholder = "{{PRESENT_ATOMS}}"

// Manual 组装完整操作手册（markdown）。baseURL 为空时正文使用相对占位说明
func Manual(baseURL string) string {
	var sb strings.Builder
	sb.WriteString(manualHeader)
	sb.WriteString("\n## 能力清单\n\n")
	for _, s := range Sections() {
		sb.WriteString("\n## " + s.Title + "\n\n")
		sb.WriteString(strings.TrimRight(s.Body, "\n"))
		sb.WriteString("\n")
	}
	return expandPlaceholders(sb.String(), baseURL)
}

// SkillRef SKILL.md 的一个分域参考文件（渐进式披露第二层）
type SkillRef struct {
	Path    string // 相对技能目录的路径，如 references/git.md
	Content string
}

// skillWorkflow SKILL.md 的公共工作流段（标记协议 + 会话自命名 + 前端联动精要——高频必需，留在第一层）
const skillWorkflow = `## 工作流约定（必读）

- 任务标记：回复最后一行必须输出且仅输出以下标记之一——
  任务全部完成 [[TASK_DONE]]；任务未完成需继续 [[TASK_PENDING]]；
  破坏性操作或关键决策需用户确认时，正文说明事项与后果后输出 [[TASK_CONFIRM]]。
- 多步任务在开始/关键节点/结束时上报进度：POST /api/ops-notify
  {"type":"task.progress","payload":{"task":"任务简称","status":"running、done 或 failed 三选一","step":"当前步骤一句话"}}。
  建议任务开始先报全量计划：payload 加 "steps":[{"name":"步骤名","done":布尔}]（≤20 项），
  之后每完成一项整包重发清单置 done=true，step 与当前项 name 一致——
  悬浮球/值班大屏会展示「共几步、完成几步」的勾选清单。
- 需要用户输入时（方案选择/缺取值）向用户提问而不是干等：
  POST /api/ops-ask {"question","options"?,"terminalId":"$CC_TERMINAL_ID"}，
  轮询 GET /api/ops-ask/<id> 取答案（无回复标记，轮询语义足够）。
- 会话自命名：接手任务后尽早重命名所在会话为任务简称（≤20 字，与 task.progress 的 task 同口径）：
  PUT /api/terminals/$CC_TERMINAL_ID/rename {"name":"任务简称"}——
  终端 tab 与会话列表靠名字区分并行任务，默认「终端 N」无辨识度。
- 驱动前端：POST /api/ops-notify 的呈现原语按「动词.目标」注册表组织——
  navigate（跳路由/文件直达/diff/面板聚焦/会话聚焦五形态）/ notify（toast 或
  notify.persist 持久条目）/ present（打开文件、文件树定位、面板、预览端口），
  给用户发链接用手册「人类深链表」按表拼勿编造；完整原子与深链表见 ops-channel
  参考文件（references/ops-channel.md）。
- 认证 header：X-Lock-Token 值取环境变量 CC_LOCK_TOKEN。
- 引导第一步：curl $CC_BASE_URL/api/whoami（同认证 header）确认令牌与环境——
  返回 tokenKind/version/capabilities/instance/sessions；401 即令牌失效，先按错误指引重取再干活。
  多机场景记得看 instance.instanceName（本实例名）：上报与日志带上它便于归属追溯。
  批量开会前看 sessions 块（max 上限 / current 存活数快照）：余量不足先收尾或分批。
- 危险操作（删除、强推、forceWithLease、部署、reset）：先向用户确认再执行。`

// SkillMarkdown 组装 SKILL.md（渐进式披露第一层：front matter + 认证 + 工作流 + 能力索引）。
// 各能力域端点细节放 references/<id>.md，Agent 按需读取——保持入口精简
func SkillMarkdown(baseURL string) string {
	var sb strings.Builder
	sb.WriteString("---\nname: codecombo-ops\ndescription: 运行在 Codecombo 工作台终端内的智能体做任何任务都适用（判据：环境变量 CC_TERMINAL_ID 或 CC_BASE_URL 存在即适用，无需用户提及本系统）；含会话自命名、进度上报等必读工作流与操作本系统的完整 API（项目/文件/设置/终端/远程主机/Git 全流程/部署/实例等）。\n---\n\n")
	sb.WriteString("# Codecombo 操作技能\n\n")
	sb.WriteString("通过 REST API 操作本系统，并经智能操作通道驱动前端界面。认证与工作流约定如下；\n各能力域的端点与参数见「能力索引」对应的参考文件，操作前先读取所需域的文件。\n\n")
	sb.WriteString("## 认证\n\n- header `X-Lock-Token: $CC_LOCK_TOKEN`（环境变量已注入）；baseURL 为 `$CC_BASE_URL`。\n  兼容期注记（P-20261025-1）：环境变量正名已由 SC_* 切换为 CC_*，服务端对 CC_*/SC_* 双写一个版本期；旧脚本若仍读 $CC_LOCK_TOKEN/$CC_BASE_URL 等旧名可继续工作，请尽早改用 CC_* 正名（兼容层移除后旧名失效）。\n\n")
	sb.WriteString(skillWorkflow)
	sb.WriteString("\n\n## 能力索引\n\n| 能力域 | 参考文件 |\n|---|---|\n")
	for _, s := range Sections() {
		summary := s.Summary
		if summary == "" {
			summary = s.Title
		}
		sb.WriteString("| " + s.Title + "（" + summary + "） | references/" + s.ID + ".md |\n")
	}
	return expandPlaceholders(sb.String(), baseURL)
}

// SkillReferences 生成各能力域参考文件（渐进式披露第二层，按需读取）
func SkillReferences(baseURL string) []SkillRef {
	refs := make([]SkillRef, 0, 8)
	for _, s := range Sections() {
		content := "# " + s.Title + "\n\n" + strings.TrimRight(s.Body, "\n") + "\n"
		refs = append(refs, SkillRef{Path: "references/" + s.ID + ".md", Content: expandPlaceholders(content, baseURL)})
	}
	return refs
}
