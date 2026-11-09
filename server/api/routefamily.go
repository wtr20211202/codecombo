package api

// 模块发现面 Routes 自动推导（P-20261003-153）。
//
// 动机：/api/modules 的 Manifest.Routes 此前在 server/app/modules.go 手工维护，
// 路由注册（router.go）与清单声明两处写，漏登只能靠发现面对账测试兜底。
// 根治：模块 → 路由能力族的归属声明收敛到**注册面**（本文件的声明表，与路由
// 同处维护），实际注册路由集由 RegisterRoutes 收口处快照，组合根组装
// Manifest.Routes 时按真实路由表推导填充——声明面从手工变推导：
//   - 既有族内新增端点：零声明动作，自动进发现面；
//   - 新族：在路由注册同文件（本表）补一行，漏登由
//     server/app/discovery_conformance_test.go 对账门禁拦截。
//
// 兼容注记：族条目保持既有粗粒度能力面前缀形态（非全量端点清单），
// /api/modules 载荷语义与 apiVersion 1.0.0 契约不变；Topics/Capabilities
// 语义宽（事件面/探测面），不做推导注记，仍由 modules.go 手工声明。

import (
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// RouteTable 实际注册路由路径全集（RegisterRoutes 收口快照，去重 + 字典序）
type RouteTable []string

// FamilyPrefix 把能力族/清单条目折算成可前缀匹配的形态：
// 截断到首个参数段（:id）或通配段（*path）之前。
// 匹配语义与发现面对账测试一致（清单是粗粒度能力面前缀，非精确路径）
func FamilyPrefix(entry string) string {
	segs := strings.Split(entry, "/")
	for i, seg := range segs {
		if strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
			return strings.Join(segs[:i], "/")
		}
	}
	return strings.TrimSuffix(entry, "/")
}

