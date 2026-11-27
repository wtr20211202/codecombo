package shareapi

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 分享管理列表（P-20261124-1 S1⑥，自 handlers.go 迁出）：原 ListShares 是
// handlers.go（1798 行体量基线）里最长的 handler，且 2026-11-24 复盘的最大
// 嫌疑是它对项目根 os.Stat 撞上挂死共享目录——本文件单列它并给出全阶段计时。
//
// 计时口径（阶段名与 state/share-health.json 字段一一对应）：
//   - storeListMs      store.Share.List()（记录读盘/反序列化）
//   - snapshotUsageMs  share.SnapshotUsage()（持 snapMu，遍历快照目录）
//   - reconcileMs      shareSvc.ReconcileGates()（会话输入闸自愈对账，内部节流）
//   - healthMs         逐行 health（os.Stat 项目根是历史慢点）
//   - totalMs          整个 handler
//
// 生产纪律：
//   - 「最近 20 + 最慢 20」双环：前端 30s 轮询下单最近环约 10 分钟就会挤掉
//     21:37 的慢样本，最慢环保证慢调用留得住；
//   - 每次调用 item ≤100、总字节 ≤256KiB，超限标 truncated（派生文件有界）；
//   - 单条 >1s 记 WARN（带 rid/kind/snapshot/projectId/health/durationMs），
//     每次调用最多 5 条防日志洪水；
//   - 绝不记 token/path/query：projectId 是原始 UUID（不加盐/hash，egress 投影
//     已有 projectName/path 可对账，见补充评审③）。

const (
	// shareCallRingSize 双环各自的容量
	shareCallRingSize = 20
	// shareSlowItemThreshold 单条/单阶段慢阈值
	shareSlowItemThreshold = time.Second
	// shareSlowItemsPerCall 每次调用记录的慢条目上限
	shareSlowItemsPerCall = 100
	// shareSlowItemWarnsPerCall 每次调用 WARN 条数上限
	shareSlowItemWarnsPerCall = 5
	// shareCallBytesCap 双环累计近似字节上限
	shareCallBytesCap = 256 << 10
)

// ShareSlowItem 单条慢分享（无 token/无路径）
type ShareSlowItem struct {
	Kind       string `json:"kind"`
	Snapshot   bool   `json:"snapshot"`
	ProjectID  string `json:"projectId,omitempty"`
	Health     string `json:"health"`
	DurationMS int64  `json:"durationMs"`
}

// ShareCallSample 一次 ListShares 的阶段耗时
type ShareCallSample struct {
	At               string          `json:"at"`
	RID              string          `json:"rid,omitempty"`
	StoreListMS      int64           `json:"storeListMs"`
	SnapshotUsageMS  int64           `json:"snapshotUsageMs"`
	ReconcileMS      int64           `json:"reconcileMs"`
	HealthMS         int64           `json:"healthMs"`
	TotalMS          int64           `json:"totalMs"`
	Items            int             `json:"items"`
	SnapshotUsageErr bool            `json:"snapshotUsageErr,omitempty"`
	SlowItems        []ShareSlowItem `json:"slowItems,omitempty"`
	Truncated        bool            `json:"truncated,omitempty"`
}

var shareCallStats struct {
	mu      sync.Mutex
	calls   int64
	recent  []ShareCallSample
	slowest []ShareCallSample
	bytes   int
	dropped int64
	lastAt  time.Time
}

// recordShareCall 双环写入（recent 保留时间序，slowest 按 totalMs 降序）
func recordShareCall(s ShareCallSample) {
	approx := shareCallBytes(s)
	shareCallStats.mu.Lock()
	defer shareCallStats.mu.Unlock()
	shareCallStats.calls++
	shareCallStats.lastAt = time.Now()
	if shareCallStats.bytes+approx > shareCallBytesCap {
		shareCallStats.dropped++
		shareCallStats.recent[0].Truncated = true
		return
	}
	shareCallStats.bytes += approx
	if len(shareCallStats.recent) >= shareCallRingSize {
		shareCallStats.bytes -= shareCallBytes(shareCallStats.recent[0])
		copy(shareCallStats.recent, shareCallStats.recent[1:])
		shareCallStats.recent[len(shareCallStats.recent)-1] = s
	} else {
		shareCallStats.recent = append(shareCallStats.recent, s)
	}
	if len(shareCallStats.slowest) < shareCallRingSize {
		shareCallStats.slowest = append(shareCallStats.slowest, s)
	} else if s.TotalMS > shareCallStats.slowest[len(shareCallStats.slowest)-1].TotalMS {
		shareCallStats.bytes -= shareCallBytes(shareCallStats.slowest[len(shareCallStats.slowest)-1])
		shareCallStats.slowest[len(shareCallStats.slowest)-1] = s
	} else {
		return
	}
	sortSlowest(shareCallStats.slowest)
}

func sortSlowest(rows []ShareCallSample) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].TotalMS > rows[j-1].TotalMS; j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

// shareCallBytes 近似序列化字节（环内存有界，不必精确）
func shareCallBytes(s ShareCallSample) int {
	n := 128 + len(s.RID) + len(s.At)
	for _, it := range s.SlowItems {
		n += 96 + len(it.Kind) + len(it.ProjectID) + len(it.Health)
	}
	return n
}

// shareHealthDoc state/share-health.json 的顶层结构
type shareHealthDoc struct {
	Status      string            `json:"status"` // ok | absent | skipped
	Reason      string            `json:"reason,omitempty"`
	GeneratedAt string            `json:"generatedAt"`
	Calls       int64             `json:"calls"`
	Dropped     int64             `json:"dropped,omitempty"`
	Recent      []ShareCallSample `json:"recent"`
	Slowest     []ShareCallSample `json:"slowest"`
	Note        string            `json:"note"`
}

