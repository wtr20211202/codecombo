package middleware

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/mask"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// ── Agent Guard（B4 阶段 2：服务端强制审批） ──
//
// 阶段 1（约定式）依赖 Agent 自觉遵守 SKILL.md；本中间件把「高危操作需审批」
// 变成服务端硬约束：持 sca_ 智能体令牌的请求命中高危路由时，强制建 pending
// 审批并返回 428（Precondition Required）+ approvalId，Agent 轮询 allowed 后
// 带 X-Approval-ID 头重试放行（一次性消费）。
//
// per-op 自动裁决（P-20261003-35）：与 CreateAgentApproval 共用
// config.Server.ResolveApprovalDecision——规则 allow 命中直放行（不建审批）、
// deny 命中 403 直接拒绝（denied 审计记录 + 终态广播，不经卡流）、ask（含
// 无命中默认）走上述现行审批流；全局放行档位短路优先（P-20261003-316：永久/
// 24h 对全部会话生效，会话级仅 X-Session-ID 命中放行映射的会话）。
//
// 豁免：scl_ 解锁令牌（用户本人 UI 操作）不受限——强制面只针对机器令牌；
// settings.agentGuard=false 可整体关闭（默认开，关闭即整个强制面含规则表不生效）。
//
// 高危路由表（维护约定：新增高危端点在 guardedRoutes 加一行并写明理由；
// op 描述用于审批卡片展示与规则前缀匹配）。

type guardedRoute struct {
	pattern string // gin FullPath 模式（:参数形式）
	method  string
	op      string // 审批卡片展示的操作摘要
}