// Cover 报告能力族是否命中至少一条实际注册路由
func (t RouteTable) Cover(family string) bool {
	prefix := FamilyPrefix(family)
	for _, p := range t {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

// BuildRouteTable 在 RegisterRoutes 收口处对真实路由表做快照（去重 + 排序）。
// 每次调用独立产出（测试可重复装配），无包级可变全局（M2.2 约定）
func BuildRouteTable(r *gin.Engine) RouteTable {
	seen := make(map[string]bool, len(r.Routes()))
	out := make(RouteTable, 0, len(r.Routes()))
	for _, ri := range r.Routes() {
		if !seen[ri.Path] {
			seen[ri.Path] = true
			out = append(out, ri.Path)
		}
	}
	sort.Strings(out)
	return out
}

// moduleRouteFamilies 模块 → 路由能力族声明表（注册面唯一归属点）。
//
// 为什么放在 api 包：路由注册与归属一处写——新增端点落进既有族即自动进
// 发现面；全新族在紧邻路由注册处（本表）补一行。键是内核模块名
// （内核契约：Name 同时是 API 前缀命名空间）。族值是 gin 路径形态的
// 粗粒度能力面前缀，匹配时经 FamilyPrefix 截断参数/通配段。
//
// 推导覆盖不了的显式条目（历史兼容面 / 外部子服务面，如 /s/:token）不进
// 本表，由组合根 manifestRoutes 的 extras 登记并注明理由。
var moduleRouteFamilies = map[string][]string{
	"watch":  {"/api/watch/fallback", "/api/watch/activity"},
	"notify": {"/api/notifications", "/ws/notifications"},
	"project": {
		"/api/projects", "/api/browse",
		// 提交模板 / Changelist 项目域管理面（此前漏登，随根源治理归位）
		"/api/commit-templates", "/api/changelists",
		// 批量 ahead/behind 与一键全拉（独立路径先例；capability 项 ahead-behind-all/fetch-all 同源归属）
		"/api/ahead-behind", "/api/fetch-all",
		// 笔记库（P-20261107-5 独立化 → P-20261108-3 单库化）：项目无关的唯一
		// notepad 库（/api/notes 族，含 /api/notes/migration 续迁端点；原项目族
		// /api/projects/:id/notes(-multi) 已退役），capability 项 notes-global 同源归属
		"/api/notes",
		// 项目级主 WS 通道：file/branch/log.changed 的投递面（此前只登辅助 WS）
		"/ws/projects/:id",
	},
	"files": {
		// 实际挂载形态（projects/:id 命名空间）。历史死条目 /api/file、/api/upload
		// 指向不存在的路由，随根源治理移除
		"/api/projects/:id/file", "/api/projects/:id/dir-archive", "/api/projects/:id/trash",
		"/api/projects/:id/reveal", "/api/projects/:id/file-policy",
	},
	"update": {"/api/updates"},
	"deploy": {"/api/deploy", "/api/deploy-config", "/ws/deploy/:taskId"},
	"terminal": {
		"/api/terminals", "/ws/terminal/:id", "/api/terminal-history/search",
		// 此前漏登：agent 运行时枚举 + Claude 本地会话只读扫描面（terminalapi 包）
		"/api/agent-runtimes", "/api/claude",
	},
	"git": {
		"/api/projects/:id/*", "/api/clone", "/ws/clone/:taskId",
		// 跨项目内容搜索（独立路径规避 :id 通配符冲突）
		"/api/search",
	},
	"remote": {"/api/remotehosts", "/ws/remote-terminal/:id", "/proxy/:instanceId/*path", "/ws/proxy/:instanceId/*path"},
	// 远程接入（P-20261019-11）：SSH 反向隧道状态/启停/预检/主机指纹重置
	"remoteaccess": {"/api/remoteaccess"},
	// 此前只登记 Topics 未登 Routes（发现面白名单存量债）
	"recording": {"/api/recordings"},
	"ai": {
		"/api/ops-notify", "/api/ops-ask", "/api/ops-confirm", "/ws/ops-channel",
		// 此前漏登：agent 任务列表查询端点
		"/api/agent-tasks",
		// task.progress 最近上报快照（P-20261004-120）：前端刷新补账与 agent
		// 舰队巡检共用的只读监控原语
		"/api/ops-tasks",
	},
	// /api/system=P-20 出域总览+P-20261004-11 入口总览；/api/runbooks=P-24 运行书；
	// /api/sentinels=P-20261004-8 输出哨兵；/api/selfcheck=P-20261003-317 环境体检；
	// /api/morning-brief=P-20261005-219 开工检查单晨报
	"system": {
		"/api/settings", "/api/instances", "/api/tokens", "/api/lock", "/api/updates",
		"/api/ui-state", "/api/snippets", "/api/system", "/api/runbooks", "/api/sentinels", "/api/selfcheck",
		// 跨设备剪贴板中继（P-20261002-32）：内存单槽瞬态通道
		"/api/clip",
		// 开工检查单晨报（P-20261005-219）：跨天连续性信号只读聚合
		"/api/morning-brief",
		// 用户 UI 现场（P-20261004-52）：前端上报 + agent 读取的「用户此刻在看什么」
		"/api/ui/snapshot",
		// 凭据/令牌/审计/许可等系统管理面（此前漏登，随根源治理归位）
		"/api/credentials", "/api/sshkeys", "/api/oauth", "/api/oauth-clients",
		"/api/agent-token", "/api/audit", "/api/license",
		// CSP 违规报告收集（P-20261007-6）：浏览器上报的公开无凭据入站面，
		// 归系统安全观测族（发现面按路径前缀推导，与审计面同域）
		"/api/csp-report",
		// 入站事件 Hook（P-20261003-23）：外部事件原语（公开 sch_ 凭据即门禁）
		// + 独立凭据生命周期管理面（签发/轮换/销毁）
		"/api/hooks", "/api/hook-token",
	},
	"report":     {"/api/reports"},
	"agentcron":  {"/api/agent-crons"},
	// 多实例项目同步（P-20261023-1）：manifest/plan/pull/push/units/账本/
	// 定时任务端点族（对端能力探测 = /api/meta capabilities 的 sync 项，
	// 声明在组合根 modules.go 的 sync 模块条目）。/api/migration 同族归属：
	// 换机迁移（P-20261003-147）与 sync 共用打包/落位引擎（同一实现包），
	// 族=引擎能力面而非 URL 前缀
	"sync":       {"/api/sync", "/api/migration"},
	"compareexp": {"/api/compare-experiments"},
	"agentchain": {"/api/agent-chains"},
	// 会话间定向消息（P-20261004-68）：agent 令牌可调，ops-notify 同鉴权面
	"opsmessage": {"/api/ops-message"},
	"share":      {"/api/share"},
	// 快投递（P-20261006-51）：投递原语/收件箱管理面 + 访客投递页（公开路由，
	// token 即门禁）
	"quickdrop": {"/api/quickdrop", "/drop/:token"},
}

// RouteFamilyModules 返回声明了路由能力族的模块名集合（对账测试迭代面）
func RouteFamilyModules() []string {
	out := make([]string, 0, len(moduleRouteFamilies))
	for m := range moduleRouteFamilies {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// RouteFamilies 返回模块声明的能力族（副本语义：调用方可自由改写切片）
func RouteFamilies(module string) []string {
	families := moduleRouteFamilies[module]
	if families == nil {
		return nil
	}
	out := make([]string, len(families))
	copy(out, families)
	return out
}

// DeriveRouteFamilies 按真实路由表推导模块的发现清单：
// 声明族中命中至少一条实际路由的原样返回（保持粗粒度能力面前缀语义），
// 未命中的进 unmatched（组合根启动期 warn 后丢弃；对账测试断言其必空，
// 防声明表笔误静默缩水）。复杂度 O(族数 × 路由数)（≈60×300 次前缀比较），
// 仅组装期执行一次，非热路径
func DeriveRouteFamilies(tbl RouteTable, module string) (matched, unmatched []string) {
	for _, f := range moduleRouteFamilies[module] {
		if tbl.Cover(f) {
			matched = append(matched, f)
		} else {
			unmatched = append(unmatched, f)
		}
	}
	sort.Strings(matched)
	sort.Strings(unmatched)
	return matched, unmatched
}
