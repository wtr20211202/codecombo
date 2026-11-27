package diagnostics

import (
	"encoding/json"
	"sync"
	"time"
)

// 逐探针采集报告（P-20261124-1 S1⑤）：manifest 只回答「哪些文件进包了」，
// collection-report 回答「每个探针花了多久、为什么被跳过」——排障时最大的
// 时间浪费是分不清「机器上没有这项」和「采集器自己超时了」。
//
// 五态口径（与 manifest.status 分开：manifest 是文件入包决策，probe 是
// 采集动作的结局）：
//   - ok       采集完成
//   - skipped  环境不支持 / 未装配 / 权限不足（不是故障）
//   - timeout  超过该探针的 TimeoutMs 被放弃
//   - budget   整包预算（Options.Deadline）耗尽后不再启动
//   - denied   凭据面硬拒（探针存在但内容绝不入包）
//
// 该文件是纯类型 + 汇总，不触达任何平台 API（便于单测与 CLI 复用）。

// ProbeStatus 单探针结局（稳定取值，agent 可编程分支）
type ProbeStatus string

const (
	// ProbeOK 采集完成
	ProbeOK ProbeStatus = "ok"
	// ProbeSkipped 环境不支持/未装配/无权限
	ProbeSkipped ProbeStatus = "skipped"
	// ProbeTimeout 单探针超时（诊断工具不能在它要诊断的故障上无限等）
	ProbeTimeout ProbeStatus = "timeout"
	// ProbeBudget 整包预算耗尽
	ProbeBudget ProbeStatus = "budget"
	// ProbeDenied 凭据面硬拒
	ProbeDenied ProbeStatus = "denied"
)

// ProbeResult 单探针结果（state/collection-report.json 的条目）
type ProbeResult struct {
	// ID 稳定键（platform:uname / analysis:logs/xxx / proc:diskstats …）
	ID string `json:"id"`
	// Kind 采集类别：file|walk|command|analysis|proc|http|runtime|derived
	Kind string `json:"kind"`
	// Status ok|skipped|timeout|budget|denied
	Status string `json:"status"`
	// DurationMS 实际耗时（毫秒；未启动=0）
	DurationMS int64 `json:"durationMs"`
	// Bytes 采集/读取字节（不适用=0）
	Bytes int64 `json:"bytes,omitempty"`
	// Note 跳过/超时缘由或体量说明（已脱敏）
	Note string `json:"note,omitempty"`
	// Deep 仅在 deep 模式采集
	Deep bool `json:"deep,omitempty"`
	// TimeoutMS 该探针的超时上限（0=无单独上限，受整包预算约束）
	TimeoutMS int64 `json:"timeoutMs,omitempty"`
}

// CollectionReport 一次采集的探针账本（并发安全：平台探针可能并行）
type CollectionReport struct {
	mu        sync.Mutex
	generated time.Time
	budget    time.Duration
	deep      bool
	probes    []ProbeResult
}

// NewCollectionReport 新建账本（generated 为采集时刻，budget 为整包预算）
func NewCollectionReport(generated time.Time, budget time.Duration, deep bool) *CollectionReport {
	return &CollectionReport{generated: generated, budget: budget, deep: deep}
}

// Add 记一条探针结果（零值 DurationMS 时保留调用方填值）
func (r *CollectionReport) Add(p ProbeResult) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.probes = append(r.probes, p)
	r.mu.Unlock()
}

// Timed 执行 fn 并记录耗时/字节/状态：采集点只关心「做了什么、结果如何」，
// 计时与账本写入统一在这里，避免每处重复 time.Now 样板
func (r *CollectionReport) Timed(id, kind string, deep bool, timeout time.Duration, fn func() (bytes int64, note string, status ProbeStatus)) {
	if r == nil {
		if fn != nil {
			_, _, _ = fn()
		}
		return
	}
	start := time.Now()
	var (
		n      int64
		note   string
		status ProbeStatus
	)
	if fn != nil {
		n, note, status = fn()
	}
	if status == "" {
		status = ProbeOK
	}
	p := ProbeResult{
		ID: id, Kind: kind, Status: string(status),
		DurationMS: time.Since(start).Milliseconds(),
		Bytes:      n, Note: note, Deep: deep,
	}
	if timeout > 0 {
		p.TimeoutMS = timeout.Milliseconds()
	}
	r.Add(p)
}

// Probes 账本快照（渲染/测试用）
func (r *CollectionReport) Probes() []ProbeResult {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ProbeResult, len(r.probes))
	copy(out, r.probes)
	return out
}

// reportDoc state/collection-report.json 的顶层结构
type reportDoc struct {
	GeneratedAt string        `json:"generatedAt"`
	Deep        bool          `json:"deep"`
	BudgetMS    int64         `json:"budgetMs"`
	Probes      []ProbeResult `json:"probes"`
	Summary     reportSummary `json:"summary"`
	// LogWrite 日志写盘耗时（S1④）：所有请求 duration 都不含这段阻塞
	LogWrite *LogWriteStats `json:"logWrite,omitempty"`
}

// reportSummary 按状态计数（agent 一眼看出哪类结局占多数）
type reportSummary struct {
	Total       int   `json:"total"`
	OK          int   `json:"ok"`
	Skipped     int   `json:"skipped"`
	Timeout     int   `json:"timeout"`
	Budget      int   `json:"budget"`
	Denied      int   `json:"denied"`
	TotalTimeMS int64 `json:"totalDurationMs"`
}

// renderCollectionReport state/collection-report.json 渲染
func (r *CollectionReport) render() string {
	if r == nil {
		return "{}\n"
	}
	probes := r.Probes()
	doc := reportDoc{
		GeneratedAt: r.generated.Format(time.RFC3339),
		Deep:        r.deep,
		BudgetMS:    r.budget.Milliseconds(),
		Probes:      probes,
	}
	lw := LogWriteSnapshot()
	doc.LogWrite = &lw
	for _, p := range probes {
		doc.Summary.Total++
		doc.Summary.TotalTimeMS += p.DurationMS
		switch ProbeStatus(p.Status) {
		case ProbeOK:
			doc.Summary.OK++
		case ProbeSkipped:
			doc.Summary.Skipped++
		case ProbeTimeout:
			doc.Summary.Timeout++
		case ProbeBudget:
			doc.Summary.Budget++
		case ProbeDenied:
			doc.Summary.Denied++
		}
	}
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// runDeadline 把可能挂在 syscall 里的同步面（stat/walk/statfs）放进 goroutine，
// 到截止时间即放弃（ok=true 表示超时）。syscall 不可取消——goroutine 只能
// 泄漏到挂载恢复；这是「诊断工具不能死在它要诊断的故障上」的残余风险，
// 已在 README/runbook 如实声明，不宣称完全隔离。
func runDeadline[T any](deadline time.Time, fn func() T) (T, bool) {
	if deadline.IsZero() {
		return fn(), false
	}
	wait := time.Until(deadline)
	if wait <= 0 {
		var zero T
		return zero, true
	}
	ch := make(chan T, 1)
	go func() { ch <- fn() }()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case v := <-ch:
		return v, false
	case <-timer.C:
		var zero T
		return zero, true
	}
}