var guardedRoutes = []guardedRoute{
	{"/api/projects/:id/push", http.MethodPost, "git push"},
	{"/api/projects/:id/reset", http.MethodPost, "git reset"},
	// 交互式 rebase 计划执行：一次批量改写多条提交历史（重排/squash/drop/reword），
	// 与 push/reset 同级的历史改写面（P-20261003-324）
	{"/api/projects/:id/rebase/interactive", http.MethodPost, "交互式变基（改写提交历史）"},
	// 冲突解决写族（P-20261004-30）：整文件 ours/theirs 一把梭会静默丢弃另一侧
	// 全部改动（数据丢失级）；合成写回同为「决定文件最终内容」的裁决关口。
	// 两条 op 同以「冲突解决」为前缀——审批规则一条前缀即覆盖整个冲突解决族。
	// 读面（GET conflicts/conflicts/content/conflicts/parsed）不设防：agent 看到
	// 冲突清单与逐块解析正是它按规范先问用户偏好的前提。仅拦 agent 令牌，
	// 用户 UI（冲突面板逐块解决）走解锁令牌照常免审批
	{"/api/projects/:id/conflicts/resolve", http.MethodPost, "冲突解决（整文件采用我方/他方）"},
	{"/api/projects/:id/conflicts/resolve-content", http.MethodPost, "冲突解决（自定义内容写回）"},
	{"/api/projects/:id/branches", http.MethodDelete, "删除分支"},
	{"/api/projects/:id/clean", http.MethodPost, "git clean"},
	{"/api/projects/:id/reflog/reset", http.MethodPost, "reflog reset"},
	{"/api/projects/:id/files/delete", http.MethodPost, "删除文件"},
	// 文件批量操作（P-20261006-39）：单请求批量 move/delete/rename 的裁决关口
	// ——此前批量只能逐条走单文件端点（delete 在本表，N 条目 N 张审批卡裁决
	// 碎片化），批量面以「一次审批覆盖整批」收口。op 文案按请求体 action 细化
	// （batchFileOpLabel）：delete 形态取「删除文件（批量 N 个）」保既有
	// 「删除文件」前缀——审批规则前缀匹配（ResolveApprovalDecision）存量规则
	// 零失效；move/rename 形态是新前缀（单条面本就不设防，批量整理作为 agent
	// 原语纳入审批面；move 与 rename 同为 os.Rename 写面，一并设防防改道绕过）。
	// 表内静态 op「批量文件操作」是细化失败（读体失败/形态未知）时的回落
	{"/api/projects/:id/files/batch", http.MethodPost, "批量文件操作"},
	// 批量替换（P-20261004-114）：一次调用改写 N 个文件的内容，与冲突解决
	// 写回同级的「决定文件最终内容」裁决关口（op 以「批量替换」为前缀，规则
	// 一条前缀即覆盖 preview 之外整个替换面——preview 是纯读不设防）
	{"/api/projects/:id/replace", http.MethodPost, "批量替换（跨文件内容改写）"},
	// 替换历史还原（P-20261004-66）：checkout+apply 把替换过的文件回滚到替换
	// 前现场，与替换执行同级的批量写裁决关口（history 清单是读面不设防）
	{"/api/projects/:id/replace/history/:hid/restore", http.MethodPost, "批量替换还原（跨文件内容回滚）"},
	{"/api/projects/:id", http.MethodDelete, "删除项目"},
	{"/api/remotehosts/:id/exec", http.MethodPost, "远程命令执行"},
	{"/api/remotehosts/:id/files/delete", http.MethodPost, "删除远程文件"},
	{"/api/remotehosts/:id", http.MethodDelete, "删除远程主机"},
	{"/api/remotehosts", http.MethodPost, "添加远程主机"},
	{"/api/deploy/run", http.MethodPost, "远程部署"},
	{"/api/credentials/:id", http.MethodDelete, "删除凭据"},
	{"/api/sshkeys/:id", http.MethodDelete, "删除 SSH Key"},
	{"/api/instances/:id", http.MethodDelete, "删除实例"},
	// 向终端写入 = 任意命令执行面（P-20261003-288 广播输入一次可打 N 个会话；
	// P-20261005-11 起 ids 含远程主机终端——对面 shell 同样任意命令，同表同防，
	// 无需新增路由表项）。op 文案以「终端广播输入」为前缀扩展：审批规则按 op
	// 前缀匹配，存量规则零失效
	{"/api/terminals/broadcast-write", http.MethodPost, "终端广播输入（本地+远程终端）"},
	// 排队指令 = 延迟的终端输入（P-20261003-248：完成回执驱动写会话 PTY）——
	// 入队（busy 空闲即即时发送）与整表替换（改写他日自动发送的内容）同防
	{"/api/terminals/:id/queue", http.MethodPost, "排队会话指令（自动写入终端）"},
	{"/api/terminals/:id/queue", http.MethodPut, "编辑会话排队指令（自动写入终端）"},
	// 接管会话服务端只读闸解锁（P-20261008-17）：解锁 = 放开对用户 tmux 会话
	//（可能正跑 deploy/生产脚本）的写入，与广播输入同级的安全敏感方向——
	// agent 不得未经审批绕过接管会话的默认只读。op 以「只读闸解锁」为前缀，
	// 规则前缀匹配与审批卡共用。locked=true（上锁）是加固方向，经 body 感知
	// 豁免直放行（AgentGuard 内 terminalInputLockAction，同 remoteaccess stop 先例）
	{"/api/terminals/:id/input-lock", http.MethodPut, "接管会话只读闸解锁（放开写入）"},
	// 远程接入隧道（P-20261020-1）：start 把本实例经 SSH 反向隧道暴露到
	// 公网，暴露面不低于 git push/删除文件——持 agent token 的智能体不得
	// 未经审批把实例推到公网。**body 感知**：action=stop 是降险动作（关闭
	// 公网暴露），直接放行；start/切换（start 带另一 profileId）与缺失/
	// 未知 action 一律走审批（失败闭合）。档案写入仍走 settings，但隧道
	// 启动必须过本关口——「agent 私自暴露」的防线在运行态而非配置面。
	{"/api/remoteaccess/tunnel", http.MethodPost, "远程接入隧道（公网暴露）"},
	// 多实例同步推送（P-20261023-1）：一次调用把本端项目/上下文批量写到对端
	// 文件系统（覆盖/新增面与批量替换同级，且跨机生效）——pull 侧落位是
	// 本端文件写族（既有文件写面纪律覆盖），push 写对端无既有表项故单列。
	// op 以「同步推送」为前缀，审批规则一条前缀即覆盖整个推送面
	{"/api/sync/push", http.MethodPost, "同步推送（批量写对端实例文件）"},
	// 换机迁移导入应用（P-20261003-147）：一次调用批量改写凭据/实例注册表/
	// 系统设置/agent 令牌（apply 票据面）——高价值变更面与同步推送同级设防。
	// 导出（凭据批量出域）与预览（只读解密分析）不入表：导出口令是请求体
	// 必填的人工动作、agent 手册登记「引导用户到设置界面」而非代操作；
	// preview 无写副作用。op 以「迁移导入」为前缀，规则一条前缀覆盖
	{"/api/migration/import/apply", http.MethodPost, "迁移导入应用（批量改写凭据/实例/设置）"},
	// 手动携密同步仪式面（P-20261024-3）：三端点都是凭据出域/入域链的人类
	// 裁决关口——配对钥轮换（携密信任根变更）、指纹核对确认（解锁携密路径）、
	// 暂存终审（真正把密钥写进本机 store）。携密推送/拉取本体已有
	// /api/sync/push 高危表与 pull 落地的本地写面纪律，这里把「让携密成为
	// 可能」的控制面收进审批——agent 手册登记纯人工纪律（引导用户操作而非
	// 代触发）。op 以「携密」为前缀，规则一条前缀覆盖三端点
	{"/api/sync/pairing/:instanceId/generate", http.MethodPost, "携密配对密钥轮换（E2E 信任根变更）"},
	{"/api/sync/credentials/verify", http.MethodPost, "携密同步指纹核对确认（解锁携密路径）"},
	{"/api/sync/credentials/staged/:ticket/resolve", http.MethodPost, "携密接收确认（密钥落盘终审）"},
}

