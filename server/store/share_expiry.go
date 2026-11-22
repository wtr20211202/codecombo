package store

import (
	"encoding/json"
	"fmt"
	"time"
)

// 分享有效期（opt-in TTL）repo 面：显式改期 + 未过滤记录的强制收敛钳制。
// P-20261119-5 从 share.go 整段迁出（体量守卫：share.go 存量超阈，永久挡增量
// 不得加深欠账——纯搬移零改写，行为语义的权威注释随各自函数走）。创建路径的
// 默认 TTL 落值仍在各自 createXxx（share.go/share_terminal.go），本文件只收
// 「按 token 改期」的写入口与其钳制。

// SetExpiry 显式调整分享的有效期（opt-in TTL，P-20261003-29 的用户入口；
// P-20261119-5 起 terminal 直播行可经管理面同端点改期）：expiresAt 零值 =
// 恢复永久。仅整记录覆写 ExpiresAt 一个字段，其余原样（含 CreatedAt/Rotate）
// ——调整有效期不是重建，短链保持不变。snippet 拒绝调整：24h 倒计时是创建
// 即定的固定安全边界（SnippetTTL），开放调整等于给短期暴露开口子；未知/
// 已撤销/已过期 → ErrNotFound（与 Rotate 同口径——已过期记录对访客面已死亡，
// 不接受借尸还魂，等清理扫走）。
// 钳制（响应回传生效值，管理面据此展示）：terminal 限时方向钳
// TerminalLiveTTLMax（永久↔限时可双向，「非显式永久不越 24h」不变量与创建面
// 对称；【用户定向修订】2026-11-19 起 unfiltered 记录的显式永久——即本请求
// 零值——同样放行，与创建面 permanent 合法一致，撤销兜底）；未过滤记录限时
// 方向仍钳 UnfilteredTTLMax（见下）。
func (r *shareRepo) SetExpiry(token string, expiresAt time.Time) (*Share, error) {
	s, err := r.Get(token)
	if err != nil {
		return nil, err
	}
	if s.Kind == ShareKindSnippet {
		return nil, fmt.Errorf("%w: snippet expiry is fixed", ErrInvalidArg)
	}
	if s.Expired(time.Now()) {
		return nil, ErrNotFound
	}
	s.ExpiresAt = expiresAt
	// 终端直播（P-20261119-5）：零值（永久）放行——unfiltered 记录同样放行
	//（【用户定向修订】：SetExpiry 对称放开，改期是显式用户动作=用户意志+
	// 撤销兜底）；显式时点越过 now+24h 钳回——与 createTerminal 的非永久
	// 分支同一上限常量（单一事实源）
	if s.Kind == ShareKindTerminal && !s.ExpiresAt.IsZero() {
		if limit := time.Now().Add(TerminalLiveTTLMax); s.ExpiresAt.After(limit) {
			s.ExpiresAt = limit
		}
	}
	// 未过滤分享（P-20261106-9）的强制短 TTL 不因显式调整失效：零值（恢复
	// 永久）与越过上限一律钳到 now+UnfilteredTTLMax——与创建路径同一钳制，
	// 「含原文快照强制短 TTL」只有一处判定；响应回传生效值，管理面据此展示。
	// 豁免面只有 terminal 直播的显式永久（零值）——本请求即用户显式动作
	//（【用户定向修订】），且直播不落盘无「原文长期滞留」面；frozen 的落盘
	// 原文维持无永久通道（创建面与改期面同口径钳 24h）
	if !(s.Kind == ShareKindTerminal && s.ExpiresAt.IsZero()) {
		clampUnfilteredExpiry(s)
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Update(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return s, nil
}

// clampUnfilteredExpiry 未过滤分享的 TTL 强制收敛（P-20261106-9）：Unfiltered
// 记录的 ExpiresAt 不得为零值（永久）也不得越过 now+UnfilteredTTLMax——冻结
// 创建路径与 SetExpiry 共用同一钳制，让「含原文快照强制短 TTL」只有一处判定
// （未过滤直播的非显式路径同样兜底钳回 24h；显式永久豁免由调用方裁定——
// createTerminal 的 Share.Permanent 置位分支与 SetExpiry 的 terminal 零值
// 分支，见【用户定向修订】2026-11-19）。
// 非 Unfiltered 记录原样不动
func clampUnfilteredExpiry(s *Share) {
	if !s.Unfiltered {
		return
	}
	limit := time.Now().Add(UnfilteredTTLMax)
	if s.ExpiresAt.IsZero() || s.ExpiresAt.After(limit) {
		s.ExpiresAt = limit
	}
}
