package ai

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 智能体操作审批（B4 约定式） ==============
// Agent 按 SKILL.md 工作流约定，执行高危操作前先请求确认：
//   1. POST /api/ops-confirm          —— Agent 发起（ask 走向建 pending 记录 +
//      广播 approval.pending；放行走向直接以 allowed 落库，不弹卡；deny 走向
//      直接以 denied 落库 + 广播终态。走向由全局档位 + per-op 规则表裁决，见下）
//   2. GET  /api/ops-confirm/:id      —— Agent 轮询状态（pending/allowed/denied）
//   3. POST /api/ops-confirm/:id/resolve —— 用户裁决（允许一次 / 拒绝 / 放行
//      时限三选一 session|24h|always，P-20261003-316）
// 广播经 ops-channel 到前端卡片堆与悬浮球角标；裁决结果同通道回推。
// 阶段 2（服务端强制）由 agentguard 中间件复用本存储与状态机。
//
// 全局档位 + per-op 自动裁决（P-20261003-35 + P-20261003-316）：两条审批创建
// 路径共用 config.Server.ResolveApprovalDecision——四档全局模式（ask/会话级/
// 24h/永久）短路优先（会话级仅映射内会话），再按规则表 op 前缀取首个命中
//（allow|deny|ask），无命中默认 ask = 历史行为。命中记录带 ruleHit 留审计。
// 规则表存 settings.agentApprovalRules，设置·安全分区 CRUD + 命中测试端点
//（POST /api/settings/approval-rules/test）。

// impactLimits / impactKinds：impact 结构化影响面（P-20261003-319）校验参数。
// 上限对齐「速读」定位：summary 一句话（200 rune，与拒绝理由同口径）、命令
// ≤5 条每条 200 rune；filesCount 只防负数与明显失真（上限 1e6 远超真实仓库
// 规模）。kind 枚举初版窄域六类高危——扩枚举时同步 store.ApprovalImpact 注释
// 与前端 i18n approval.impact.kind.* 标签
const (
	impactSummaryMaxRunes = 200
	impactCommandMaxLen   = 200
	impactCommandsMax     = 5
	impactFilesCountMax   = 1_000_000
)

var impactKinds = map[string]bool{
	"delete":      true, // 删除（文件/目录/分支等）
	"reset":       true, // 重置/回退（reset --hard、rollback 等）
	"push-force":  true, // 强推（push --force / --force-with-lease）
	"remote-exec": true, // 远程命令执行（SSH exec / 远程主机操作）
	"deploy":      true, // 部署
	"other":       true, // 其余高危（兜底，agent 拿不准归类时用）
}

// cleanApprovalImpact impact 载荷就地校验与清洗（控制符折叠/trim 同
// cleanApprovalReason 口径；上限超界不走钳制——提案约定坏载荷一律 400，静默
// 钳制会让 agent 误以为原文案已送达）。可选字段：nil 直接放行（未附带 = 现状
// 零破坏）；携带但任一项非法 → error（稳定码 ops.confirm_impact_invalid，
// agent 按 code 分支自纠：修正或去掉 impact 重发）。清洗就地改写入参
func cleanApprovalImpact(imp *store.ApprovalImpact) error {
	if imp == nil {
		return nil
	}
	imp.Kind = strings.TrimSpace(imp.Kind)
	if !impactKinds[imp.Kind] {
		return errors.New("invalid impact kind (delete|reset|push-force|remote-exec|deploy|other)")
	}
	imp.Summary = mask.MaskApprovalText(cleanApprovalText(imp.Summary))
	if imp.Summary == "" || len([]rune(imp.Summary)) > impactSummaryMaxRunes {
		return errors.New("invalid impact summary (1-200 chars)")
	}
	if imp.FilesCount != nil && (*imp.FilesCount < 0 || *imp.FilesCount > impactFilesCountMax) {
		return errors.New("invalid impact filesCount")
	}
	if len(imp.Commands) > impactCommandsMax {
		return errors.New("too many impact commands (max 5)")
	}
	cmds := make([]string, 0, len(imp.Commands))
	for _, cmd := range imp.Commands {
		// 命令清单是密钥最高发面（agent 摘抄的待执行命令原文），与 Target/Detail
		// 同一脱敏口径（P-20261003-197）
		cmd = mask.MaskApprovalText(cleanApprovalText(cmd))
		if cmd == "" || len([]rune(cmd)) > impactCommandMaxLen {
			return errors.New("invalid impact command (1-200 chars)")
		}
		cmds = append(cmds, cmd)
	}
	if len(cmds) > 0 {
		imp.Commands = cmds
	} else {
		imp.Commands = nil
	}
	return nil
}

