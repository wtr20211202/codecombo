package middleware

import (
	"path"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/mask"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 敏感写入路径窄表闸（P-20261005-235：agent 写敏感路径的事前守卫） ──
//
// 文件写入端点不在 guardedRoutes 高危表（agent 写代码是核心工作流，整体豁免
// 合理），但执行链文件写入 = 持久化任意执行且比 broadcast-write 更隐蔽：
// .git/hooks/*（提交即执行）、.git/config（改 remote URL = 凭据劫持向）、
// 项目内 .ssh/*（认证面）。本文件给这类路径加 agent 令牌的事前闸：写入请求
// 的路径参数命中窄表 → 与路由面同一套高危审批流（428 + approvalId → 轮询
// 裁决 → 携 X-Approval-ID 重试放行）；未命中照常（agent 日常工作零打扰）。
// 窄表是有意取舍——防误伤日常开发，CI 配置等项目内正常编辑对象不进表；
// 登记沿 guardedRoutes「一行一理由」维护约定（扩表不加分支）。
//
// 与事后账分工：本面是事前闸（agent 经 API 写入）；外部改动的事后账在
// 敏感读取审计（P-20261003-315）等工作台外观测面，互不替代。
// 与 P-114 批量替换的 409 敏感确认流分工：那是「确认流」（二次请求即过），
// 本面是审批闸（428 须人工裁决）——持久化执行面用强档。
//
// 模式带 **/ 前缀（`**` 吞零段故项目根自身照常命中，子模块 .git 一并覆盖）。

// sensitiveWritePattern 敏感写入路径窄表条目：pattern 为项目相对路径 glob
// （与审批规则 pathPattern 同语法同语义，经 config.MatchProjectPathGlob 匹配；
// 大小写不敏感宁多勿漏）
type sensitiveWritePattern struct {
	pattern string
	reason  string
}

var sensitiveWritePatterns = []sensitiveWritePattern{
	// git 钩子脚本随 commit/push 等动作执行——写入即持久化任意执行
	{pattern: "**/.git/hooks/**", reason: "git 钩子提交即执行（持久化任意执行面）"},
	// .git/config 可把 remote 改写成攻击者控制的 URL（push/fetch 携凭据发送
	// = 劫持向），亦可注入 hooks.path 等配置项
	{pattern: "**/.git/config", reason: "git config 改 remote URL = 凭据劫持向"},
	// SSH 认证素材（authorized_keys / 私钥）——认证面写入
	{pattern: "**/.ssh/**", reason: "SSH 认证素材（authorized_keys/私钥）"},
}

// IsSensitiveWritePath 判定项目相对路径是否命中敏感写入窄表。
// 匹配前归一：trim → 反斜杠统一正斜杠（Windows 侧 agent 常拼反斜杠）→
// path.Clean（消化 ./ 前缀、重复分隔符与 .. 段——写入入口 SafeJoinProject
// 已整体拒绝 ..，匹配器再自净一次对调用方误用保持正确）；大小写不敏感与
// IsSensitiveReadPath 同口径（.GIT/ 与 .git/ 是同类威胁，不依赖宿主文件
// 系统的大小写语义，三平台判定一致）。归一后越出项目根（../ 前缀）不匹配
// ——这类路径在写入入口本就被边界校验拒绝，不属于本闸职责
func IsSensitiveWritePath(relPath string) bool {
	_, _, ok := matchSensitiveWritePath(relPath)
	return ok
}

// matchSensitiveWritePath 归一并匹配，返回命中的窄表模式与归一路径——
// 审批卡 op/target、规则判定的 target、重试比对四者共用同一归一形态
func matchSensitiveWritePath(relPath string) (pattern, norm string, ok bool) {
	norm = normalizeWritePath(relPath)
	if norm == "" {
		return "", "", false
	}
	for _, e := range sensitiveWritePatterns {
		if config.MatchProjectPathGlob(e.pattern, norm) {
			return e.pattern, norm, true
		}
	}
	return "", "", false
}

// normalizeWritePath 归一口径（IsSensitiveWritePath 与守卫入口共用同一把尺，
// 保证「判定命中什么、审批卡上写什么、重试比对什么」三者同形）。
// 反斜杠统一用显式 ReplaceAll 而非 filepath.ToSlash：后者按宿主分隔符替换，
// 在 Linux/mac 上是恒等变换，Windows 形态反斜杠路径（agent 常拼）会在非
// Windows 宿主上漏匹配（wsl-verify 实测抓过）——守卫判定必须三平台一致，
// 与审批规则 pathPattern 的归一口径（approval_rules.go 同用 ReplaceAll）同源
func normalizeWritePath(relPath string) string {
	norm := path.Clean(strings.ReplaceAll(strings.TrimSpace(relPath), "\\", "/"))
	if norm == "." || norm == ".." || strings.HasPrefix(norm, "../") {
		return ""
	}
	return norm
}

// GuardSensitiveWritePath 文件写入 handler 在落盘前调用的唯一守卫入口：
// 相对路径命中窄表即走高危审批流（仅 sca_ 机器令牌），未命中照常。
// 返回 false = 请求已被 428/403 中止，handler 直接 return（428 语义 =
// 零副作用，未发生任何写盘）；true = 无需审批或已获放行，继续写入
func GuardSensitiveWritePath(c *gin.Context, relPath string) bool {
	pattern, norm, ok := matchSensitiveWritePath(relPath)
	if !ok {
		return true
	}
	masked := mask.MaskApprovalText(norm)
	// op 携路径（审批卡「写入敏感路径 <path>」形态）；密钥脱敏同 P-20261003-197
	// （路径段携密钥少见但 agent 可控，不落明文）。审批规则以「写入敏感路径」
	// 前缀一条覆盖整个敏感路径面，与「冲突解决」「批量替换」前缀同款约定
	op := "写入敏感路径 " + masked
	return requirePathApproval(c, op, norm, masked, pattern)
}

// requirePathApproval 项目相对路径 target 的高危审批流，与路由面（AgentGuard）
// 同型；差别在 target 形态——路由面的 target 是 /api/... URL（带路径条件的
// 规则按诚实边界跳过），本面是真项目相对路径，P-20261004-67 的 pathPattern
// 规则在此面真实生效。返回 false = 已中止
func requirePathApproval(c *gin.Context, op, normPath, maskedPath, pattern string) bool {
	// 仅机器令牌受限：用户本人（scl_ 解锁令牌）照常免审批（路由面同口径）
	if !isAgentTokenRequest(c) {
		return true
	}
	// 总开关：与路由面共用 settings.agentGuard（关闭即整个强制面含规则表不生效）
	cfg := store.Get().Settings.Get()
	if cfg == nil || !cfg.Server.AgentGuardOrDefault() {
		return true
	}
	sessionID := c.GetHeader("X-Session-ID")
	now := time.Now()
	dec := cfg.Server.ResolveApprovalDecision(op, normPath, sessionID, now)
	switch dec.Effect {
	case config.ApprovalEffectAllow:
		// 审计切面（P-20261006-45）：敏感写入面的 allow 直放行同路由面口径
		//（统一切面 auditGuardDecision，pattern 是命中的窄表 glob）
		auditGuardDecision(c, store.AuditAgentGuardAllow, store.AuditResultSuccess,
			pattern, op, normPath,
			allowAuditAttribution(dec.RuleHit, cfg.Server.EffectiveApprovalMode(now)))
		return true
	case config.ApprovalEffectDeny:
		denyApprovalRule(c, pattern, op, normPath,
			"审批规则拒绝：命中规则 "+dec.RuleHit+"（服务端强制面：敏感写入路径表 "+pattern+"）", dec.RuleHit)
		return false
	}

	// 重试路径：X-Approval-ID 已 allowed + 窗口内 + op 恰等才一次性放行。
	// op 内嵌路径 → 审批天然钉死在本路径上：拿 A 路径的 approvalId 去写 B
	// 路径会被视为无效头、重新走 428 建 B 自己的审批（路由面的放行不校验
	// op——历史语义不动；本面新代码从严起算）
	if approvalID := strings.TrimSpace(c.GetHeader("X-Approval-ID")); approvalID != "" {
		a, err := store.Get().AgentApproval.Get(approvalID)
		if err == nil && a != nil && a.Status == store.ApprovalAllowed &&
			a.ResolvedAt != nil && time.Since(*a.ResolvedAt) <= approvalPassTTL && a.Op == op {
			_ = store.Get().AgentApproval.Delete(approvalID)
			// 审计切面（P-20261006-45）：approval= 归属到一次性消费的那张卡
			auditGuardDecision(c, store.AuditAgentGuardPass, store.AuditResultSuccess,
				pattern, op, normPath, "approval="+approvalID)
			return true
		}
		// 头无效/路径不符：按未授权重试处理，继续建新审批
	}

	requireApproval428(c, pattern, op, normPath,
		"服务端强制：写入路径命中敏感写入表 "+pattern, dec.RuleHit)
	return false
}
