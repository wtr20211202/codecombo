// 会话时间窗溯源（P-20261007-11）：blame 行提交时刻 × 会话活跃时间窗
// [FirstAt, LastAt] 的交叉查询——「这行为什么这么写/当时和 agent 怎么商量的」
// 从人工回忆+逐个翻找回放，收敛为一次时间点查询直达对话现场。
// 数据面全部现成：transcript 首末活动时间（claudesessions.go Session）+ 项目
// 工作目录归属（Cwd/存储目录编码）；本文件只补「时间窗匹配 + 接近度排序」
// 的纯函数层，扫描与策展复用 Index.List 既有链（见 api 层 handler）。
//
// 诚实边界（提案明示）：时段关联非因果确证——同窗并行会话全部列出而非单点
// 断言，因果判断留给人；transcript 已删除的会话自然不命中（诚实缺失）。
package claudesessions

import (
	"sort"
	"time"
)

// SessionsAtLimitMax 溯源结果条数上限：悬停溯源区是「候选清单」非全量导出，
// 并行会话常态个位数，10 条封顶；超出以 truncated 如实上报（不静默丢弃）
const SessionsAtLimitMax = 10

// SessionsAtResult 时间窗命中结果。Total = 命中总数（截断前，供前端
// 「该时段活跃会话（n）」计数）；Truncated = Total 超上限只返回了前段
type SessionsAtResult struct {
	Sessions  []Session `json:"sessions"`
	Total     int       `json:"total"`
	Truncated bool      `json:"truncated"`
}

// SessionsAt 时间窗匹配：FirstAt ≤ ts ≤ LastAt 的会话按时间接近度升序取前
// limit 条。接近度 = min(|ts−LastAt|, |ts−FirstAt|)——agent 会话的提交潮多在
// 会话尾段，窗口内时刻离端点最近者优先（提案④）。同距（如 ts 与两会话端点
// 对称等距）LastAt 新者优先，输出确定。
// FirstAt 缺失（transcript 头部窗口无时间戳行，parseHead 提取不到）的会话
// 不参与匹配：窗口左沿不可知，宁可漏报不虚报「该时段活跃」。
// 活会话天然在覆盖面内（claude 运行中持续追加 transcript，mtime 即 LastAt），
// 无需另接 agentsessionmeta——transcript 已删的会话自然不命中（诚实缺失），
// 同一遍数据面覆盖两态，无第二数据源。
func SessionsAt(sessions []Session, ts time.Time, limit int) SessionsAtResult {
	if limit <= 0 {
		limit = SessionsAtLimitMax
	}
	type hit struct {
		s    Session
		dist time.Duration
	}
	hits := make([]hit, 0, 8)
	for _, s := range sessions {
		if s.FirstAt.IsZero() || ts.Before(s.FirstAt) || ts.After(s.LastAt) {
			continue
		}
		dTail := ts.Sub(s.LastAt)
		if dTail < 0 {
			dTail = -dTail
		}
		dHead := ts.Sub(s.FirstAt)
		if dHead < 0 {
			dHead = -dHead
		}
		dist := dTail
		if dHead < dist {
			dist = dHead
		}
		hits = append(hits, hit{s: s, dist: dist})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].dist != hits[j].dist {
			return hits[i].dist < hits[j].dist
		}
		return hits[i].s.LastAt.After(hits[j].s.LastAt)
	})
	total := len(hits)
	truncated := total > limit
	if truncated {
		hits = hits[:limit]
	}
	out := make([]Session, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.s)
	}
	return SessionsAtResult{Sessions: out, Total: total, Truncated: truncated}
}
