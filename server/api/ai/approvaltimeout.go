package ai

// pending 审批等待超时自动拒绝（P-20261003-45）。
//
// 动机：pending 审批无 TTL——会话活着但没人裁决时 agent 轮询吊死、会话假死
//（完成提醒永远不来）；既有清理只删「发起会话已死」的 30 天陈记录，活会话
// 的吊死审批无人管。TTL 可配（settings.agentApprovalTimeoutMin，分钟数，
// 0=不限保持存量行为），到期自动置 denied：
//   - 拒绝理由走 P-21 通道（Reason 字段，轮询/广播回传给发起 agent 调整方案）
//   - approval.resolved 广播（与用户裁决同载荷形状，前端卡片堆一致清账）
//   - 通知中心入账（warning/system，带跳转发起会话的 terminal Action）
//
// 清扫点位两处：ai 模块 10min 周期清理（生产兜底，TTL 到期检测延迟上界
// TTL+10min）+ CreateAgentApproval 创建前同步清扫（写路径允许副作用——
// 「入队先清场」，新 pending 进卡堆前先清掉已到期项，也让到期行为可被
// 确定性触发）。agentguard 中间件路径的审批不经创建口，仅由周期清扫覆盖。
//
// 竞态幂等：用户裁决与超时清扫共享 approvalResolveMu，后到者看到的必是
// 终态记录——用户侧重复裁决 409（既有约束），清扫侧重读后幂等跳过。

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// approvalResolveMu 裁决互斥锁：ResolveAgentApproval（用户裁决）与超时清扫
// （扫描置 denied）串行化——两侧都是「读状态→仅 pending 可写终态」的
// check-then-act，无锁时存在互相覆盖窗口（毫秒级但真实存在）
var approvalResolveMu sync.Mutex

// 超时自动拒绝的拒绝理由（P-21 通道原文，agent 轮询据此知悉未被人工否决）；
// 通知模板键（approval.timeout.notify.*，前端按 titleKey/bodyKey 渲染，
// Title/Body 原文为 webhook 外发等无模板消费方的回退，同 longSession 惯例）
const (
	approvalTimeoutReason   = "超时自动拒绝"
	approvalTimeoutTitleKey = "approval.timeout.notify.title"
	approvalTimeoutBodyKey  = "approval.timeout.notify.body"
)

// approvalTimeoutTTL 当前配置的超时时长（0=不限）。读设置文档存储——设置页
// 写入即生效（下个清扫点读取），无需重启
func approvalTimeoutTTL() time.Duration {
	if cfg := store.Get().Settings.Get(); cfg != nil && cfg.Server.AgentApprovalTimeoutMin > 0 {
		return time.Duration(cfg.Server.AgentApprovalTimeoutMin) * time.Minute
	}
	return 0
}

// approvalExpired 纯函数：审批是否已超时待拒（TTL 关闭恒 false——存量行为）
func approvalExpired(a store.AgentApproval, ttl time.Duration, now time.Time) bool {
	return ttl > 0 && a.Status == store.ApprovalPending && now.Sub(a.CreatedAt) >= ttl
}

// sweepExpiredApprovals 扫描 pending 审批，超时者置 denied + 广播 + 通知入账，
// 返回本次置 denied 的条数。List 快照逐条处理，单条失败告警不中断（其余照扫）
func sweepExpiredApprovals(now time.Time) int {
	ttl := approvalTimeoutTTL()
	if ttl <= 0 {
		return 0
	}
	// 只扫 pending（超时判定仅对 pending 生效）：status 过滤收口在 store 层，
	// 与全量后逐条判等价，快照集合更小且意图自文档（P-20261003-254）
	list, err := store.Get().AgentApproval.List(store.ApprovalPending, 0)
	if err != nil {
		slog.Warn("approval timeout sweep list failed", "err", err)
		return 0
	}
	denied := 0
	for _, a := range list {
		if !approvalExpired(a, ttl, now) {
			continue
		}
		if denyExpiredApproval(a, now) {
			denied++
		}
	}
	return denied
}

// denyExpiredApproval 单条超时置 denied。锁内重读确认仍 pending：List 快照
// 可能陈旧（用户恰在此间隙裁决），后到者幂等跳过。终态落库与挂起队列联动
// 同临界区（P-20261006-26）：主卡超时 → 其合并审批挂起条目同步拒绝（挂起
// 请求轮询自有 approvalId 即见终态，不逐条广播不逐条通知——主卡这一条
// 通知已覆盖整批知情）
func denyExpiredApproval(a store.AgentApproval, now time.Time) bool {
	approvalResolveMu.Lock()
	defer approvalResolveMu.Unlock()
	cur, err := store.Get().AgentApproval.Get(a.ID)
	if err != nil || cur == nil || cur.Status != store.ApprovalPending {
		return false
	}
	cur.Status = store.ApprovalDenied
	cur.Reason = approvalTimeoutReason
	cur.ResolvedAt = &now
	if _, err := store.Get().AgentApproval.ResolveApprovalCascade(*cur, cur.Reason, now); err != nil {
		slog.Warn("approval timeout deny failed", "id", cur.ID, "err", err)
		return false
	}
	// 与用户裁决同载荷形状（id/status/sessionId/reason）：前端卡片堆按
	// resolved 事件清账，多标签页一致移除
	opschannel.BroadcastEvent(opschannel.EventApprovalResolved, gin.H{
		"id": cur.ID, "status": cur.Status, "sessionId": cur.SessionID,
		"reason": cur.Reason,
	})
	notifyApprovalTimeout(*cur)
	return true
}

// notifyApprovalTimeout 超时拒绝知情入账通知中心（warning/system：操作未执行、
// agent 将收到拒绝理由，用户应知悉）。通知走 store.Add 既有出站口——WS 广播 +
// webhook 外发（warning 落 important 范围）共用该单点。跳转 Action 复用通知
// 中心 terminal 语义指向发起会话（前端经「激活会话」原语路由，agent 会话归
// 智能体面板）；无发起会话（约定式发起未带 sessionId）省略 Action。
// 等待时长按分钟取整展示，与配置粒度一致
func notifyApprovalTimeout(a store.AgentApproval) {
	minutes := int(a.ResolvedAt.Sub(a.CreatedAt).Minutes())
	if minutes < 1 {
		minutes = 1
	}
	n := notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		TitleKey: approvalTimeoutTitleKey,
		BodyKey:  approvalTimeoutBodyKey,
		Title:    "审批等待超时，已自动拒绝",
		Body:     fmt.Sprintf("%s %s · %d min", a.Op, a.Target, minutes),
		MsgParams: map[string]any{
			"op":      a.Op,
			"target":  a.Target,
			"minutes": minutes,
		},
		// 发起方运行时透传（P-20261003-187）：审批记录天然带 Agent（创建时经
		// RuntimeForSession 反查），通知中心据此出 runtime 过滤 chips；未知为空
		// 时留空 = 无归属不受过滤
		Runtime: a.Agent,
	}
	if a.SessionID != "" {
		n.Action = "terminal"
		n.ActionPayload = a.SessionID
	}
	store.Get().Notification.Add(n)
}
