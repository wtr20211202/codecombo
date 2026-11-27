package diagnostics

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

// 路由级热点聚合（P-20261126-3 S4）：reqring 只留 ≥1s/5xx/panic 的 200 条原始
// 事件——哪个接口是热点、请求量分布，包里看不到。state/routes.json 按路由模板
// （c.FullPath，与 reqring 同源）在进程内聚合 24h 窗的 count/totalMs/maxMs/4xx/5xx。
//
// 口径纪律（评审 A4）：
//   - **WS 剔除**：timeline.go 的 WS duration 是整个连接生命周期（reqring.go:46
//     明注「长连接时长不代表阻塞」）——WS 请求只计 count/4xx/5xx/wsCount，不进
//     totalMs/maxMs 榜（否则终端 WS 恒占第一）；
//   - **固定小时桶**：route × 24 桶，采样/导出时都丢过期桶——内存上界
//     64 路由 × 24 桶 × 小结构，无 unbounded 面；
//   - **sentinel 归一**：未匹配路由对齐 reqring 的 "unmatched" 语义（不写原始
//     路径——分享 token 就在路径段里），按 raw path 是否 /api/ 前缀分
//     *api-other* / *static* 两键（只记前缀布尔，不记原路径）；
//   - 快照聚合导出（非逐事件）：无 path/query，零新增隐私面。

const (
	// routesWindowHours 聚合窗口（固定小时桶）
	routesWindowHours = 24
	// routesMaxRoutes 聚合键上限（超限按 totalMs 淘汰最小者）
	routesMaxRoutes = 64
	// routeSentinelAPI / routeSentinelStatic 未匹配路由的两个 sentinel 键
	routeSentinelAPI    = "*api-other*"
	routeSentinelStatic = "*static*"
	// routeSentinelUnmatched reqring 的 sentinel 名（注释/文档对齐用，不直接
	// 作为本文件的聚合键——上文两个键各携带 api/static 前缀轨）
	routeSentinelUnmatched = "unmatched"
)

// routeHourBucket 单路由单小时桶（小结构；24h × 64 路由上界 ≈ 1536 个）
type routeHourBucket struct {
	count    int
	wsCount  int
	count4xx int
	count5xx int
	totalMs  int64 // 非 WS 请求才累计（WS 时长是连接生命周期，不代表阻塞）
	maxMs    int64
}

// routeAggKey 未匹配路由的 sentinel 归一：reqring 用单一 "unmatched"，本聚合
// 按前缀分两轨以便 agent 判断「未登记的 API 面」还是「静态/外部扫描」。只看
// /api/ 前缀布尔，绝不保留原始路径。
func routeAggKey(route, rawPath string) string {
	if route != "" && route != routeSentinelUnmatched {
		return route
	}
	if strings.HasPrefix(rawPath, "/api/") || rawPath == "/api" {
		return routeSentinelAPI
	}
	return routeSentinelStatic
}

// routeHourOf unix 小时桶键
func routeHourOf(now time.Time) int64 { return now.Unix() / 3600 }

type routesRing struct {
	mu     sync.Mutex
	routes map[string]map[int64]*routeHourBucket
}

var routesState = &routesRing{routes: map[string]map[int64]*routeHourBucket{}}

// RecordRouteSample 记一条请求进聚合（middleware.RequestTimeline 的 defer 里调用，
// 复用同一次耗时读取——不新造计时中间件，P-20261124-1 S1① 中间件顺序不动）。
// 热路径成本：一次路由 map 查找 + 一次小时桶 map 查找 + 几个字段累加；仅在
// 「新路由/新小时桶」时分配。WS 只计次不计时长。
func RecordRouteSample(route, rawPath string, status, durationMS int64, ws bool) {
	key := routeAggKey(route, rawPath)
	hour := routeHourOf(time.Now())
	routesState.mu.Lock()
	defer routesState.mu.Unlock()
	buckets, ok := routesState.routes[key]
	if !ok {
		// 新键且已满：淘汰 totalMs 最小者（热点路由天然不会被挤掉）
		if len(routesState.routes) >= routesMaxRoutes {
			routesState.evictMinLocked()
		}
		buckets = map[int64]*routeHourBucket{}
		routesState.routes[key] = buckets
	}
	b := buckets[hour]
	if b == nil {
		// 顺带清理过期桶（小时翻转时才发生，摊销 O(该路由桶数)）
		for h := range buckets {
			if hour-h >= routesWindowHours {
				delete(buckets, h)
			}
		}
		b = &routeHourBucket{}
		buckets[hour] = b
	}
	b.count++
	if ws {
		b.wsCount++
	}
	if status >= 400 && status < 500 {
		b.count4xx++
	}
	if status >= 500 {
		b.count5xx++
	}
	if !ws {
		b.totalMs += durationMS
		if durationMS > b.maxMs {
			b.maxMs = durationMS
		}
	}
}

// evictMinLocked 淘聚合 24h totalMs 最小的路由（调用方持锁；≤64 键 × ≤24 桶）
func (r *routesRing) evictMinLocked() {
	minKey := ""
	var minTotal int64
	for key, buckets := range r.routes {
		var total int64
		for _, b := range buckets {
			total += b.totalMs
		}
		if minKey == "" || total < minTotal {
			minKey = key
			minTotal = total
		}
	}
	if minKey != "" {
		delete(r.routes, minKey)
		routesDropped++
	}
}

