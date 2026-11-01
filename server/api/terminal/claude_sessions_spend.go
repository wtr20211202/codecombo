// Claude 会话花费阈值告警（P-20261003-157）：P-20261002-139 用量聚合的
// 消费端守护——会话累计 token（input+output+cache_read）达到用户配置阈值
// （notification prefs claudeSpendAlertTokens，默认 0=关）时入账一条
// 「该收尾或接力了」通知，每会话一次（防重标记 kind claudespentalert）。
//
// 挂载点 = ListClaudeSessions 响应前：列表请求是 P-139 数据面（索引对账重扫
// 变更 transcript）唯一汇聚点，用量在此刷新为最新，恰好在此判定零额外 IO
//（阈值关闭时纯内存短路，存量零变化）；代价 = 命中会话存在时一次
// GetBatch（标记 kind 封顶 500 条，与既有 FetchCuration 全量取批同量级惯例）。
//
// 已知边界（如实注记）：判定面是本次响应页（活跃会话按最后活动倒序恒在
// 首页——「长会话该收尾」场景即活跃会话场景）；无人在场时列表无人调，
// 告警随之延迟到下次会话中心/列表被消费——通知中心 + 桌面 + webhook 三出口
// 在该时点一并触达。

package terminal

import (
	"fmt"
	"sync"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 通知中心模板键（notify.spendAlert.*，前端按 titleKey/bodyKey 渲染；
// Title/Body 原文为无模板消费方——webhook 外发、API 直读——的回退）
const (
	spendAlertTitleKey = "notify.spendAlert.done.title"
	spendAlertBodyKey  = "notify.spendAlert.done.body"
)

// spendMu check-and-mark 互斥：并发列表请求对同一超阈会话可能同时读到
// 「未标记」——入账与落标记串行化保「恰好一次」（单进程内；多实例共数据面
// 非支持形态，与通知中心等域一致）
var spendMu sync.Mutex

// notifyClaudeSpendThreshold 对列表页内超阈且未告警过的会话入账通知 + 落
// 防重标记。尽力而为：标记读失败本轮整体跳过（下轮重试，宁迟发不重发）；
// 单会话通知/标记失败不拖累其余会话与列表响应（响应路径零阻塞面）
func notifyClaudeSpendThreshold(sessions []claudesessions.Session) {
	threshold := store.Get().Notification.GetPrefs().ClaudeSpendAlertTokens
	if threshold <= 0 {
		return // 功能关（默认）：零 IO 短路
	}
	hit := false
	for i := range sessions {
		if claudesessions.SpendThresholdHit(sessions[i].Usage, threshold) {
			hit = true
			break
		}
	}
	if !hit {
		return // 无命中不取标记批：常规路径零额外 IO
	}
	root := claudesessions.Root()
	notified, err := store.Get().ClaudeSpend.GetBatch(store.ClaudeSpendAlertPrefix(root))
	if err != nil {
		return // 标记面不可读：本轮放弃（下轮列表重试），不冒险重发
	}
	spendMu.Lock()
	defer spendMu.Unlock()
	for i := range sessions {
		s := sessions[i]
		if s.Hidden {
			continue // 管理视图行（已隐藏会话）不告警
		}
		if !claudesessions.SpendThresholdHit(s.Usage, threshold) {
			continue
		}
		key := store.ClaudeSpendAlertKey(root, s.ID)
		if _, done := notified[key]; done {
			continue
		}
		notifyClaudeSpend(s, threshold)
		// 先入账后落标记：落标记失败 = 下次列表重发一条（可见的重复好过
		// 永久漏发——告警语义只有「第一次」）
		_ = store.Get().ClaudeSpend.Put(store.ClaudeSpendAlert{
			Key:        key,
			ID:         s.ID,
			Threshold:  threshold,
			NotifiedAt: time.Now(),
		})
		notified[key] = store.ClaudeSpendAlert{} // 同批内同 id 去重（理论不重复，防御性）
	}
}

// notifyClaudeSpend 单会话告警入账通知中心（warning / task 类）。tokens 按
// 精确聚合值透传（P-139 账目本就精确），Body 为语言中立明细（模板摘要行之后
// 渲染，webhook 外发原文可见），同 longSession P-20261002-140 惯例
func notifyClaudeSpend(s claudesessions.Session, threshold int) {
	tokens := int64(0)
	if s.Usage != nil {
		tokens = s.Usage.TotalTokens
	}
	store.Get().Notification.Add(notification.Notification{
		Type:     "warning",
		Category: notification.CategoryTask,
		TitleKey: spendAlertTitleKey,
		BodyKey:  spendAlertBodyKey,
		Title:    "Claude 会话花费超过阈值",
		Body:     fmt.Sprintf("%s 累计 %d tokens（阈值 %d），该收尾或接力了", s.Title, tokens, threshold),
		MsgParams: map[string]any{
			"name":      s.Title,
			"tokens":    tokens,
			"threshold": threshold,
		},
	})
}
