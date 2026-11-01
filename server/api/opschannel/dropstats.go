package opschannel

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 广播队列丢弃观测面（P-20261004-70）：队列满时事件静默丢弃是事件管线唯一的
// 丢点（入口侧已有 P-91 限流+回告）——风暴下 approval.resolved / terminals.changed
// 等关键事件无痕消失，前端漏审批裁决/漏会话对账而排障无日志无计数。三面观测：
//  1. 丢弃即计数：sc_ops_channel_broadcast_dropped_total{type} —— GET /api/metrics
//     Prometheus 文本出口可抓取可告警
//  2. 消费滞后 gauge：sc_ops_channel_queue_depth —— 入队/出队两侧同步，滞后水位可画
//  3. 风暴摘要：进行中每 dropDebugInterval 周期性 debug 聚合（类型分布，生产日志
//     级别 Info 下不落盘——逐条打日志会自身成为第二个风暴，聚合明细留给排查时
//     开 debug / 测试断言）；风暴平息（静默超过 dropQuietWindow 后首个成功入队）
//     触发一次性 info 汇总（总数/类型分布），生产日志面上唯一的风暴痕迹
//
// 计数器标签基数考量：type 来自 events.go 契约常量（约 20 个）+ 外部 agent 自定义
// type（≤64 字符开放词表，发布口限流 60/min/session），现实基数低——与
// sc_bus_events_published_total 的 topic 标签同量级取向。

const (
	// droppedCounterName 广播队列丢弃计数器（按事件 type 分序列）
	droppedCounterName = "sc_ops_channel_broadcast_dropped_total"
	// queueDepthName 广播队列深度 gauge（消费滞后水位）
	queueDepthName = "sc_ops_channel_queue_depth"
)

var (
	// dropDebugInterval 风暴进行中 debug 聚合的发射间隔：var 仅为测试可缩窗
	dropDebugInterval = 10 * time.Second
	// dropQuietWindow 判定风暴平息的静默窗：最后一次丢弃后持续这么久无新丢弃
	// 且队列恢复入队，才认定自愈并发射一次性 info 汇总。须大于 debug 间隔——
	// 防风暴中的短暂间歇被误判为自愈。var 仅为测试可缩窗
	dropQuietWindow = 30 * time.Second
)

// dropTracker 风暴期丢弃聚合器：累计当前风暴的丢弃总数与类型分布，周期性
// debug 明细 + 自愈后一次性 info 汇总。零专属 goroutine——debug 刷新挂靠在
// 丢弃路径、info 汇总挂靠在成功入队路径，均由调用方 goroutine 顺带执行
// （两者都秒级节流，风暴下每秒数千次丢弃也只摊几次锁内计时与渲染）
type dropTracker struct {
	// stormActive 快速路径：常态无风暴，成功入队侧免锁直返
	// （与 mu 保护的字段配合使用：Store 后续 Lock，读侧 Load 后仍须锁内复核）
	stormActive atomic.Bool

	mu          sync.Mutex
	byType      map[string]int64 // 当前风暴的按类型丢弃计数（汇总后重置）
	total       int64            // 当前风暴丢弃总数（冗余存，免静默判定反复遍历 map）
	lastDropAt  time.Time        // 最后一次丢弃时刻（自愈判定基准）
	lastDebugAt time.Time        // 上次 debug 聚合发射时刻
}

var drops = &dropTracker{byType: make(map[string]int64)}

// recordDrop 记一次队列丢弃：累加计数 + 秒级节流发射 debug 聚合（含类型分布
// 与当前滞后水位）。调用方 = BroadcastEvent 丢弃分支，事件类型原样透传
func (d *dropTracker) recordDrop(eventType string) {
	d.stormActive.Store(true)
	d.mu.Lock()
	d.total++
	d.byType[eventType]++
	now := time.Now()
	d.lastDropAt = now
	shouldDebug := d.lastDebugAt.IsZero() || now.Sub(d.lastDebugAt) >= dropDebugInterval
	var total int64
	var dist string
	if shouldDebug {
		total = d.total
		dist = d.distributionLocked()
		d.lastDebugAt = now
	}
	d.mu.Unlock()
	if shouldDebug {
		slog.Debug("ops-channel broadcast queue full, dropping events",
			"droppedTotal", total,
			"byType", dist,
			"queueDepth", len(h.queue),
		)
	}
}

// maybeSummarize 成功入队侧的自愈检查：风暴标记在场、丢弃已静默超过
// dropQuietWindow 且确有丢弃，一次性 info 汇总本风暴丢弃总数与类型分布
// 并复位聚合器。常态（无风暴）走 atomic 快速路径直返——这是所有广播事件的
// 热路径，零锁零分配
func (d *dropTracker) maybeSummarize() {
	if !d.stormActive.Load() {
		return
	}
	d.mu.Lock()
	quiet := d.total > 0 && time.Since(d.lastDropAt) >= dropQuietWindow
	var total int64
	var dist string
	if quiet {
		total = d.total
		dist = d.distributionLocked()
		d.resetLocked()
	}
	d.mu.Unlock()
	if quiet {
		slog.Info("ops-channel broadcast queue recovered from drop storm",
			"droppedTotal", total,
			"byType", dist,
		)
	}
}

// distributionLocked 渲染类型分布：按次数降序 "type×count" 逗号拼接，
// 日志单行可读。须持锁调用
func (d *dropTracker) distributionLocked() string {
	type kc struct {
		k string
		c int64
	}
	entries := make([]kc, 0, len(d.byType))
	for k, c := range d.byType {
		entries = append(entries, kc{k, c})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].c != entries[j].c {
			return entries[i].c > entries[j].c
		}
		return entries[i].k < entries[j].k
	})
	var b strings.Builder
	for i, e := range entries {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%s×%d", e.k, e.c)
	}
	return b.String()
}

// resetLocked 复位聚合器进入下一风暴的记账。须持锁调用
// （stormActive 与 mu 字段同把锁内收尾，读侧 Load 后锁内复核，无交叉窗口）
func (d *dropTracker) resetLocked() {
	d.byType = make(map[string]int64)
	d.total = 0
	d.lastDropAt = time.Time{}
	d.lastDebugAt = time.Time{}
	d.stormActive.Store(false)
}