// ApprovalNotifier 审批创建后的通知回调（组合根装配为 ops-channel 广播）。
// 包级变量 + 模块 Init/组合根赋值是本仓库既有装配模式（同 git.broadcastFn），
// middleware 不直接依赖 api 层以避免 import 环
var ApprovalNotifier func(store.AgentApproval)

// ApprovalResolvedNotifier 审批规则 deny 终态广播回调（组合根装配为
// approval.resolved 广播，P-20261003-35）：deny 不产生 pending 卡片，走终态
// 出口让任务事件落库/多标签页审计与人工裁决同链路（未装配时静默跳过）
var ApprovalResolvedNotifier func(store.AgentApproval)

// ApprovalUpdatedNotifier 主卡挂起队列更新通知（P-20261006-26 合并审批，组合根
// 装配为 approval.pending 同 id 重播）：入队成功后重播携带最新 Merged 清单的
// 主卡，前端按 id 幂等 upsert 原地更新「+N 同型待批」徽标。刻意只走 ops-channel
// 广播、不经组合根的总线旁路——webhook 外发只在首卡推一次，N 条入队不放大
// 手机推送（否则成了裁决轰炸的声音/推送版）。未装配（单测）静默跳过
var ApprovalUpdatedNotifier func(store.AgentApproval)

// ImpactFiller guarded 服务端拦截审批的 impact 自动填充回调（P-20261006-35，
// 组合根装配——同 ApprovalNotifier 先例，middleware 不直接依赖 api 层避免
// import 环）。guarded 拦截建的审批此前恒无结构化影响面（审批卡退化为静态
// op 文案），本回调让服务端按守卫模式单方填充有可靠数据的操作（agent 不附
// 也在的兜底，与 P-191 agent 自愿预检自附互补）。参数：pattern 守卫模式
// （guardedRoutes 的 gin FullPath 形态 / 敏感写入表的 glob）、op 审批 op
// 文案、target 请求目标原文（未脱敏 URL 路径或项目相对路径——返回值 Summary
// 必须是服务端构造的计数/静态文案，不得回填 target 原文，落盘面另有
// mask.MaskApprovalText 收口）、lang 请求 Accept-Language 头值（摘要双语，
// defaultSessionNumberedName 同款 zh 系中文其余英文约定）。
// 返回 nil = 本路由无可靠影响面数据，降级既有无徽标卡形态；调用侧
// （fillApprovalImpact）对 panic 兜底——impact 计算失败不阻塞审批创建
var ImpactFiller func(pattern, op, target, lang string) *store.ApprovalImpact

// fillApprovalImpact 影响面自动填充（P-20261006-35）：装配缺失/计算失败
// （panic 兜底归一）一律降级 nil——impact 是知情增强面，不为它放大审批
// 创建路径的失败面（428 流程照旧，卡片回退无徽标老形态）
func fillApprovalImpact(pattern, op, target, lang string) (imp *store.ApprovalImpact) {
	if ImpactFiller == nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			imp = nil
		}
	}()
	return ImpactFiller(pattern, op, target, lang)
}

// approvalPassTTL 一次性放行窗口：allowed 后须在该时间内完成重试
const approvalPassTTL = 5 * time.Minute

// 合并审批护栏（P-20261006-26）：
//   - approvalMergeWindow 聚合窗口（锚定主卡创建时刻）：窗口内的同会话同 op
//     请求入主卡挂起队列，超窗回落独立卡——批量任务跨分钟级推进时后续请求
//     自成一批，陈旧主卡不无限吸收（也保证主卡裁决前每条挂起请求都年轻，
//     超时清扫的 TTL 有意义）
//   - approvalMergeQueueMax 单主卡挂起队列上限：超过即回落独立卡——批量裁决
//     的放大面有界（一次放行至多 20 个同型请求），且第 21 个请求不被饿死
const (
	approvalMergeWindow   = 60 * time.Second
	approvalMergeQueueMax = 20
)