// CreateAgentApproval Agent 发起确认请求
func CreateAgentApproval(c *gin.Context) {
	var req struct {
		SessionID string                `json:"sessionId"`
		Op        string                `json:"op" binding:"required"`
		Target    string                `json:"target"`
		Detail    string                `json:"detail"`
		Impact    *store.ApprovalImpact `json:"impact,omitempty"` // 结构化影响面（P-20261003-319，可选）
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeOpsPayloadInvalid, "ops confirm failed", err)
		return
	}
	req.Op = strings.TrimSpace(req.Op)
	if req.Op == "" || len(req.Op) > 128 {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmOpInvalid, "invalid op (1-128 chars)", nil)
		return
	}
	if len(req.Target) > 512 || len(req.Detail) > 2048 || len(req.SessionID) > 128 {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmFieldTooLong, "field too long", nil)
		return
	}
	// 密钥脱敏（P-20261003-197）：Target/Detail 是 agent 拼的命令语境，常带密钥
	// 原文（curl -H "Authorization: Bearer sk-…"）——入库前遮蔽，记录/卡面广播/
	// webhook 外发/轮询回显同源收敛（下游全部读同一份已脱敏记录，无第二明文面，
	// 即「audit 同源脱敏」）。放在上限校验之后：超限 400 语义零变化；遮蔽只收缩
	// 不增长，通过校验的载荷脱敏后仍在限内
	req.Target = mask.MaskApprovalText(req.Target)
	req.Detail = mask.MaskApprovalText(req.Detail)
	// impact 结构化影响面（P-20261003-319）：就地校验（枚举+上限），坏载荷 400
	// ——校验失败不落库不广播，agent 按 code 修正或去掉 impact 重发
	if err := cleanApprovalImpact(req.Impact); err != nil {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmImpactInvalid, "invalid impact payload", err)
		return
	}
	sessionID := strings.TrimSpace(req.SessionID)
	// 入队先清场（P-20261003-45）：新 pending 进卡堆前同步清扫已超时项——
	// 写路径允许副作用，且让超时行为有确定性触发点（周期清扫 10min 兜底）。
	// 审批规则临时窗口到期恢复同款双通道（P-20261003-243）：到点规则在这里
	// 物化回 ask + 通知入账，新审批按恢复后的规则表裁决
	sweepExpiredApprovals(time.Now())
	SweepExpiredRuleWindows(time.Now())
	// per-op 自动裁决（P-20261003-35）：与 agentguard 中间件共用同一判定函数
	//（config.Server.ResolveApprovalDecision）——全局放行档位（含会话级命中，
	// P-20261003-316）与 allow 规则命中同 allow 模式直落库、deny 命中直接 denied
	// 落库 + 广播终态、ask（含无规则默认）走现卡流；ruleHit 随记录留审计
	dec := config.ApprovalDecision{Effect: config.ApprovalEffectAsk}
	if cfg := store.Get().Settings.Get(); cfg != nil {
		// target 参与规则路径条件判定（P-20261004-67）：传脱敏后的 target——
		// 与入库记录同源（审计里 ruleHit 注记的路径条件与 target 字段互证）
		dec = cfg.Server.ResolveApprovalDecision(req.Op, req.Target, sessionID, time.Now())
	}
	approval := store.AgentApproval{
		ID:        store.NewAgentApprovalID(),
		SessionID: sessionID,
		Agent:     store.RuntimeForSession(sessionID),
		Op:        req.Op,
		Target:    req.Target,
		Detail:    req.Detail,
		Impact:    req.Impact,
		RuleHit:   dec.RuleHit,
		Status:    store.ApprovalPending,
		CreatedAt: time.Now(),
	}
	if dec.Effect == config.ApprovalEffectAllow {
		// 完全允许（全局模式或规则命中）：不弹卡、不广播 pending，直接落库
		// 留审计记录，Agent 轮询立即看到结果
		approval.Status = store.ApprovalAllowed
		now := time.Now()
		approval.ResolvedAt = &now
	} else if dec.Effect == config.ApprovalEffectDeny {
		// 规则 deny：直接拒绝落库（效果词汇 deny → 记录状态词汇 denied）
		approval.Status = store.ApprovalDenied
		now := time.Now()
		approval.ResolvedAt = &now
	}
	if err := store.Get().AgentApproval.Save(approval); err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops confirm failed", err)
		return
	}
	if approval.Status == store.ApprovalPending {
		// 审批创建事件统一走组合根桥（P-20261002-31）：桥内做 ops-channel
		// 广播 + 总线镜像（webhook 外发）——与 agentguard 路径同一出口，
		// 两条审批创建路径的下游语义保持一致；未装配（单测）时跳过
		if middleware.ApprovalNotifier != nil {
			middleware.ApprovalNotifier(approval)
		}
	} else if approval.Status == store.ApprovalDenied {
		// 规则 deny：无卡片可弹，广播终态让任务事件落库/多标签页审计同链路
		BroadcastApprovalResolved(approval)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": approval.ID, "status": approval.Status}})
}

