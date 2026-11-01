package store

import (
	"encoding/json"
	"log/slog"
	"math"
	"sync"
	"time"
)

// DiagSnapshot 单次远程诊断提取的关键数值摘要（P-20261002-18）。
// 只存结构化数值、不存全文报告——全文随诊断响应即用即弃，落盘的
// 是回答「这周磁盘涨了多少 / 内存是不是在缓慢泄漏」所需的最小集合。
// 字段零值 = 该项未采集到（命令缺失/输出格式未识别），消费方按
// 「无数据」隐藏对应指标，绝不当作真实 0 展示
type DiagSnapshot struct {
	Time time.Time `json:"time"`
	// 磁盘：根挂载点（无 / 时取首个数据行）的可用/总量，MB 口径
	DiskAvailMB int64 `json:"diskAvailMB,omitempty"`
	DiskTotalMB int64 `json:"diskTotalMB,omitempty"`
	// 内存：free -m 的 used 列，MB 口径（含 buff/cache 的分配态用量）
	MemUsedMB int64 `json:"memUsedMB,omitempty"`
	// 负载 1/5/15 分钟（uptime）
	Load1  float64 `json:"load1,omitempty"`
	Load5  float64 `json:"load5,omitempty"`
	Load15 float64 `json:"load15,omitempty"`
	// systemd 失败服务数（非 systemd 主机恒 0 = 未采集）
	FailedServices int `json:"failedServices,omitempty"`
	// CPU 占用（top 第一采样的 100-idle 瞬时值，%）
	CPUPercent float64 `json:"cpuPercent,omitempty"`
}

// DiagDelta 两次快照的三指标差值（cur - prev）。
// 磁盘比可用（变小 = 在被填满），内存比用量（变大 = 疑似泄漏），负载比 1 分钟
type DiagDelta struct {
	DiskAvailMB int64   `json:"diskAvailMB"`
	MemUsedMB   int64   `json:"memUsedMB"`
	Load1       float64 `json:"load1"`
}

// DiffDiagSnapshot 差值计算（纯函数，供诊断响应内联与列表趋势摘要共用）。
// 任一侧未采集（零值哨兵）的指标差值恒 0——前端以 prev 对应字段是否
// 为 0 决定隐藏，见 DiagSnapshot 注释
func DiffDiagSnapshot(prev, cur DiagSnapshot) DiagDelta {
	var d DiagDelta
	if prev.DiskAvailMB != 0 && cur.DiskAvailMB != 0 {
		d.DiskAvailMB = cur.DiskAvailMB - prev.DiskAvailMB
	}
	if prev.MemUsedMB != 0 && cur.MemUsedMB != 0 {
		d.MemUsedMB = cur.MemUsedMB - prev.MemUsedMB
	}
	if prev.Load1 != 0 && cur.Load1 != 0 {
		d.Load1 = math.Round((cur.Load1-prev.Load1)*100) / 100
	}
	return d
}

// diagHistKind 文档存储 kind 名
const diagHistKind = "diaghist"

// DiagHistMax 每主机环形保留的摘要条数：20 次足够回答「最近一周趋势」，
// 且单文档体积有硬上界（20 × ~200B ≈ 4KB/主机）
const DiagHistMax = 20

// DiagHistStore 远程诊断历史（host 一文档）：每次诊断追加一条数值摘要，
// 超限裁最旧（环形保留即保留策略，无需时间窗清理 ticker）。
// Append 尽力而为——快照写失败仅记日志，绝不阻断诊断响应
type DiagHistStore interface {
	Append(hostID string, snap DiagSnapshot)
	// Latest 最近一次摘要（无历史时 ok=false）
	Latest(hostID string) (DiagSnapshot, bool)
	// History 最近 limit 条（时间倒序；limit<=0 视为全部保留窗）
	History(hostID string, limit int) []DiagSnapshot
	// Delete 主机删除时级联清理（避免孤儿文档累积）
	Delete(hostID string)
}

// diagHistDoc 单主机文档：按时间升序的摘要环（尾端最新）
type diagHistDoc struct {
	Items []DiagSnapshot `json:"items"`
}

type diagHistRepo struct {
	doc DocumentStore
	// mu 串行化同主机的读-改-写（Append 竞态会丢环尾/Latest 读到中间态；
	// 诊断同主机并发极罕见，但锁是零成本保险）
	mu sync.Mutex
}

// NewDiagHistRepo 构造诊断历史仓储（导出供 store_test 注入独立 DocumentStore，
// 同 NewAuditLogRepo 惯例）
func NewDiagHistRepo(doc DocumentStore) DiagHistStore { return &diagHistRepo{doc: doc} }

func (r *diagHistRepo) Append(hostID string, snap DiagSnapshot) {
	if hostID == "" {
		return
	}
	if snap.Time.IsZero() {
		snap.Time = time.Now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	hist := r.load(hostID)
	hist.Items = append(hist.Items, snap)
	if over := len(hist.Items) - DiagHistMax; over > 0 {
		hist.Items = hist.Items[over:] // 环形裁最旧，尾端最新
	}
	data, err := json.Marshal(hist)
	if err != nil {
		slog.Warn("diaghist marshal failed", "host", hostID, "err", err)
		return
	}
	err = r.doc.Upsert(diagHistKind, hostID, data)
	if err != nil {
		slog.Warn("diaghist persist failed", "host", hostID, "err", err)
	}
}

func (r *diagHistRepo) Latest(hostID string) (DiagSnapshot, bool) {
	hist := r.load(hostID)
	if n := len(hist.Items); n > 0 {
		return hist.Items[n-1], true
	}
	return DiagSnapshot{}, false
}

func (r *diagHistRepo) History(hostID string, limit int) []DiagSnapshot {
	hist := r.load(hostID)
	n := len(hist.Items)
	if n == 0 {
		return []DiagSnapshot{}
	}
	// 存储升序、返回倒序（最新在前），再按 limit 截尾
	out := make([]DiagSnapshot, 0, n)
	for i := n - 1; i >= 0; i-- {
		out = append(out, hist.Items[i])
	}
	if limit > 0 && limit < len(out) {
		out = out[:limit]
	}
	return out
}

func (r *diagHistRepo) Delete(hostID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.doc.Delete(diagHistKind, hostID); err != nil && err != ErrNotFound {
		slog.Warn("diaghist delete failed", "host", hostID, "err", err)
	}
}

// load 读单主机文档（缺失/损坏视为空历史——摘要历史可随时重建，不视为错误）
func (r *diagHistRepo) load(hostID string) diagHistDoc {
	var hist diagHistDoc
	data, err := r.doc.Get(diagHistKind, hostID)
	if err != nil {
		return hist
	}
	if json.Unmarshal(data, &hist) != nil {
		return diagHistDoc{}
	}
	return hist
}
