package metrics

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// 轻量指标出口（Prometheus 文本格式）：
//   - Counter：单调递增计数（请求总数、总线事件数、时长累计）
//   - Gauge：可增减的瞬时值（in-flight、WS 连接数、goroutine 数）
//
// 设计取向：零依赖（不引 prometheus client）、按需注册（首次使用即注册）、
// 标签支持有限维度（method/route/status/topic 这类低基数值）。
// 出口：GET /api/metrics（受全局锁保护）。

type seriesKey struct {
	name   string
	labels string // 预渲染的 {k="v",...}（插入时排序，保证稳定）
}

type series struct {
	kind  string // "counter" | "gauge"（首次注册即定，先到先得）
	value int64
}

var (
	mu      sync.RWMutex
	series_ = make(map[seriesKey]*series)
	started = time.Now()
)

// buildLabels 渲染标签串：键值对按 key 排序，形如 {method="GET",status="200"}
func buildLabels(kv ...string) string {
	if len(kv) == 0 {
		return ""
	}
	type pair struct{ k, v string }
	pairs := make([]pair, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		pairs = append(pairs, pair{kv[i], kv[i+1]})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].k < pairs[j].k })
	var b strings.Builder
	b.WriteByte('{')
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "%s=%q", p.k, p.v)
	}
	b.WriteByte('}')
	return b.String()
}

func getOrCreate(kind, name, labels string) *series {
	key := seriesKey{name, labels}
	mu.RLock()
	s, ok := series_[key]
	mu.RUnlock()
	if ok {
		return s
	}
	mu.Lock()
	defer mu.Unlock()
	if s, ok = series_[key]; ok {
		return s
	}
	s = &series{kind: kind}
	series_[key] = s
	return s
}

// IncCounter 计数器 +1
func IncCounter(name string, labels ...string) { AddCounter(name, 1, labels...) }

// AddCounter 计数器累加（语义上应为非负增量）
func AddCounter(name string, delta int64, labels ...string) {
	s := getOrCreate("counter", name, buildLabels(labels...))
	mu.Lock()
	s.value += delta
	mu.Unlock()
}

// SetGauge 瞬时值直接赋值
func SetGauge(name string, v int64, labels ...string) {
	s := getOrCreate("gauge", name, buildLabels(labels...))
	mu.Lock()
	s.value = v
	mu.Unlock()
}

// AddGauge 瞬时值增减（如连接建立 +1 / 断开 -1）
func AddGauge(name string, delta int64, labels ...string) {
	s := getOrCreate("gauge", name, buildLabels(labels...))
	mu.Lock()
	s.value += delta
	mu.Unlock()
}

// Render 输出 Prometheus 文本格式（version 0.0.4），
// 末尾附进程级指标（goroutine / heap / uptime）——抓取时实时采样
func Render() string {
	mu.RLock()
	keys := make([]seriesKey, 0, len(series_))
	for k := range series_ {
		keys = append(keys, k)
	}
	type entry struct {
		key  seriesKey
		kind string
		val  int64
	}
	entries := make([]entry, 0, len(keys))
	for _, k := range keys {
		s := series_[k]
		entries = append(entries, entry{k, s.kind, s.value})
	}
	mu.RUnlock()

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].key.name != entries[j].key.name {
			return entries[i].key.name < entries[j].key.name
		}
		return entries[i].key.labels < entries[j].key.labels
	})

	var b strings.Builder
	prev := ""
	for _, e := range entries {
		if e.key.name != prev {
			fmt.Fprintf(&b, "# TYPE %s %s\n", e.key.name, e.kind)
			prev = e.key.name
		}
		fmt.Fprintf(&b, "%s%s %d\n", e.key.name, e.key.labels, e.val)
	}

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	b.WriteString("# TYPE sc_process_goroutines gauge\n")
	fmt.Fprintf(&b, "sc_process_goroutines %d\n", runtime.NumGoroutine())
	b.WriteString("# TYPE sc_process_heap_alloc_bytes gauge\n")
	fmt.Fprintf(&b, "sc_process_heap_alloc_bytes %d\n", ms.HeapAlloc)
	b.WriteString("# TYPE sc_process_sys_bytes gauge\n")
	fmt.Fprintf(&b, "sc_process_sys_bytes %d\n", ms.Sys)
	b.WriteString("# TYPE sc_process_num_gc gauge\n")
	fmt.Fprintf(&b, "sc_process_num_gc %d\n", ms.NumGC)
	b.WriteString("# TYPE sc_process_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "sc_process_uptime_seconds %d\n", int64(time.Since(started).Seconds()))
	return b.String()
}

// wsConnectionsName 各 WS 端点统一记账的连接数 gauge 名（通知中心/操作通道等
// 按 endpoint 标签分序列注册，见 notification/ws.go、opschannel）——健康摘要
// 聚合的是总量，按序列名相等过滤求和即可（同名不同标签 = 同名多序列），
// 不需要逐端点枚举注册方
const wsConnectionsName = "sc_ws_connections"

// HealthSnapshot 实例健康摘要（P-20261003-28）：GET /api/system/health 的直取值。
// 与 Render() 同源零文本解析——uptime/heap/goroutines 即 Render 尾部进程级指标
// 的同一采样面（Render 抓取时实时采样，此处直取同理）；wsClients 为全部
// sc_ws_connections 序列之和。JSON 消费方（值班大屏健康卡）不解析文本格式。
type HealthSnapshot struct {
	UptimeSeconds  int64 // 进程运行秒数（sc_process_uptime_seconds 同源）
	HeapAllocBytes int64 // 存活堆字节数（sc_process_heap_alloc_bytes 同源）
	Goroutines     int64
	WSClients      int64
}

// GaugeValue 返回指定名的 gauge 当前值之和（健康 JSON 摘要直取注册值用，
// 与 Snapshot 同源零文本解析）。同名多序列（带标签）求和；无该名序列返回 0
func GaugeValue(name string) int64 {
	mu.RLock()
	defer mu.RUnlock()
	var total int64
	for k, s := range series_ {
		if k.name == name && s.kind == "gauge" {
			total += s.value
		}
	}
	return total
}

// Snapshot 采样实例健康四项
func Snapshot() HealthSnapshot {
	mu.RLock()
	var ws int64
	for k, s := range series_ {
		if k.name == wsConnectionsName {
			ws += s.value
		}
	}
	mu.RUnlock()

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return HealthSnapshot{
		UptimeSeconds:  int64(time.Since(started).Seconds()),
		HeapAllocBytes: int64(ms.HeapAlloc),
		Goroutines:     int64(runtime.NumGoroutine()),
		WSClients:      ws,
	}
}

// ResetForTesting 清空全部序列（仅测试用）
func ResetForTesting() {
	mu.Lock()
	series_ = make(map[seriesKey]*series)
	mu.Unlock()
}