// GetAgentApproval Agent 轮询审批状态
func GetAgentApproval(c *gin.Context) {
	approval, err := store.Get().AgentApproval.Get(c.Param("id"))
	if err != nil || approval == nil {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmNotFound, "ops confirm not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"id": approval.ID, "status": approval.Status,
		"op": approval.Op, "target": approval.Target, "agent": approval.Agent,
		// 结构化影响面（P-20261003-319 agent 自附；P-20261006-35 起 guarded
		// 服务端拦截路径亦可自动填充）：agent 轮询同步自知操作影响面；
		// nil=未附带未填充（旧轮询方忽略即可）
		"impact":  approval.Impact,
		"reason":  approval.Reason,  // 拒绝理由（denied 时回传，agent 据此调整方案；无理由为空串，旧轮询方忽略即可）
		"ruleHit": approval.RuleHit, // 命中的审批规则（P-20261003-35，规则 deny 时 agent 可据此理解拒绝原因；旧轮询方忽略即可）
	}})
}

// BroadcastApprovalResolved 审批终态广播（approval.resolved）：用户裁决与
// 规则 deny 同载荷形态。导出供组合根装配 middleware.ApprovalResolvedNotifier
// ——middleware 不直接依赖 api 层（import 环），规则 deny 路径经桥到此
func BroadcastApprovalResolved(a store.AgentApproval) {
	opschannel.BroadcastEvent(opschannel.EventApprovalResolved, gin.H{
		"id": a.ID, "status": a.Status, "sessionId": a.SessionID,
		"reason":  a.Reason,  // 拒绝理由随裁决事件同回传（多标签页/录制等下游消费方可选读取）
		"ruleHit": a.RuleHit, // 规则裁决时携带命中规则原文，审计/展示可选读取
	})
}

// approvalReasonMax 拒绝理由钳制（rune）：一句方案调整指引足够，与轮询响应/
// 广播同口径
const approvalReasonMax = 200

// cleanApprovalText 单行审批文本清洗：控制字符折叠为空格（单行语义，同
// sanitizeSnippetTitle 口径）+ 首尾空白裁剪——清洗不收缩 rune 数（控制符一比一
// 换空格），上限判定在清洗前后等价
func cleanApprovalText(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s))
}

// cleanApprovalReason 拒绝理由清洗：清洗 + rune 钳制（一句方案调整指引足够，
// 与轮询响应/广播同口径）
func cleanApprovalReason(s string) string {
	s = cleanApprovalText(s)
	if runes := []rune(s); len(runes) > approvalReasonMax {
		return string(runes[:approvalReasonMax])
	}
	return s
}