// routeRow routes.json 单行（24h 窗聚合；totalMs/maxMs 为非 WS 口径）
type routeRow struct {
	Route    string `json:"route"`
	Count    int    `json:"count"`
	WSCount  int    `json:"wsCount,omitempty"`
	Count4xx int    `json:"count4xx,omitempty"`
	Count5xx int    `json:"count5xx,omitempty"`
	// TotalMS 非 WS 请求总耗时（WS 连接时长不入——不代表阻塞）
	TotalMS int64 `json:"totalMs"`
	// MaxMS 非 WS 请求最大耗时
	MaxMS int64 `json:"maxMs"`
	// AvgMS = TotalMS / (Count-WSCount)（WS 不计入；全 WS 时 0）
	AvgMS int64 `json:"avgMs,omitempty"`
	// Sentinels 注记：*api-other*/*static* 两键是 reqring "unmatched" 的分轨
	Sentinel bool `json:"sentinel,omitempty"`
}

// routesDoc state/routes.json 顶层结构
type routesDoc struct {
	GeneratedAt string     `json:"generatedAt"`
	Status      string     `json:"status"` // ok | skipped
	Reason      string     `json:"reason,omitempty"`
	WindowHours int        `json:"windowHours"`
	RouteLimit  int        `json:"routeLimit"`
	Count       int        `json:"count"`
	Rows        []routeRow `json:"rows"`
	Dropped     int64      `json:"dropped,omitempty"`
	Note        string     `json:"note"`
}

// routesDropped 被淘汰的路由键计数（可观测性：热点榜满了没有）
var routesDropped int64

// RoutesSnapshot 聚合快照（CLI 形态 status=skipped——本环活在每个进程的内存里，
// CLI 采集进程的环对被诊断的服务毫无意义，如实 skipped 不装 0）
func RoutesSnapshot(now time.Time, source string) routesDoc {
	doc := routesDoc{
		GeneratedAt: now.Format(time.RFC3339),
		Rows:        []routeRow{},
		WindowHours: routesWindowHours,
		RouteLimit:  routesMaxRoutes,
		Note: "route-level aggregation over a 24h window (fixed hourly buckets, expired buckets dropped); " +
			"route is c.FullPath() — the same template as requests.json; WS connections count toward count/" +
			"status codes but NOT totalMs/maxMs (a WS duration is the whole connection lifetime, not blocking); " +
			"*api-other*/*static* are the two tracks of unmatched routes (requests.json writes the single " +
			"sentinel \"unmatched\" for the same requests); no path/query is ever recorded",
	}
	if source == "cli" {
		doc.Status = "skipped"
		doc.Reason = "route aggregation lives inside the service process; offline CLI collection has no request traffic to aggregate"
		return doc
	}
	routesState.mu.Lock()
	defer routesState.mu.Unlock()
	if len(routesState.routes) == 0 {
		doc.Status = "ok"
		doc.Count = 0
		doc.Note = "aggregation is empty (service just started, or no traffic in the window) — " + doc.Note
		return doc
	}
	doc.Status = "ok"
	doc.Dropped = routesDropped
	curHour := routeHourOf(now)
	rows := make([]routeRow, 0, len(routesState.routes))
	for key, buckets := range routesState.routes {
		row := routeRow{Route: key}
		kept := false
		for h, b := range buckets {
			if curHour-h >= routesWindowHours {
				delete(buckets, h) // 读时丢过期桶
				continue
			}
			kept = true
			row.Count += b.count
			row.WSCount += b.wsCount
			row.Count4xx += b.count4xx
			row.Count5xx += b.count5xx
			row.TotalMS += b.totalMs
			if b.maxMs > row.MaxMS {
				row.MaxMS = b.maxMs
			}
		}
		if !kept {
			// 全桶过期：路由整键清掉，不出零值行（零值行会被误读成「有流量但全 0」）
			delete(routesState.routes, key)
			continue
		}
		if nonWS := row.Count - row.WSCount; nonWS > 0 {
			row.AvgMS = row.TotalMS / int64(nonWS)
		}
		row.Sentinel = key == routeSentinelAPI || key == routeSentinelStatic
		rows = append(rows, row)
	}
	// 按 totalMs 降序（热点榜口径）
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].TotalMS != rows[j].TotalMS {
			return rows[i].TotalMS > rows[j].TotalMS
		}
		return rows[i].Route < rows[j].Route // 稳定次序（并列按字典序）
	})
	doc.Count = len(rows)
	doc.Rows = rows
	return doc
}

// renderRoutesJSON state/routes.json 渲染
func renderRoutesJSON(now time.Time, source string) string {
	buf, err := json.MarshalIndent(RoutesSnapshot(now, source), "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// ResetRoutesForTesting 清空聚合环（仅测试用）
func ResetRoutesForTesting() {
	routesState.mu.Lock()
	routesState.routes = map[string]map[int64]*routeHourBucket{}
	routesDropped = 0
	routesState.mu.Unlock()
}
