package ai

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 放行时限档位（P-20261003-316）：resolve 裁决的 horizon 字段 → 全局审批档位
// 落盘 + 会话授予/到期登记。判定语义统一收敛在 config.Server.ResolveApprovalDecision
// （两条审批创建路径共用），本文件只承载写路径：档位切换、会话映射活性裁剪、
// 到期物化巡检。

// horizon 取值（resolve 请求体 horizon 字段白名单）：session=会话级放行 /
// 24h=全局放行 24 小时 / always=永久放行（历史 always 字段 = always 档，兼容保留）
const (
	HorizonSession = "session"
	Horizon24h     = "24h"
	HorizonAlways  = "always"
)

// ValidApprovalHorizon horizon 白名单（resolve 写入口校验）
func ValidApprovalHorizon(h string) bool {
	switch h {
	case HorizonSession, Horizon24h, HorizonAlways:
		return true
	}
	return false
}

// ApplyApprovalHorizon 档位落盘（审批卡三选一与设置页共语义）：horizon → mode/
// 到期/会话映射写入 + 持久化 + settings.changed 广播 + 审计入账（P-20261005-162）。
// 裁决方来源地址取 c.ClientIP()（审计「从哪个 IP」维度，与设置页写点同口径；
// P-20261006-53 起签名携 gin context——审计走 AuditAppend 中央口，rid 随请求
// 注入）。落盘失败仅告警不回滚（本次裁决已生效——与既有 always 路径同语义）。
// session 档在 sessionID 为空时不授予（resolve 入口已 400 拒绝，此处防御兜底：
// 档位仍切换，映射不动）
func ApplyApprovalHorizon(c *gin.Context, horizon, sessionID string, now time.Time) {
	ip := c.ClientIP()
	cfg := store.Get().Settings.Get()
	if cfg == nil {
		return
	}
	server := &cfg.Server
	oldMode := server.AgentApprovalModeStored()
	switch horizon {
	case HorizonSession:
		server.AgentApprovalMode = config.ApprovalModeAllowSession
		server.AgentApprovalExpiresAt = time.Time{}
		// 授予只做超限裁剪（GrantSessionAllow 内）：活性裁剪不在授予瞬间做——
		// 约定式路径的 sessionId 未必有终端元数据（curl 等外部发起方），按台账
		// 活性误判会杀掉合法授予；生命周期清理靠 CloseTerminal 即时摘除 +
		// SweepApprovalTier 周期兜底
		server.GrantSessionAllow(sessionID, now)
	case Horizon24h:
		server.AgentApprovalMode = config.ApprovalModeAllow24h
		server.AgentApprovalExpiresAt = now.Add(config.ApprovalAllow24hTTL)
	case HorizonAlways:
		server.AgentApprovalMode = config.ApprovalModeAllow
		server.AgentApprovalExpiresAt = time.Time{}
	default:
		return
	}
	// 审计入账（best-effort，Append 自带失败静默）：审批卡上的档位授予是用户
	// 显式动作，每次都记（与设置页「同值保存零入账」不同——卡面 grant 自带
	// 到期重算/会话授予副作用，重复 grant 也是新放权）。Detail 与设置页/巡检
	// 两写点同形态：old→new + 限定语（会话标识/到期时刻）
	detail := oldMode + " → " + server.AgentApprovalMode
	switch horizon {
	case HorizonSession:
		detail += " (session=" + strings.TrimSpace(sessionID) + ")"
	case Horizon24h:
		detail += " (expires " + server.AgentApprovalExpiresAt.UTC().Format(time.RFC3339) + ")"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditApprovalMode,
		Result: store.AuditResultSuccess,
		IP:     ip,
		Detail: detail,
	})
	saveAndBroadcastSettings("approval horizon applied: " + horizon)
}

// pruneDeadSessionAllows 会话级映射活性裁剪：映射内条目的会话已不在
// AgentSession 台账（已关闭 / 孤儿元数据）即摘除。台账不可读时保守不裁
// （宁留勿错杀——误裁只是多弹一次卡，错放是安全面）
func pruneDeadSessionAllows(server *config.ServerConfig) int {
	if len(server.AgentSessionAllows) == 0 {
		return 0
	}
	metas, err := store.Get().AgentSession.List()
	if err != nil {
		return 0
	}
	alive := make(map[string]bool, len(metas))
	for _, m := range metas {
		alive[m.ID] = true
	}
	removed := 0
	for id := range server.AgentSessionAllows {
		if !alive[id] {
			server.RevokeSessionAllow(id)
			removed++
		}
	}
	return removed
}