// AgentGuard gin 中间件：注册于需要强制的路由组之上（全局 api 组）
func AgentGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 非高危路由直接放行
		route, ok := matchGuarded(c.Request.Method, c.FullPath())
		if !ok {
			c.Next()
			return
		}
		// 仅机器令牌受限：取不到 sca_ 令牌 = 用户本人（scl_）或豁免链路
		if !isAgentTokenRequest(c) {
			c.Next()
			return
		}
		// 总开关（默认开）
		cfg := store.Get().Settings.Get()
		if cfg == nil || !cfg.Server.AgentGuardOrDefault() {
			c.Next()
			return
		}
		// 远程接入隧道 body 感知豁免（P-20261020-1）：stop 是降险动作（关闭
		// 公网暴露），agent 可自主执行；start（含切换）与缺失/未知 action 走
		// 下方审批。读体后原样回填，审批重试路径的 handler 仍能解析 JSON。
		if route.pattern == "/api/remoteaccess/tunnel" && tunnelControlAction(c) == "stop" {
			c.Next()
			return
		}
		// 终端输入锁 body 感知豁免（P-20261008-17）：locked=true 是加固动作
		// （收紧接管会话服务端只读闸），agent 可自主执行；locked=false（解锁=
		// 放开写入）与缺失/解析失败一律走下方审批（失败闭合）。读体后原样
		// 回填，审批重试路径的 handler 仍能解析 JSON（tunnelControlAction 同款）
		if route.pattern == "/api/terminals/:id/input-lock" && terminalInputLockAction(c) == "lock" {
			c.Next()
			return
		}
		// per-op 自动裁决（P-20261003-35 + P-20261003-316）：与 CreateAgentApproval
		// 共用同一判定函数（config.Server.ResolveApprovalDecision）——全局放行
		// 档位短路优先（永久/未过期 24h 对全部会话；会话级仅映射内会话，规则
		// 不评估）、规则 allow 命中直放行、deny 命中直接拒绝、ask（含无规则默认）
		// 走下方现行审批流。op 先经形态细化（P-20261006-39 批量文件端点按请求体
		// action/条目数取具体文案，规则前缀匹配与审批卡共用细化后的 op）
		op := route.op
		if label := batchFileOpLabel(c, route.pattern); label != "" {
			op = label
		}
		now := time.Now()
		dec := cfg.Server.ResolveApprovalDecision(op, c.Request.URL.Path, c.GetHeader("X-Session-ID"), now)
		// target 形态注记（P-20261004-67）：本面 target 是 /api/... URL——非项目
		// 相对路径形态，带路径条件的规则在此按未命中跳过（诚实边界：路径规则
		// 只在 agent 主动上报项目相对路径 target 的 ops-confirm 面生效）
		switch dec.Effect {
		case config.ApprovalEffectAllow:
			// 审计切面（P-20261006-45）：allow 直放行不再静默——规则命中记
			// rule=、全局档位短路记 tier=，push/reset 等无 handler 审计的端点
			// 由此覆盖，「agent 经 allow 通道做了哪些高危操作」事后可回答
			auditGuardDecision(c, store.AuditAgentGuardAllow, store.AuditResultSuccess,
				route.pattern, op, c.Request.URL.Path,
				allowAuditAttribution(dec.RuleHit, cfg.Server.EffectiveApprovalMode(now)))
			c.Next()
			return
		case config.ApprovalEffectDeny:
			denyByRule(c, op, route, dec.RuleHit)
			return
		}

		// 重试路径：携带 X-Approval-ID 且已 allowed、未消费、窗口内 → 一次性放行
		if approvalID := strings.TrimSpace(c.GetHeader("X-Approval-ID")); approvalID != "" {
			a, err := store.Get().AgentApproval.Get(approvalID)
			if err == nil && a != nil && a.Status == store.ApprovalAllowed &&
				a.ResolvedAt != nil && time.Since(*a.ResolvedAt) <= approvalPassTTL {
				// 一次性消费：改状态防重放（复用 denied 位次标记 consumed 语义？
				// 不引入新状态——直接删除该审批记录，重试需重新申请）
				_ = store.Get().AgentApproval.Delete(approvalID)
				// 审计切面（P-20261006-45）：审批通过的机器放行也留痕——
				// approval= 归属到具体哪张卡的一次性消费
				auditGuardDecision(c, store.AuditAgentGuardPass, store.AuditResultSuccess,
					route.pattern, op, c.Request.URL.Path, "approval="+approvalID)
				c.Next()
				return
			}
			// 头无效：按未授权重试处理（继续走 428 建新审批，错误信息提示）
		}

		// 建 pending 审批并广播卡片（agent 反查会话运行时，卡片展示智能体类型）。
		// 终端输入类路由附影响面证据（P-20261005-191）：把将写入 PTY 的命令串过
		// 一遍高危模式表，命中即把模式摘要附进审批卡 detail——人裁决「终端广播
		// 输入/排队指令」时多一屏知情，而不是只见「任意命令执行面」的笼统警示
		detail := "服务端强制：智能体令牌请求高危端点 " + route.pattern
		if s := terminalInputRiskSummary(c, route.pattern); s != "" {
			detail += "；" + s
		}
		// 删除项目路由附级联影响证据（P-20261006-36）：驻留智能体会话计数入卡，
		// agent 删前自知将波及的会话面（与前端确认框计数同口径）
		if s := projectDeleteImpactSummary(c, route.pattern); s != "" {
			detail += "；" + s
		}
		requireApproval428(c, route.pattern, op, c.Request.URL.Path, detail, dec.RuleHit)
	}
}

