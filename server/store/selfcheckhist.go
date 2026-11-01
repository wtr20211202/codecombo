package store

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// SelfCheckSnapshot 本机体检数值快照单点（P-20261005-169）。与 DiagSnapshot
// 同纪律：只存回答「磁盘是不是在爬升 / 堆内存是不是在缓涨 / 会话数是不是在
// 增长」所需的最小数值集合，不存体检全文——全文随 GET /api/selfcheck 响应
// 即用即弃。字段零值 = 该项未采集到，消费方按「无数据」隐藏对应指标，绝不
// 当作真实 0 展示（Terminals 例外：终端计数恒可采集，0 是真实值）
type SelfCheckSnapshot struct {
	Time time.Time `json:"time"`
	// 磁盘：数据盘（DataDir 所在卷）的可用/总量，MB 口径（disk 体检条目同源）
	DiskAvailMB int64 `json:"diskAvailMB,omitempty"`
	DiskTotalMB int64 `json:"diskTotalMB,omitempty"`
	// 内存：进程堆内存（heapAlloc），MB 口径。取进程口径而非系统级内存：
	// 后者 win/mac/linux 各需一套读取分支，而本机趋势关心的是实例自身退化，
	// 进程口径与 /api/system/health 同源即可
	MemUsedMB int64 `json:"memUsedMB,omitempty"`
	// OSC 133 运行点亮的会话数（shell 集成缺失/无命令在跑恒 0 = 未采集）
	ActiveSessions int `json:"activeSessions,omitempty"`
	// 打开的终端会话总数（shell+agent，恒可采集，0 是真实值非哨兵）
	Terminals int `json:"terminals"`
	// goroutine 数（进程负载代理指标；OS load 无跨平台读取源，不设字段）
	Goroutines int `json:"goroutines,omitempty"`
}

// SelfCheckDelta 两次快照的指标差值（cur - prev）。
// 磁盘比可用（变小 = 在被填满），内存/会话/终端比数量（变大 = 疑似增长/泄漏）
type SelfCheckDelta struct {
	DiskAvailMB    int64 `json:"diskAvailMB"`
	MemUsedMB      int64 `json:"memUsedMB"`
	ActiveSessions int   `json:"activeSessions"`
	Terminals      int   `json:"terminals"`
}

// DiffSelfCheckSnapshot 差值计算（纯函数，供体检响应内联趋势面共用）。
// 任一侧未采集（零值哨兵）的指标差值恒 0——前端以 prev 对应字段是否为 0
// 决定隐藏（同 DiagSnapshot 注释）；Terminals 恒真实，恒出
func DiffSelfCheckSnapshot(prev, cur SelfCheckSnapshot) SelfCheckDelta {
	var d SelfCheckDelta
	if prev.DiskAvailMB != 0 && cur.DiskAvailMB != 0 {
		d.DiskAvailMB = cur.DiskAvailMB - prev.DiskAvailMB
	}
	if prev.MemUsedMB != 0 && cur.MemUsedMB != 0 {
		d.MemUsedMB = cur.MemUsedMB - prev.MemUsedMB
	}
	if prev.ActiveSessions != 0 && cur.ActiveSessions != 0 {
		d.ActiveSessions = cur.ActiveSessions - prev.ActiveSessions
	}
	d.Terminals = cur.Terminals - prev.Terminals
	return d
}

// selfCheckHistKind 文档存储 kind 名（diaghist 同族：数值摘要环形历史）
const selfCheckHistKind = "selfcheckhist"

// selfCheckHistKey 单实例恒一文档的固定键：本机没有主机维度（区别于 diaghist
// 的 host 一文档），不走「(local)」特殊主机值——独立 kind 下远程列表按主机
// 枚举的读取面天然不可见本地条目，无键空间交叉
const selfCheckHistKey = "local"

// SelfCheckHistMax 环形保留的快照条数：每日一次定时 + 手动体检随做随入账，
// 20 次覆盖数周缓变窗口，单文档体积硬上界（20 × ~120B ≈ 2.4KB）
const SelfCheckHistMax = 20

// SelfCheckHistStore 本机体检趋势历史（单文档）：每次体检/每日定时追加一条
// 数值快照，超限裁最旧（环形保留即保留策略，无需时间窗清理 ticker）。
// Append 尽力而为——快照写失败仅记日志，绝不阻断体检响应
type SelfCheckHistStore interface {
	Append(snap SelfCheckSnapshot)
	// Latest 最近一次快照（无历史时 ok=false）
	Latest() (SelfCheckSnapshot, bool)
	// History 最近 limit 条（时间倒序，最新在前；limit<=0 视为全部保留窗）
	History(limit int) []SelfCheckSnapshot
}

// selfCheckHistDoc 单文档：按时间升序的快照环（尾端最新）
type selfCheckHistDoc struct {
	Items []SelfCheckSnapshot `json:"items"`
}

type selfCheckHistRepo struct {
	doc DocumentStore
	// mu 串行化读-改-写（Append 竞态会丢环尾/Latest 读到中间态；同刻体检并发
	// 极罕见，但锁是零成本保险——diaghist 同款）
	mu sync.Mutex
}

// NewSelfCheckHistRepo 构造体检趋势历史仓储（导出供 store_test 注入独立
// DocumentStore，同 NewDiagHistRepo 惯例）
func NewSelfCheckHistRepo(doc DocumentStore) SelfCheckHistStore {
	return &selfCheckHistRepo{doc: doc}
}

func (r *selfCheckHistRepo) Append(snap SelfCheckSnapshot) {
	if snap.Time.IsZero() {
		snap.Time = time.Now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	hist := r.load()
	hist.Items = append(hist.Items, snap)
	if over := len(hist.Items) - SelfCheckHistMax; over > 0 {
		hist.Items = hist.Items[over:] // 环形裁最旧，尾端最新
	}
	data, err := json.Marshal(hist)
	if err != nil {
		slog.Warn("selfcheckhist marshal failed", "err", err)
		return
	}
	if err := r.doc.Upsert(selfCheckHistKind, selfCheckHistKey, data); err != nil {
		slog.Warn("selfcheckhist persist failed", "err", err)
	}
}

func (r *selfCheckHistRepo) Latest() (SelfCheckSnapshot, bool) {
	hist := r.load()
	if n := len(hist.Items); n > 0 {
		return hist.Items[n-1], true
	}
	return SelfCheckSnapshot{}, false
}

func (r *selfCheckHistRepo) History(limit int) []SelfCheckSnapshot {
	hist := r.load()
	n := len(hist.Items)
	if n == 0 {
		return []SelfCheckSnapshot{}
	}
	// 存储升序、返回倒序（最新在前），再按 limit 截尾
	out := make([]SelfCheckSnapshot, 0, n)
	for i := n - 1; i >= 0; i-- {
		out = append(out, hist.Items[i])
	}
	if limit > 0 && limit < len(out) {
		out = out[:limit]
	}
	return out
}

// load 读单文档（缺失/损坏视为空历史——快照历史可随下次体检重建，不视为错误）
func (r *selfCheckHistRepo) load() selfCheckHistDoc {
	var hist selfCheckHistDoc
	data, err := r.doc.Get(selfCheckHistKind, selfCheckHistKey)
	if err != nil {
		return hist
	}
	if json.Unmarshal(data, &hist) != nil {
		return selfCheckHistDoc{}
	}
	return hist
}
