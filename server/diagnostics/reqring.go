package diagnostics

import (
	"encoding/json"
	"sync"
	"time"
)

// 进程内慢请求/异常请求环形（P-20261124-1 S1②）：state/requests.json 回答
// 「最近谁慢、谁 5xx、有没有 panic、那次请求的日志到底写没写出来」。
//
// 纪律：
//   - 只记 duration ≥1s 或 status ≥500 或 panic —— 全量计时会把环形挤成
//     基本无信息的 200 条健康请求（前端 30s 轮询 + 心跳就能塞满）；
//   - 绝不存 query/body/header；route 用 c.FullPath()（模板），unmatched 时
//     只写 "unmatched" 不写原始路径——未匹配路径可能含分享 token 等凭据段；
//   - panic 只留类型 + 截断摘要（200 字符），导出时再过 Redactor；
//   - 内存环 200 条，覆盖式写入（最旧先丢），单条结构定长无 unbounded 面。

// requestRingCapacity 慢请求环容量（覆盖式）
const requestRingCapacity = 200

// PanicSummaryMax panic 摘要字符上限（防止 panic 值携带超长内容）。
// 中间件（server/middleware/timeline.go）截断时引用本常量——两处各写 200
// 会在调整时漂移，而该值直接决定导出 JSON 的内存上界。
const PanicSummaryMax = 200

// RequestRecord 单条慢/异常请求（state/requests.json 条目）
type RequestRecord struct {
	// StartedAt 请求开始（本地时区 RFC3339 毫秒）
	StartedAt string `json:"startedAt"`
	// CompletedAt 请求完成（gin.Logger 写日志之后——见 middleware.RequestTimeline）
	CompletedAt string `json:"completedAt"`
	// DurationMS 端到端耗时（含访问日志写盘；日志写耗时见 collection-report.logWrite）
	DurationMS int64 `json:"durationMs"`
	// Method HTTP 方法
	Method string `json:"method"`
	// Route 路由模板（c.FullPath；未匹配="unmatched"，绝不含实参）
	Route string `json:"route"`
	// Status 响应状态码（panic 记 500）
	Status int `json:"status"`
	// RID 请求关联 ID（与 X-Request-Id / 访问日志 rid= 对齐）
	RID string `json:"rid,omitempty"`
	// ClientIP 客户端 IP（排障必需；不含端口）
	ClientIP string `json:"clientIp,omitempty"`
	// WS WebSocket 升级请求（长连接时长不代表阻塞）
	WS bool `json:"ws,omitempty"`
	// Panic 处理链 panic（gin.Recovery 仍会写 500，这里留证据）
	Panic bool `json:"panic,omitempty"`
	// PanicSummary panic 值摘要（截断+脱敏；绝不含栈）
	PanicSummary string `json:"panicSummary,omitempty"`
	// Probe 探活类请求（/api/health 等；慢探活是服务卡死的第一信号）
	Probe bool `json:"probe,omitempty"`
	// Silent 请求期间没有任何日志写盘探针采样——正常访问日志行在 gin.Logger
	// 里写，panic 会跳过它；silent=true 即「这条请求在日志里查不到」
	Silent bool `json:"silent,omitempty"`
}

// slowRequestThreshold 慢请求阈值（与 proposals 的 1s 口径一致）
const slowRequestThreshold = time.Second

// recordSlowRequest 判定是否值得入环（duration/status/panic 任一命中）
func recordSlowRequest(rec RequestRecord) bool {
	return rec.Panic || rec.Status >= 500 || rec.DurationMS >= slowRequestThreshold.Milliseconds()
}

var requestRing = struct {
	mu  sync.Mutex
	buf []RequestRecord
	// dropped 覆盖式写入挤掉的条数（容器自身是定长，不需要额外上限）
	dropped int64
}{buf: make([]RequestRecord, 0, requestRingCapacity)}

// RecordRequest 记录一条请求（不在阈值内的直接丢弃，零分配）
func RecordRequest(rec RequestRecord) {
	if !recordSlowRequest(rec) {
		return
	}
	requestRing.mu.Lock()
	defer requestRing.mu.Unlock()
	if len(requestRing.buf) >= requestRingCapacity {
		// 覆盖最旧：定长环语义，O(n) 拷贝可接受（200 条 × 数十字节）
		copy(requestRing.buf, requestRing.buf[1:])
		requestRing.buf[len(requestRing.buf)-1] = rec
		requestRing.dropped++
		return
	}
	requestRing.buf = append(requestRing.buf, rec)
}

// RequestsSnapshot 环形快照（旧→新）
func RequestsSnapshot() []RequestRecord {
	requestRing.mu.Lock()
	defer requestRing.mu.Unlock()
	out := make([]RequestRecord, len(requestRing.buf))
	copy(out, requestRing.buf)
	return out
}

// requestsDoc state/requests.json 顶层结构
type requestsDoc struct {
	GeneratedAt string          `json:"generatedAt"`
	Capacity    int             `json:"capacity"`
	Count       int             `json:"count"`
	Dropped     int64           `json:"dropped"`
	ThresholdMS int64           `json:"thresholdMs"`
	Requests    []RequestRecord `json:"requests"`
	Note        string          `json:"note"`
}

// renderRequestsJSON state/requests.json 渲染（red 只动 panic 摘要：其余字段
// 全是我们自己填的模板/枚举/IP，没有自由文本）
func renderRequestsJSON(now time.Time, red *Redactor) string {
	recs := RequestsSnapshot()
	requestRing.mu.Lock()
	dropped := requestRing.dropped
	requestRing.mu.Unlock()
	if red != nil {
		for i := range recs {
			recs[i].PanicSummary = red.Line(recs[i].PanicSummary)
		}
	}
	doc := requestsDoc{
		GeneratedAt: now.Format(time.RFC3339),
		Capacity:    requestRingCapacity,
		Count:       len(recs),
		Dropped:     dropped,
		ThresholdMS: slowRequestThreshold.Milliseconds(),
		Requests:    recs,
		Note: "only duration>=1s, status>=500 or panic are kept; no query/body/header is ever recorded. " +
			"duration includes the access-log write (cross-check collection-report.logWrite to separate log IO from handler time)",
	}
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// ResetTimelineForTesting 清空进程内环（仅测试用：跨用例隔离）
func ResetTimelineForTesting() {
	requestRing.mu.Lock()
	requestRing.buf = requestRing.buf[:0]
	requestRing.dropped = 0
	requestRing.mu.Unlock()
	stopWatchdogForTesting()
	resetLogWriteForTesting()
	ResetRoutesForTesting()
}