// SweepApprovalTier 档位周期巡检（ai 模块 10min ticker 复用 P-45 槽位）：
// ① allow-24h 到期物化回 ask——判定侧已惰性正确（EffectiveApprovalMode 回落），
// 这里把存储写回 + 广播 + 审计入账（P-20261005-162），让设置页/徽标不显陈旧
// 档位；② 会话级映射活性裁剪兜底（终端关闭即时摘除之外的后手）；③ 审批规则
// 临时窗口到期恢复（P-20261003-243）。有变更才落盘+广播；档位入账自带节流——
// 只在实际翻转（到期物化）那一次巡检记一条，空转巡检零入账（10min 高频巡检
// 不能变成审计噪音源）
func SweepApprovalTier(now time.Time) {
	cfg := store.Get().Settings.Get()
	if cfg == nil {
		return
	}
	server := &cfg.Server
	changed := false
	if server.AgentApprovalModeStored() == config.ApprovalModeAllow24h &&
		server.EffectiveApprovalMode(now) == config.ApprovalModeAsk {
		expiredAt := server.AgentApprovalExpiresAt
		server.AgentApprovalMode = config.ApprovalModeAsk
		server.AgentApprovalExpiresAt = time.Time{}
		changed = true
		slog.Info("approval allow-24h expired, mode reset to ask")
		// 到期回收审计（归因 system：无请求方 IP，audit.prune 同惯例）——
		// 放权窗口的闭合时刻与边界证据（原到期时刻）入账，台账才知道
		// 系统何时自动收回而非用户手动切回。24h 到期巡检是后台路径无
		// *gin.Context，走裸 Append 口（Rid 留零值，双口口径见
		// middleware.AuditAppend 注释）
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditApprovalMode,
			Result: store.AuditResultSuccess,
			Detail: "allow-24h → ask (expired " + expiredAt.UTC().Format(time.RFC3339) + ")",
		})
	}
	if server.AgentApprovalModeStored() == config.ApprovalModeAllowSession &&
		pruneDeadSessionAllows(server) > 0 {
		changed = true
	}
	if sweepExpiredRuleWindows(server, now) > 0 {
		changed = true
	}
	if changed {
		saveAndBroadcastSettings("approval tier sweep")
	}
}

// SweepExpiredRuleWindows 审批规则临时窗口到期恢复（P-20261003-243）：到点规则
// 动作物化回 ask + 清窗口 + 通知中心入账。判定侧已惰性正确
// （ResolveApprovalDecision 按到期回 ask），本巡检管存储写回、settings.changed
// 广播与知情通知。触发双通道沿 P-45「入队先清场」先例：ai 模块周期巡检
// （SweepApprovalTier，生产兜底）+ CreateAgentApproval 创建前同步清扫（写路径
// 允许副作用，让恢复行为有确定性触发点）。返回物化的规则数
func SweepExpiredRuleWindows(now time.Time) int {
	cfg := store.Get().Settings.Get()
	if cfg == nil {
		return 0
	}
	n := sweepExpiredRuleWindows(&cfg.Server, now)
	if n > 0 {
		saveAndBroadcastSettings("approval rule temp window expired")
	}
	return n
}

// sweepExpiredRuleWindows 内存态物化：临时窗口已过且动作尚非 ask 的规则改写为
// ask 并清窗口（每条到点规则入账一条通知）。effect 已是 ask 的规则不动——
// 其窗口字段无行为意义（ask 本就是中性态），留待用户编辑时自行清理
func sweepExpiredRuleWindows(server *config.ServerConfig, now time.Time) int {
	n := 0
	for i := range server.AgentApprovalRules {
		r := &server.AgentApprovalRules[i]
		if r.Effect == config.ApprovalEffectAsk || !r.TempWindowExpired(now) {
			continue
		}
		pattern := r.OpPattern
		r.Effect = config.ApprovalEffectAsk
		r.TempUntil = nil
		n++
		notifyRuleWindowExpired(pattern)
	}
	return n
}

// saveAndBroadcastSettings 档位变更收尾：持久化 + settings.changed 广播
// （多标签页徽标/设置页一致跟随，与既有 always 落盘路径同出口，载荷 nil 同款）。
// 失败仅告警
func saveAndBroadcastSettings(reason string) {
	if err := store.Get().Settings.Save(); err != nil {
		slog.Warn("agent approval mode persist failed", "err", err, "reason", reason)
		return
	}
	opschannel.BroadcastEvent(opschannel.EventSettingsChanged, nil)
}

// 规则临时窗口到期通知模板键（前端按 titleKey/bodyKey 渲染，Title/Body 原文为
// webhook 外发等无模板消费方的回退，同 approval.timeout.notify 惯例）
const (
	ruleWindowExpiredTitleKey = "approval.rules.notify.title"
	ruleWindowExpiredBodyKey  = "approval.rules.notify.body"
)

// notifyRuleWindowExpired 规则临时窗口到期的知情入账（info/system：放行/拦截
// 窗口已按约定收回，规则动作回到「询问」——用户应知悉不再有静默放行）。
// 走 store.Add 既有出站口——WS 广播 + webhook 外发共用该单点
func notifyRuleWindowExpired(pattern string) {
	store.Get().Notification.Add(notification.Notification{
		Type:     "info",
		Category: notification.CategorySystem,
		TitleKey: ruleWindowExpiredTitleKey,
		BodyKey:  ruleWindowExpiredBodyKey,
		Title:    "审批规则临时窗口已结束",
		Body:     fmt.Sprintf("%s 已到恢复时点，规则动作自动回到「询问」", pattern),
		MsgParams: map[string]any{
			"pattern": pattern,
		},
	})
}