// ── 统一审计切面（P-20261006-45） ──
//
// AgentGuard 强制面（路由级高危表 + 敏感写入路径窄表，agentguard_sensitivewrite.go）
// 此前三个出口无审计台账留痕：allow 直放行（规则命中 / 全局档位短路）、
// denyByRule（仅审批域 denied 记录，不入审计台账）、审批通过重试（X-Approval-ID
// 一次性消费）——428 建卡路径之外的放行/拒绝事后不可回答，规则 allow 配置后
// agent 的每次 push/reset 完全静默（P-35「allow 直落库语义」在路由面的落地）。
// 三出口统一落一条 agentguard.* 审计；与 handler 自审计（branch/creds/file 等）
// 双留不删，语义分层：切面记 actor=agent 裁决维度（经哪条裁决通道通过哪个
// 高危关口），handler 记操作结果细节。高危操作天然低频（428 在前拦住了高频面）
// + Append 尽力而为（auditlog.go），审计不阻塞裁决与请求路径

// auditGuardDecision 切面单点：action ∈ AuditAgentGuard* 三值，result 随出口
// （放行 success / deny denied）。pattern 为强制面模式（路由面 gin FullPath /
// 敏感写入面 glob），target 为请求目标原文（统一经密钥脱敏 P-20261003-197，
// Append 层 MaskAuditDetail 兜底再守一道）；attribution 为裁决归属段
// （"rule=…" / "tier=…" / "approval=…"，空串省略）。Detail 语言中立 key=value
// 元数据：actor=agent 与 handler 自审计（用户动作）区分，session/agent 让
// agent 按自身 sessionId 经既有 GET /api/audit 自查高危操作史（查询面复用
// 不新增；清单一律翻页拉取后按 Detail 段过滤，服务端 List 面不支持参数过滤）。
// 经 AuditAppend 中央口（rid 自动注入，P-20261006-53——无请求上下文调用点
// 不存在，本切面恒有 gin context）
func auditGuardDecision(c *gin.Context, action, result, pattern, op, target, attribution string) {
	sessionID := c.GetHeader("X-Session-ID")
	detail := "actor=agent" +
		" route=" + pattern +
		" op=" + op +
		" target=" + mask.MaskApprovalText(target) +
		" session=" + sessionID +
		" agent=" + store.RuntimeForSession(sessionID)
	if attribution != "" {
		detail += " " + attribution
	}
	AuditAppend(c, store.AuditEvent{
		Action: action,
		Result: result,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// allowAuditAttribution allow 出口的归属段：规则命中记 rule=（P-35 设计意图
// 兑现——allow 规则的每次放行可追认），档位短路记 tier=（全局/会话级放行模式
// 的诚实注记，EffectiveApprovalMode 已含 24h 过期回 ask 的判定）
func allowAuditAttribution(ruleHit, mode string) string {
	if ruleHit != "" {
		return "rule=" + ruleHit
	}
	return "tier=" + mode
}

// terminalInputRiskSummary 终端输入类高危路由（broadcast-write / queue）的
// 影响面证据：请求体里的命令串（data / text / entries[].text 三形态）过
// server/terminal 高危模式表，命中返回一行摘要。只读请求体并原样回填——
// 审批重试（X-Approval-ID 放行）路径的下游 handler 还要读体；非终端输入类
// 路由、读体失败、非 JSON、无命中一律返回空串（证据增强不改变审批语义）
func terminalInputRiskSummary(c *gin.Context, pattern string) string {
	switch {
	case pattern == "/api/terminals/broadcast-write",
		strings.HasPrefix(pattern, "/api/terminals/:id/queue"):
	default:
		return ""
	}
	if c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) == 0 || len(raw) > maxGuardBodyBytes {
		return ""
	}
	var req struct {
		Data    string `json:"data"`
		Text    string `json:"text"`
		Entries []struct {
			Text string `json:"text"`
		} `json:"entries"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return ""
	}
	cmds := make([]string, 0, 1+len(req.Entries))
	if req.Data != "" {
		cmds = append(cmds, req.Data)
	}
	if req.Text != "" {
		cmds = append(cmds, req.Text)
	}
	for _, e := range req.Entries {
		if e.Text != "" {
			cmds = append(cmds, e.Text)
		}
	}
	var hits []terminal.RiskMatch
	for _, cmd := range cmds {
		hits = append(hits, terminal.MatchCommandRisk(cmd)...)
	}
	return terminal.RiskSummary(hits)
}

// maxGuardBodyBytes 证据提取读体上限：超过即放弃提取（证据是增强面，
// 不为超载荷放大中间件内存）
const maxGuardBodyBytes = 64 * 1024

// projectDeleteImpactSummary 删除项目高危路由（DELETE /api/projects/:id）的
// 级联影响证据（P-20261006-36）：审批卡 detail 附项目绑定会话数与驻留智能体
// 会话数（kind=agent 免项目绑定但工作目录在项目内，terminal.ResidentAgentSessions
// 识别）——agent 删前自知影响面、人裁决多一屏知情，与前端删除确认框计数同
// 口径。证据是增强面：非删除项目路由、项目已不存在、零影响一律空串，不改变
// 审批语义。
func projectDeleteImpactSummary(c *gin.Context, pattern string) string {
	if pattern != "/api/projects/:id" {
		return ""
	}
	p, err := store.Get().Project.GetByID(c.Param("id"))
	if err != nil || p == nil {
		return ""
	}
	bound := 0
	for _, s := range terminal.DefaultManager.ListSessions() {
		if s.ProjectID == p.ID {
			bound++
		}
	}
	resident := len(terminal.DefaultManager.ResidentAgentSessions(p.Path))
	return projectDeleteImpactText(p.Name, bound, resident, c.Query("closeAgentSessions") == "1")
}

// projectDeleteImpactText 级联影响摘要文案（计数入参与文案组装分离，表驱动
// 单测无需向 DefaultManager 注活会话——单测惯例不起真实 PTY）。零影响空串
func projectDeleteImpactText(name string, bound, resident int, closeRequested bool) string {
	if bound == 0 && resident == 0 {
		return ""
	}
	s := fmt.Sprintf("级联影响（项目 %s）：将终止 %d 个项目绑定会话；驻留智能体会话 %d 个", name, bound, resident)
	if closeRequested {
		s += "（已请求一并关闭）"
	} else {
		s += "（默认保留）"
	}
	return s
}

// batchOpBodyBytes 批量文件端点 op 细化的读体上限：与 handler 侧
// batchBodyMaxBytes（1MB）对齐再留 JSON 编码富余——op 细化参与规则前缀
// 匹配（删除文件（批量 N 个）），不是纯增强面，读体上限须覆盖全部合法
// 请求形态；仍超限（超护栏载荷）才回落静态 op（不按猜测的 action 前缀
// 误配规则）
const batchOpBodyBytes = (1 << 20) + (16 << 10)

// batchFileOpLabel 批量文件操作端点（/api/projects/:id/files/batch，P-20261006-39）
// 的 op 文案细化：请求体 action + 条目数 →
//
//	delete → 「删除文件（批量 N 个）」——保既有「删除文件」前缀，审批规则
//	         前缀匹配（ResolveApprovalDecision）下存量规则零失效
//	move   → 「批量移动文件（N 个）」
//	rename → 「批量改名文件（N 个）」
//	copy   → 「批量复制文件（N 个）」（P-20261023-2：与 move 同为 os 级写面，
//	         一并设防防改道绕过）
//
// 只读请求体并原样回填——审批重试（X-Approval-ID 放行）路径的下游 handler
// 还要读体（terminalInputRiskSummary 同款）；非本路由、读体失败、非 JSON、
// action 未识别一律返回空串（回落 guardedRoutes 静态 op「批量文件操作」，
// 安全侧按无命中走 ask 建卡）
func batchFileOpLabel(c *gin.Context, pattern string) string {
	if pattern != "/api/projects/:id/files/batch" || c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) == 0 || len(raw) > batchOpBodyBytes {
		return ""
	}
	var req struct {
		Action  string            `json:"action"`
		Entries []json.RawMessage `json:"entries"` // move/delete 形态是字符串数组，只数条数不解释形态
		Renames []json.RawMessage `json:"renames"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return ""
	}
	n := len(req.Entries)
	if req.Action == "rename" {
		n = len(req.Renames)
	}
	if n <= 0 {
		return "" // 空批次：条目数无意义，回落静态 op（handler 侧会以 400 拒绝）
	}
	switch req.Action {
	case "delete":
		return fmt.Sprintf("删除文件（批量 %d 个）", n)
	case "move":
		return fmt.Sprintf("批量移动文件（%d 个）", n)
	case "rename":
		return fmt.Sprintf("批量改名文件（%d 个）", n)
	case "copy":
		return fmt.Sprintf("批量复制文件（%d 个）", n)
	}
	return ""
}

// tunnelControlBodyBytes 隧道控制端点读体上限：请求体只有 action/profileId/
// confirmInsecureTls 三字段，4KB 足够且远小于 handler 可接受载荷；超限按
// 「action 未知」处理（继续审批，失败闭合）
const tunnelControlBodyBytes = 4 << 10

// tunnelControlAction 读取 POST /api/remoteaccess/tunnel 的 action 并归一
// （小写去空白），供 AgentGuard 做 stop 豁免判定（P-20261020-1）。只读请求
// 体并原样回填——审批重试（X-Approval-ID 放行）与 stop 直过两条路径的下游
// handler 都还要 ShouldBindJSON（batchFileOpLabel 同款）。非本路由、读体
// 失败、非 JSON、空 action 一律返回空串（= 按未知 action 继续审批）。
func tunnelControlAction(c *gin.Context) string {
	if c.Request == nil || c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) == 0 || len(raw) > tunnelControlBodyBytes {
		return ""
	}
	var req struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(req.Action))
}