// ResolveAgentApproval 用户裁决（允许一次 / 拒绝 / 三档放行时限，P-20261003-316）；
// 幂等约束：仅 pending 可裁决。放行时限三选一经 horizon 字段承载（session=会话级 /
// 24h=全局带过期 / always=永久）；历史 always 字段 = always 档（兼容保留），
// 两者同传时 horizon 优先
func ResolveAgentApproval(c *gin.Context) {
	var req struct {
		Allow   *bool  `json:"allow" binding:"required"`
		Always  *bool  `json:"always,omitempty"` // 完全允许（永久档，历史字段）：后续高危操作不再询问（设置页可改回）
		Horizon string `json:"horizon,omitempty"`
		Reason  string `json:"reason,omitempty"` // 拒绝理由（可选；仅 deny 生效——回传给发起 agent 调整方案）
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeOpsPayloadInvalid, "ops confirm resolve failed", err)
		return
	}
	if req.Horizon != "" && !ValidApprovalHorizon(req.Horizon) {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmHorizonInvalid,
			"invalid horizon (session|24h|always)", nil)
		return
	}
	id := c.Param("id")
	// 与超时清扫（P-20261003-45）互斥：check-then-act（仅 pending 可裁决）
	// 在锁内完成，后到者看到终态幂等 409，不互相覆盖
	approvalResolveMu.Lock()
	approval, err := store.Get().AgentApproval.Get(id)
	if err != nil || approval == nil {
		approvalResolveMu.Unlock()
		shared.ErrorWithCode(c, shared.CodeOpsConfirmNotFound, "ops confirm not found", err)
		return
	}
	if approval.Status != store.ApprovalPending {
		approvalResolveMu.Unlock()
		shared.ErrorWithCode(c, shared.CodeOpsConfirmAlreadyResolved, "already resolved: "+approval.Status, nil)
		return
	}
	// session 档必须有会话归属（P-20261003-316）：审批记录无 sessionId 时先于
	// 状态迁移拒绝——本次裁决不生效（pending 保留），用户可改选 24h/永久
	if *req.Allow && req.Horizon == HorizonSession && approval.SessionID == "" {
		approvalResolveMu.Unlock()
		shared.ErrorWithCode(c, shared.CodeOpsConfirmHorizonInvalid,
			"horizon session requires approval sessionId", nil)
		return
	}
	if *req.Allow {
		approval.Status = store.ApprovalAllowed
	} else {
		approval.Status = store.ApprovalDenied
		approval.Reason = cleanApprovalReason(req.Reason)
	}
	now := time.Now()
	approval.ResolvedAt = &now
	// 主卡终态落库 + 挂起队列联动翻转在同一临界区（P-20261006-26 合并审批）：
	// allow→挂起条目逐条 allowed（按到达序放行，每请求一次性消费保持——各自
	// 携 X-Approval-ID 重试各自消费）；deny→全拒（同型信任一致，reason 随行）。
	// 错误映射：ErrApprovalResolved 是锁内重读的防御分支（approvalResolveMu 下
	// 正常流转不可达），与上方快照检查同口径回 409。联动条目不逐条广播
	// approval.resolved——挂起条目从未弹卡，无账可清，agent 轮询自有
	// approvalId 即见终态
	if _, err := store.Get().AgentApproval.ResolveApprovalCascade(*approval, approval.Reason, now); err != nil {
		approvalResolveMu.Unlock()
		if errors.Is(err, store.ErrApprovalResolved) {
			shared.ErrorWithCode(c, shared.CodeOpsConfirmAlreadyResolved, "already resolved", err)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "ops confirm resolve failed", err)
		return
	}
	approvalResolveMu.Unlock()
	// 放行时限档位（P-20261003-316）：horizon 三选一（会话级/24h/永久）落盘 +
	// settings.changed 广播；历史 always 字段 = 永久档同语义。落盘失败不回滚
	// 本次裁决（允许一次已生效），仅告警。session 档缺归属已在锁内先于状态
	// 迁移拒绝（走到这里必有会话归属）
	if *req.Allow {
		switch {
		case req.Horizon != "":
			ApplyApprovalHorizon(c, req.Horizon, approval.SessionID, now)
		case req.Always != nil && *req.Always:
			ApplyApprovalHorizon(c, HorizonAlways, approval.SessionID, now)
		}
	}
	BroadcastApprovalResolved(*approval)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": approval.ID, "status": approval.Status}})
}

// approvalListLimitMax limit 查询参数上限（对齐 ListAgentTasks 的 1..500 口径）：
// 历史查看场景收敛 payload；非法/越界值忽略=不截断（同任务列表宽松解析，
// 参数坏不放大为错误，只退回全量兼容形态）
const approvalListLimitMax = 500

// approvalHistoryForOpMax 同类历史查询（?historyForOp=，P-20261005-173）的回条数
// 上限：审批卡「同类历史」弱行的展示面就是最近 3 条（提案定值），服务端兜底
// 钳制——该查询面固定走全量 List 再过滤，30 天保留窗内同 op 记录可上百，不钳
// 会拉爆 payload；上限即契约，消费方无需也不应再传 limit
const approvalHistoryForOpMax = 3

