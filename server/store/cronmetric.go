package store

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// CronMetricPoint 定时任务指标时序单点（P-20261005-237）：任务完成回执落定时
// 从会话输出尾窗抽取的一个数值（耗时/内存/计数……由任务 extract 规则定义）。
// 只存数值不存输出原文——尾窗是提取素材即用即弃，落盘的是回答「这周构建是
// 不是变慢了」所需的最小集合（diaghist 数值摘要同纪律）
type CronMetricPoint struct {
	At    time.Time `json:"at"`
	Value float64   `json:"value"`
}

// cronMetricKind 文档存储 kind 名
const cronMetricKind = "cronmetric"

// CronMetricMax 每任务环形保留的点位数：30 点对每日任务 ≈ 最近一个月窗口，
// 单文档体积硬上界（30 × ~40B ≈ 1.2KB/任务）
const CronMetricMax = 30

// CronMetricStore 定时任务指标时序（任务一文档）：完成抽取命中即追加，超限
// 裁最旧（环形保留即保留策略，无需时间窗清理 ticker）。Append 尽力而为——
// 写失败仅记日志，绝不阻断完成回执主链
type CronMetricStore interface {
	Append(cronID string, p CronMetricPoint)
	// History 最近 limit 条（时间倒序，最新在前；limit<=0 视为全部保留窗）
	History(cronID string, limit int) []CronMetricPoint
	// Delete 任务删除时级联清理（避免孤儿文档累积）
	Delete(cronID string)
}

// cronMetricDoc 单任务文档：按时间升序的点位环（尾端最新）
type cronMetricDoc struct {
	Points []CronMetricPoint `json:"points"`
}

type cronMetricRepo struct {
	doc DocumentStore
	// mu 串行化同任务的读-改-写（Append 竞态会丢环尾；同任务完成并发极罕见，
	// 但锁是零成本保险——diaghist 同款）
	mu sync.Mutex
}

// NewCronMetricRepo 构造指标时序仓储（导出供 store_test 注入独立 DocumentStore，
// 同 NewDiagHistRepo 惯例）
func NewCronMetricRepo(doc DocumentStore) CronMetricStore { return &cronMetricRepo{doc: doc} }

func (r *cronMetricRepo) Append(cronID string, p CronMetricPoint) {
	if cronID == "" {
		return
	}
	if p.At.IsZero() {
		p.At = time.Now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	doc := r.load(cronID)
	doc.Points = append(doc.Points, p)
	if over := len(doc.Points) - CronMetricMax; over > 0 {
		doc.Points = doc.Points[over:] // 环形裁最旧，尾端最新
	}
	data, err := json.Marshal(doc)
	if err != nil {
		slog.Warn("cronmetric marshal failed", "cron", cronID, "err", err)
		return
	}
	err = r.doc.Upsert(cronMetricKind, cronID, data)
	if err != nil {
		slog.Warn("cronmetric persist failed", "cron", cronID, "err", err)
	}
}

func (r *cronMetricRepo) History(cronID string, limit int) []CronMetricPoint {
	doc := r.load(cronID)
	n := len(doc.Points)
	if n == 0 {
		return []CronMetricPoint{}
	}
	// 存储升序、返回倒序（最新在前），再按 limit 截尾
	out := make([]CronMetricPoint, 0, n)
	for i := n - 1; i >= 0; i-- {
		out = append(out, doc.Points[i])
	}
	if limit > 0 && limit < len(out) {
		out = out[:limit]
	}
	return out
}

func (r *cronMetricRepo) Delete(cronID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(cronMetricKind, cronID); err != nil && err != ErrNotFound {
		slog.Warn("cronmetric delete failed", "cron", cronID, "err", err)
	}
}

// load 读单任务文档（缺失/损坏视为空时序——历史可随下次抽取重建，不视为错误）
func (r *cronMetricRepo) load(cronID string) cronMetricDoc {
	var doc cronMetricDoc
	data, err := r.doc.Get(cronMetricKind, cronID)
	if err != nil {
		return doc
	}
	if json.Unmarshal(data, &doc) != nil {
		return cronMetricDoc{}
	}
	return doc
}