// inputLockBodyBytes 输入锁端点读体上限：请求体只有 locked 一个布尔字段，
// 4KB 足够且远小于 handler 可接受载荷；超限按「方向未知」处理（继续审批，
// 失败闭合——tunnelControlBodyBytes 同款）
const inputLockBodyBytes = 4 << 10

// terminalInputLockAction 读取 PUT /api/terminals/:id/input-lock 的 locked
// 方向并归一（"lock"/"unlock"），供 AgentGuard 做加固方向直放行判定
// （P-20261008-17）。只读请求体并原样回填——审批重试（X-Approval-ID 放行）
// 与 lock 直过两条路径的下游 handler 都还要 ShouldBindJSON（tunnelControlAction
// 同款）。非本路由、读体失败、非 JSON、locked 缺失一律返回空串（= 方向未知
// 继续审批，失败闭合）。
func terminalInputLockAction(c *gin.Context) string {
	if c.Request == nil || c.Request.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(c.Request.Body)
	_ = c.Request.Body.Close()
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) == 0 || len(raw) > inputLockBodyBytes {
		return ""
	}
	var req struct {
		Locked *bool `json:"locked"`
	}
	if json.Unmarshal(raw, &req) != nil || req.Locked == nil {
		return ""
	}
	if *req.Locked {
		return "lock"
	}
	return "unlock"
}