// ListAgentApprovals 审批列表（诊断/管理用；最新在前）。可选查询参数
// （P-20261003-254）：status=pending|allowed|denied 按状态过滤（枚举外值 400
// ops.confirm_status_invalid——静默回全量会让调用方误读列表语义，同 impact
// kind 枚举的「坏载荷一律 400」口径）；limit=N 取最新 N 条（1..500，非法/
// 越界忽略=不截断，同 ListAgentTasks 宽松解析）。默认不传 = 全量列表（兼容
// 既有消费方）。seed 场景语义：冷启动/重连/大屏补账传 status=pending 不带
// limit —— pending 全量（裁决队列量级恒小，不随每日清理窗口内历史增长）；
// 历史查看场景传 limit 收敛 payload。同类历史查询（?historyForOp=<完整 op 串>，
// P-20261005-173）：审批卡「同类历史」弱行数据源——按完整 op 字符串精确匹配
// 回最近已裁决记录（MVP 取完整串，前缀档等真实命中量再调；大小写敏感与 op
// 原文一致——规则面的前缀大小写不敏感是裁决语义，历史对账是字面匹配）。
// 独立查询面：固定只回已裁决（pending 是「正在等的这一次」不是历史，混入会让
// 「上次怎么裁的」失真）+ 最新在前（store CreatedAt 序与列表同口径）+ 钳
// approvalHistoryForOpMax 条；不与 status/limit 组合定义语义（无消费方，组合
// 只会有误读），带该参数时二者被忽略
func ListAgentApprovals(c *gin.Context) {
	status := strings.TrimSpace(c.Query("status"))
	if status != "" &&
		status != store.ApprovalPending && status != store.ApprovalAllowed && status != store.ApprovalDenied {
		shared.ErrorWithCode(c, shared.CodeOpsConfirmStatusInvalid, "invalid status (pending|allowed|denied)", nil)
		return
	}
	limit := 0
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= approvalListLimitMax {
		limit = v
	}
	// 同类历史查询分支（P-20261005-173）：全量 List（30 天保留档天然有界）后
	// 服务端过滤——op 精确匹配 + resolved-only，取最新 approvalHistoryForOpMax 条。
	// 过滤在截断之后做不了（List 先截断会挤掉窗内更早的同 op 记录），故取全量再滤
	if historyOp := strings.TrimSpace(c.Query("historyForOp")); historyOp != "" {
		list, err := store.Get().AgentApproval.List("", 0)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "ops confirm list failed", err)
			return
		}
		history := make([]store.AgentApproval, 0, approvalHistoryForOpMax)
		for _, a := range list {
			if len(history) >= approvalHistoryForOpMax {
				break
			}
			if a.Op != historyOp {
				continue
			}
			if a.Status != store.ApprovalAllowed && a.Status != store.ApprovalDenied {
				continue
			}
			history = append(history, a)
		}
		c.JSON(http.StatusOK, gin.H{"data": history})
		return
	}
	list, err := store.Get().AgentApproval.List(status, limit)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops confirm list failed", err)
		return
	}
	// 合并审批挂起条目不出现在列表（P-20261006-26）：mergedInto 非空的 pending
	// 记录是主卡挂起队列的一员，独立渲染会破坏「一卡多请求」合并面（seed 补账
	// 会把它们重新弹成 N 张卡）——展示由主卡 Merged 清单承载。终态后照常进列
	// 表：历史/最近裁决/CSV 审计可见（limit 语义不受影响——截断在 store 层
	// 先行，过滤只可能让本页更短，不改变「最新 N 条」锚点）
	filtered := make([]store.AgentApproval, 0, len(list))
	for _, a := range list {
		if a.Status == store.ApprovalPending && a.MergedInto != "" {
			continue
		}
		filtered = append(filtered, a)
	}
	c.JSON(http.StatusOK, gin.H{"data": filtered})
}

// ListAgentTasks 任务事件历史（B6 落库视图）：?limit=50&sessionId=
func ListAgentTasks(c *gin.Context) {
	limit := 50
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}
	list, err := store.Get().AgentTask.List(limit, c.Query("sessionId"))
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent task list failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}
