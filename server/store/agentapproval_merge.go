package store

// 合并审批（P-20261006-26）：AgentGuard 同类高危操作的合并审批——agent 批量
// 任务（清理 10 文件 / 多分支操作）逐个触发 428 逐卡审批是裁决轰炸，本文件把
// 「同会话 + 同 op 短窗口内的后续请求」并入首张主卡的挂起队列：一次裁决批量
// 生效，细控保留（主卡 Merged 清单展开逐条可见）。
//
// 协议零破坏：挂起条目是真实审批记录（428 + 自己的 approvalId，轮询语义与
// 一次性消费完全不变），聚合纯服务端建卡策略——不弹独立卡、不广播 pending
// （卡片更新经主卡同 id 重播，组合根装配），agent 侧无感知。
//
// 链路归属：入队（AttachMergedApproval）在 middleware 面调用；裁决联动
// （ResolveApprovalCascade）在 api/ai 的用户裁决与超时清扫两处调用。逻辑放
// store 层是因为锁——attach（middleware）与裁决（api/ai）分属两个包，共享
// 临界区只能落在公共依赖（store），否则主卡「pending 判定 → 清单追加 → 落库」
// 与「裁决翻转」之间存在把已裁决主卡写回 pending 的丢裁决竞态。

import (
	"errors"
	"sync"
	"time"
)

// ErrApprovalResolved 主卡已非 pending（ResolveApprovalCascade 锁内重读发现
// 终态）——调用方按幂等 409 处理。正常流转下裁决侧持 approvalResolveMu 不可能
// 撞见，纯防御面（锁序文档见 approvalMergeMu）
var ErrApprovalResolved = errors.New("approval already resolved")

// approvalMergeMu 合并审批临界区：串行化「主卡 pending 判定 + Merged 清单追加 +
// 落库」（attach）与「主卡终态落库 + 挂起队列翻转」（cascade）——两侧都是
// check-then-act，无锁时并发入队互相覆盖清单项、入队撞裁决可把 allowed 写回
// pending（丢裁决，agent 轮询吊死）。裁决侧（api/ai）持自身 approvalResolveMu
// 后再进本锁：锁序 approvalResolveMu → approvalMergeMu 单向无环；attach 只取
// 本锁，不构成反序
var approvalMergeMu sync.Mutex

// AttachMergedApproval 实现 AgentApprovalStore.AttachMergedApproval。
// 聚合前提（不满足即无主卡，调用方回落独立建卡）：
//   - entry.SessionID 非空——「同会话」是聚合信任边界，无会话归属的请求可能
//     来自不同 agent/项目，合并裁决等于跨源授权（宁多一张卡）
//   - 主卡 pending、MergedInto 为空（挂起条目不是潜在主卡）、同 op、
//     创建于 window 内（窗口锚定主卡创建时刻，护栏防陈旧主卡无限吸收）
//   - 主卡队列未满 maxQueued（上限护栏：第 N+1 个请求拿自己的卡，批量裁决
//     放大面有界，主卡裁决前不饿死）
//
// 多张候选主卡取最新创建（剩余聚合窗口最长，批量任务的自然延续）。
// entry 不落库即返回：入队成功时本函数负责 Save（MergedInto 已钉死），
// entry.CreatedAt 由调用方填好（与主卡 Merged 快照同源）
func (r *agentApprovalRepo) AttachMergedApproval(entry AgentApproval, window time.Duration, maxQueued int, now time.Time) (*AgentApproval, error) {
	if entry.SessionID == "" || window <= 0 || maxQueued <= 0 {
		return nil, nil
	}
	approvalMergeMu.Lock()
	defer approvalMergeMu.Unlock()
	pending, err := r.List(ApprovalPending, 0)
	if err != nil {
		return nil, err
	}
	var main *AgentApproval
	for i := range pending {
		c := &pending[i]
		if c.MergedInto != "" || c.SessionID != entry.SessionID || c.Op != entry.Op {
			continue
		}
		age := now.Sub(c.CreatedAt)
		if age < 0 || age > window || len(c.Merged) >= maxQueued {
			continue
		}
		if main == nil || c.CreatedAt.After(main.CreatedAt) {
			main = c
		}
	}
	if main == nil {
		return nil, nil
	}
	entry.MergedInto = main.ID
	if err := r.Save(entry); err != nil {
		return nil, err
	}
	main.Merged = append(main.Merged, ApprovalMergedItem{
		ID:        entry.ID,
		Target:    entry.Target, // 调用方已脱敏（MaskApprovalText），与记录同源
		CreatedAt: entry.CreatedAt,
	})
	if err := r.Save(*main); err != nil {
		return nil, err
	}
	return main, nil
}

// ResolveApprovalCascade 实现 AgentApprovalStore.ResolveApprovalCascade。
// 锁内重读主卡（denyExpiredApproval 同口径）：拿到最新 Merged 清单（裁决间隙
// 可能恰有请求入队——该请求并入的是 pending 主卡，随本次裁决一并联动，语义
// 正确），也杜绝把并发写入的清单覆写回调用方快照。挂起条目逐条 Save 失败不
// 中断（超时清扫同款口径：单条持久化故障不放大队列语义）
func (r *agentApprovalRepo) ResolveApprovalCascade(main AgentApproval, reason string, now time.Time) (int, error) {
	if main.ID == "" {
		return 0, nil
	}
	approvalMergeMu.Lock()
	defer approvalMergeMu.Unlock()
	cur, err := r.Get(main.ID)
	if err != nil {
		return 0, err
	}
	if cur == nil || cur.Status != ApprovalPending {
		return 0, ErrApprovalResolved
	}
	cur.Status = main.Status
	cur.ResolvedAt = &now
	if main.Status == ApprovalDenied {
		cur.Reason = reason // allow 恒空（P-20261003-21 语义不因联动改变）
	}
	if err := r.Save(*cur); err != nil {
		return 0, err
	}
	pending, err := r.List(ApprovalPending, 0)
	if err != nil {
		return 0, err
	}
	released := 0
	for _, a := range pending {
		if a.MergedInto != main.ID {
			continue
		}
		a.Status = cur.Status
		a.ResolvedAt = &now
		if cur.Status == ApprovalDenied {
			a.Reason = reason
		}
		if err := r.Save(a); err == nil {
			released++
		}
	}
	return released, nil
}
