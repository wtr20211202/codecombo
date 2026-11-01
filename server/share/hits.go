package share

import (
	"log/slog"
	"sync"
	"time"
)

// HitCounter 访客面访问计数聚合器（P-20261002-14）：
//
// 计数口径 = 页面打开（GET /s/{token} 命中有效分享）+ 下载启动（doDownload）；
// 一次性分享（P-20261020-3）例外：只记显式确认（POST /s/{token}/view）——
// 未确认 GET 只出确认页，预览抓取不污染计数；刷新/同窗重开不重复计数。
// meta/list/render/raw 等子资源取数不计——访客打开一次页面会连发多个子请求，
// 逐请求计数会把「被看过几次」虚高数倍，指标失去「链接还在不在被传播」的
// 判读价值。HEAD 是探测不是「被看」，一律不计。
//
// 写路径两段式：Count 只做互斥下的内存 map 自增（纳秒级，访客响应路径零
// 磁盘 I/O——第一版实现同步写盘曾破坏访客响应面，重批实现以此为大前提）；
// 攒下的增量由装配层（shareapi Module）经内核调度器定时 Flush 批量落盘
// （store.Share.RecordHits）。冲刷串行化（flushMu）防两批并发 RMW 互相
// 丢增量；落盘失败（记录已撤销/已轮换/已过期 → ErrNotFound，或存储故障）
// 丢弃该条并留日志——计数是尽力而为的旁路指标，不回灌重试（存储持续故障
// 时回灌会让内存无界增长，违背降级初衷）
type HitCounter struct {
	mu      sync.Mutex
	flushMu sync.Mutex
	pending map[string]int64
}

// NewHitCounter 构造聚合器（零值不可用，须经此构造）
func NewHitCounter() *HitCounter {
	return &HitCounter{pending: make(map[string]int64)}
}

// Count 记一次命中（访客响应路径内调用，只动内存）
func (h *HitCounter) Count(token string) {
	if h == nil || token == "" {
		return
	}
	h.mu.Lock()
	h.pending[token]++
	h.mu.Unlock()
}

// Flush 把攒下的增量批量落盘（apply 即 store.Share.RecordHits），返回成功
// 落盘的命中次数。装配层定时调用；Module.Stop 再调一次兜底（停机窗口内
// 的计数不丢）。apply 为 nil 时直接清空（测试/关停场景）
func (h *HitCounter) Flush(apply func(token string, n int64, at time.Time) error, logger *slog.Logger) int {
	if h == nil {
		return 0
	}
	h.flushMu.Lock()
	defer h.flushMu.Unlock()
	h.mu.Lock()
	if len(h.pending) == 0 {
		h.mu.Unlock()
		return 0
	}
	batch := h.pending
	h.pending = make(map[string]int64)
	h.mu.Unlock()

	now := time.Now()
	applied := 0
	for token, n := range batch {
		if apply == nil {
			continue
		}
		if err := apply(token, n, now); err != nil {
			if logger != nil {
				// token 打摘要不打全值（P-20261002-95）——同包 TokenSummary
				logger.Warn("share hit flush skipped", "token", TokenSummary(token), "hits", n, "err", err)
			}
			continue
		}
		applied += int(n)
	}
	return applied
}