// ShareHealthStats 诊断包注入面（RuntimeInputs.ShareHealth）：从未调用过
// ListShares 写 absent 而不是空对象（reader 不用猜「0 次慢调用」还是「没采」）
func ShareHealthStats() any {
	shareCallStats.mu.Lock()
	defer shareCallStats.mu.Unlock()
	doc := shareHealthDoc{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Calls:       shareCallStats.calls,
		Dropped:     shareCallStats.dropped,
		Note: "stage timings for GET /api/share. No token/path/query is recorded; projectId is the raw project UUID for cross-checking with egress projections. " +
			"recent = last 20 calls, slowest = top 20 by totalMs (30s frontend polling would evict a single slow sample otherwise)",
	}
	if shareCallStats.calls == 0 {
		doc.Status = "absent"
		doc.Reason = "no GET /api/share call observed since process start — the management list was never opened"
		return doc
	}
	doc.Status = "ok"
	doc.Recent = append(doc.Recent, shareCallStats.recent...)
	doc.Slowest = append(doc.Slowest, shareCallStats.slowest...)
	return doc
}

// shareSnapshotKind 内容源是否快照（term-frozen/cast/session/file-frozen 归一）
func shareSnapshotKind(s store.Share) bool {
	switch s.Kind {
	case store.ShareKindTermFrozen, store.ShareKindCast, store.ShareKindSession:
		return true
	case store.ShareKindFile, "":
		return s.Frozen
	}
	return false
}

// shareKindName 审计/统计用的形态名（零值按 file）
func shareKindName(s store.Share) string {
	if s.Kind == "" {
		return string(store.ShareKindFile)
	}
	return string(s.Kind)
}

// ListShares GET /api/share —— 全部分享（短链管理视图数据源）。响应附
// frozenUsage{totalBytes,capBytes}（P-20261005-176 快照库占用——双体积护栏
// 从撞 413 才知变常透明，agent 可程序化容量治理）；有快照在盘的行（冻结
// 文件分享/终端输出快照）另带 frozenBytes = 该份快照目录字节量（找大头）。
// 统计失败不阻断列表（管理面可用性优先，仅省略投影并留痕）
//
// 健康投影（P-20261020-10）：逐行补 health（见 health.go）。列表接口不带
// 服务端分页（前端按 15 行/页切片），因此对返回行逐行判定；分享量级为手工
// 创建的个位数到十位数，且同一项目根只 stat 一次，开销可控。stat 失败按
// 异常值（target_missing/project_gone）投影，绝不让列表请求 500。
//
// 全阶段计时（P-20261124-1 S1⑥，见文件头）：慢样本进 state/share-health.json
func ListShares(c *gin.Context) {
	start := time.Now()
	rid := middleware.RequestIDFromGin(c)
	sample := ShareCallSample{At: start.Format(time.RFC3339), RID: rid}

	t := time.Now()
	list, err := store.Get().Share.List()
	sample.StoreListMS = time.Since(t).Milliseconds()
	if err != nil {
		sample.TotalMS = time.Since(start).Milliseconds()
		recordShareCall(sample)
		shared.Error(c, http.StatusInternalServerError, "list shares failed", err)
		return
	}

	t = time.Now()
	total, perToken, uerr := share.SnapshotUsage()
	sample.SnapshotUsageMS = time.Since(t).Milliseconds()
	sample.SnapshotUsageErr = uerr != nil

	health := newShareHealthProbe(store.Get())
	// 会话输入闸自愈对账（P-20261122-17）：管理面是 owner 最常触达的入口，
	// 借这次触达把残账扫掉（内部 5s 节流；DirectState 每行只做投影不重复
	// 对账）。未装配访客面（测试）零开销
	t = time.Now()
	if shareSvc != nil {
		shareSvc.ReconcileGates()
	}
	sample.ReconcileMS = time.Since(t).Milliseconds()
	sample.Items = len(list)

	healthStart := time.Now()
	out := make([]gin.H, 0, len(list))
	warns := 0
	for _, s := range list {
		itemStart := time.Now()
		h := health.health(s)
		itemDur := time.Since(itemStart)
		row := shareResponse(s)
		row["health"] = h
		if name := snapshotDirName(&s); name != "" {
			if used, ok := perToken[name]; ok {
				row["frozenBytes"] = used
			}
		}
		out = append(out, row)
		if itemDur >= shareSlowItemThreshold {
			if len(sample.SlowItems) < shareSlowItemsPerCall {
				sample.SlowItems = append(sample.SlowItems, ShareSlowItem{
					Kind: shareKindName(s), Snapshot: shareSnapshotKind(s),
					ProjectID: s.ProjectID, Health: h, DurationMS: itemDur.Milliseconds(),
				})
			} else {
				sample.Truncated = true
			}
			if warns < shareSlowItemWarnsPerCall {
				warns++
				slog.Warn("share list slow item",
					"rid", rid, "kind", shareKindName(s), "snapshot", shareSnapshotKind(s),
					"projectId", s.ProjectID, "health", h, "durationMs", itemDur.Milliseconds(),
					"listTotalMs", time.Since(start).Milliseconds())
			}
		}
	}
	sample.HealthMS = time.Since(healthStart).Milliseconds()
	sample.TotalMS = time.Since(start).Milliseconds()
	recordShareCall(sample)

	if uerr != nil {
		slog.Warn("share usage stats failed", "err", uerr)
	} else {
		c.JSON(http.StatusOK, gin.H{"data": out, "frozenUsage": gin.H{
			"totalBytes": total,
			"capBytes":   share.MaxFrozenTotalBytes,
		}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}