// requireApproval428 建 pending 审批并广播卡片，随后 428 中止请求——路由面
// （AgentGuard）与敏感写入路径面（agentguard_sensitivewrite.go）共用尾部。
// pattern 为触发守卫的模式（路由面 gin FullPath / 敏感写入表 glob），供
// ImpactFiller 按模式分发（P-20261006-35）；target 统一经密钥脱敏
// （P-20261003-197：路径段携密钥少见但 agent 可控，不落明文）；persist
// 失败 500 中止。ruleHit 非空 = 规则 ask 命中（P-35），该请求不进合并
// 审批聚合——规则是用户显式配置的逐单裁决意图（allow/deny 规则本就不产
// 生卡，不受影响）
func requireApproval428(c *gin.Context, pattern, op, target, detail, ruleHit string) {
	sessionID := c.GetHeader("X-Session-ID")
	approval := store.AgentApproval{
		ID:        store.NewAgentApprovalID(),
		SessionID: sessionID,
		Agent:     store.RuntimeForSession(sessionID),
		Op:        op,
		Target:    mask.MaskApprovalText(target),
		Detail:    detail,
		// 影响面自动填充（P-20261006-35）：服务端拦截路径按守卫模式单方填充
		// 有可靠数据的操作（初批删除项目），无数据/计算失败降级 nil 老卡形态。
		// 填充先于落盘——记录/广播卡/轮询三个下游同源读到同一份 impact
		Impact:    fillApprovalImpact(pattern, op, target, c.GetHeader("Accept-Language")),
		Status:    store.ApprovalPending,
		CreatedAt: time.Now(),
	}
	// 合并审批（P-20261006-26）：同会话+同 op 短窗口内已有 pending 主卡时本
	// 请求入其挂起队列——不建新卡（主卡携带 Merged 清单经 UpdatedNotifier 同
	// id 重播），仍返回 428+自己的 approvalId（轮询/一次性消费语义零变化）。
	// 无会话归属不聚合（同会话是信任边界）；入队失败（扫描/落库错误）回落
	// 独立建卡，聚合是增强面不做硬依赖
	if ruleHit == "" {
		if main, err := store.Get().AgentApproval.AttachMergedApproval(approval, approvalMergeWindow, approvalMergeQueueMax, time.Now()); err == nil && main != nil {
			if ApprovalUpdatedNotifier != nil {
				ApprovalUpdatedNotifier(*main)
			}
			shared.AbortWithCode(c, shared.CodeOpsApprovalRequired, gin.H{
				"error":      "approval required: poll GET /api/ops-confirm/<approvalId> until allowed, then retry with X-Approval-ID header",
				"approvalId": approval.ID,
				"status":     approval.Status,
			})
			return
		}
	}
	if err := store.Get().AgentApproval.Save(approval); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "approval persist failed"})
		c.Abort()
		return
	}
	if ApprovalNotifier != nil {
		ApprovalNotifier(approval)
	}
	shared.AbortWithCode(c, shared.CodeOpsApprovalRequired, gin.H{
		"error":      "approval required: poll GET /api/ops-confirm/<approvalId> until allowed, then retry with X-Approval-ID header",
		"approvalId": approval.ID,
		"status":     approval.Status,
	})
}

// matchGuarded 方法 + FullPath 模式匹配（FullPath 不含查询参数，稳定）
func matchGuarded(method, fullPath string) (guardedRoute, bool) {
	for _, r := range guardedRoutes {
		if r.method == method && r.pattern == fullPath {
			return r, true
		}
	}
	return guardedRoute{}, false
}

// denyByRule 审批规则 deny（路由面入口）：403 直接拒绝——Agent 无需轮询，
// 也不会产生可放行的审批卡。op 由调用方传入（经批量文件形态细化，与规则
// 命中时的评估口径一致）；target/detail 组装后落 denyApprovalRule 共用核
// （敏感写入路径面同源，P-20261005-235）
func denyByRule(c *gin.Context, op string, route guardedRoute, ruleHit string) {
	denyApprovalRule(c, route.pattern, op, c.Request.URL.Path,
		"审批规则拒绝：命中规则 "+ruleHit+"（服务端强制面 "+route.pattern+"）", ruleHit)
}

// denyApprovalRule 审批规则 deny 共用核：落一条 denied 审批记录（带 ruleHit，
// target 统一经密钥脱敏 P-20261003-197）+ 广播终态，请求 403 直接拒绝；
// 审计切面（P-20261006-45）同点落一条 agentguard.deny（裁决维度入审计台账，
// 与审批域 denied 记录双留分工）。落库失败不阻断拒绝（拒绝本身是内存态决策）
func denyApprovalRule(c *gin.Context, pattern, op, target, detail, ruleHit string) {
	sessionID := c.GetHeader("X-Session-ID")
	now := time.Now()
	approval := store.AgentApproval{
		ID:         store.NewAgentApprovalID(),
		SessionID:  sessionID,
		Agent:      store.RuntimeForSession(sessionID),
		Op:         op,
		Target:     mask.MaskApprovalText(target), // 密钥脱敏同 P-20261003-197
		Detail:     detail,
		RuleHit:    ruleHit,
		Status:     store.ApprovalDenied,
		CreatedAt:  now,
		ResolvedAt: &now,
	}
	// 审计切面（P-20261006-45）：无条件先于审批域落库——deny 决策已成立，
	// 审批记录持久化失败只影响审批域台账（广播跳过），审计台账独立留痕
	auditGuardDecision(c, store.AuditAgentGuardDeny, store.AuditResultDenied,
		pattern, op, target, "rule="+ruleHit)
	if err := store.Get().AgentApproval.Save(approval); err != nil {
		// 审计缺失可容忍，拒绝语义不受影响
		slog.Warn("approval rule deny persist failed", "err", err)
	} else if ApprovalResolvedNotifier != nil {
		ApprovalResolvedNotifier(approval)
	}
	shared.AbortWithCode(c, shared.CodeOpsApprovalDenied, gin.H{
		"error":      "denied by approval rule (ruleHit: " + ruleHit + ")",
		"approvalId": approval.ID,
		"ruleHit":    ruleHit,
	})
}

// isAgentTokenRequest 请求是否持 sca_ 智能体令牌（header 或 WS 子协议槽位）。
// 仅机器令牌受限——用户本人的 scl_ 解锁令牌不受审批约束
func isAgentTokenRequest(c *gin.Context) bool {
	token := ExtractLockToken(c.Request)
	if token == "" {
		return false
	}
	if strings.HasPrefix(token, "sca_") {
		return true
	}
	return store.Get().AgentToken.Validate(token)
}
