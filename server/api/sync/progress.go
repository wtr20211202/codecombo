package sync

import (
	"sync"
	"time"

	"codecombo/server/notification"
)

// 同步进度中心（用户补充注记：进度/速率/剩余时间展示体系）。
//
// 单实例进程内 hub：手动同步、定时同步、多标签页共享同一进度事实——
// 快照经 GET /api/sync/progress 可拉，且以 sync.progress 消息经通知 WS
// 广播（500ms 节流，前端分发为窗口事件驱动面板渲染）。
//
// 速率口径（用户补充注记）：3s 滑动窗口 EMA——每个采样窗（≥2s 防抖，批量
// 小文件时窗口不闪跳）计算瞬时速率，EMA 平滑；剩余时间 = 剩余字节/EMA 速率
//（速率未成熟时 0，前端渲染为「计算中」而非假数）。

// progressThrottle 广播节流窗口
const progressThrottle = 500 * time.Millisecond

// speedWindow 采样窗下限（批量小文件防抖）
const speedWindow = 2 * time.Second

// speedEMAHalfLife EMA 半衰期（3s 窗口量级的平滑度）
const speedEMAHalfLife = 3 * time.Second

// UnitProgress 单元进度（单元行内状态机：排队→枚举→传输→落位→完成/失败/冲突跳过）
type UnitProgress struct {
	Key     string `json:"key"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	State   string `json:"state"` // queued/enumerating/transferring/landing/done/failed/conflict-skipped/busy-skipped
	Sent    int64  `json:"sent"`
	Total   int64  `json:"total"`
	Current string `json:"current,omitempty"` // 传输中当前文件名
	Error   string `json:"error,omitempty"`
}

// SyncJob 一次同步执行的任务快照
type SyncJob struct {
	ID         string         `json:"id"`
	Direction  string         `json:"direction"` // pull/push
	PeerName   string         `json:"peerName"`
	Source     string         `json:"source"` // manual/cron
	Units      []UnitProgress `json:"units"`
	TotalBytes int64          `json:"totalBytes"`
	SentBytes  int64          `json:"sentBytes"`
	StartedAt  time.Time      `json:"startedAt"`
	FinishedAt *time.Time     `json:"finishedAt,omitempty"`
	Outcome    string         `json:"outcome"` // running/done/partial/failed
	// SpeedBytesPerSec EMA 速率（0 = 尚未成熟）
	SpeedBytesPerSec float64 `json:"speedBytesPerSec,omitempty"`
	// EtaSeconds 剩余时间估算（0 = 不可估）
	EtaSeconds float64 `json:"etaSeconds,omitempty"`

	// ── 共享推进内部态（不出序列化面）──
	// rt 串行化全部任务级共享推进（多单元 goroutine 并发回报 Sent/State，
	// SentBytes/EMA 采样是聚合字段；Outcome/FinishedAt 终态写与节流尾沿
	// 定时器触发的 snapshot 读也同在此锁域）。互斥体住指针侧结构——SyncJob
	// 本体被 snapshot 值拷贝，内嵌锁会触发 vet copylocks。
	// 不变式：进 beginJob 的任务必须已带 rt（execute.go/handlers.go 构造点
	// 负责），快照/推进路径不做惰性初始化（并发首碰会自竞争）
	rt *jobRuntime `json:"-"`
	// envHints 对端环境画像差集提示（执行期收集，独立互斥防多目标并发写；
	// json:"-"——进度广播/快照不带，仅结果响应转出。指针形态规避 snapshot
	// 值拷贝互斥体的 vet 问题；执行结束后只读）
	env *envCollector `json:"-"`
}

// jobRuntime 任务级共享推进的互斥域（见 SyncJob.rt 注记）
type jobRuntime struct {
	mu           sync.Mutex
	lastSampleAt time.Time
	sampleSent   int64
}

// envCollector 环境提示收集器（键 → 差集提示行）
type envCollector struct {
	mu sync.Mutex
	m  map[string]string
}

func (j *SyncJob) noteEnvHint(key, hint string) {
	if j.env == nil || hint == "" {
		return
	}
	j.env.mu.Lock()
	defer j.env.mu.Unlock()
	if j.env.m == nil {
		j.env.m = map[string]string{}
	}
	j.env.m[key] = hint
}

func (j *SyncJob) envHintsSnapshot() map[string]string {
	if j.env == nil {
		return nil
	}
	j.env.mu.Lock()
	defer j.env.mu.Unlock()
	if len(j.env.m) == 0 {
		return nil
	}
	out := make(map[string]string, len(j.env.m))
	for k, v := range j.env.m {
		out[k] = v
	}
	return out
}

// markFinished 终态推进（rt.mu 串行化）：Outcome/FinishedAt 与 touch 聚合写、
// snapshot 读同锁域——收口时刻节流尾沿定时器仍可能在途（500ms 窗内的最后一次
// dirty 会在此后触发 emit→snapshot），裸写会与快照撕裂（race 门禁口径）
func (j *SyncJob) markFinished(outcome string) {
	now := time.Now()
	j.rt.mu.Lock()
	j.Outcome = outcome
	j.FinishedAt = &now
	j.rt.mu.Unlock()
}

// demoteIfRunning 把仍在跑的任务按失败收口（beginJob 兜底替换路径专用）：
// 「是否在跑」的判定与改写同锁域原样完成，返回是否发生了收口（供 past 入账
// 判定——已终态任务不重复入账）
func (j *SyncJob) demoteIfRunning() bool {
	now := time.Now()
	j.rt.mu.Lock()
	wasRunning := j.Outcome == "running"
	if wasRunning {
		j.Outcome = "failed"
		j.FinishedAt = &now
	}
	j.rt.mu.Unlock()
	return wasRunning
}

// running 判定（终态判定走 rt.mu——Outcome 写侧已入锁域，裸读会漏判）
func (j *SyncJob) running() bool {
	j.rt.mu.Lock()
	defer j.rt.mu.Unlock()
	return j.Outcome == "running"
}

// setUnit 单元槽位推进（rt.mu 串行化——多单元 goroutine 并发回报；sent<0/current
// 空/state 空表示该维度不动）。聚合与广播由调用方紧随的 touch 完成
func (j *SyncJob) setUnit(key string, sent int64, current, state string) {
	j.rt.mu.Lock()
	defer j.rt.mu.Unlock()
	for i := range j.Units {
		if j.Units[i].Key != key {
			continue
		}
		if sent >= 0 {
			j.Units[i].Sent = sent
		}
		if current != "" {
			j.Units[i].Current = current
		}
		if state != "" {
			j.Units[i].State = state
		}
		return
	}
}

// failUnit 单元直接记失败并写错误文案（Error 字段——面板单元行 .sync-unit-error
// 红字呈现；退役单元等「未发起即失败」的显式红点口，P-20261108-3）
func (j *SyncJob) failUnit(key, msg string) {
	j.rt.mu.Lock()
	defer j.rt.mu.Unlock()
	for i := range j.Units {
		if j.Units[i].Key == key {
			j.Units[i].State = "failed"
			j.Units[i].Error = msg
			return
		}
	}
}

// snapshot 深拷贝（广播/拉取面拿到的是副本，写侧继续推进零竞争）。
// 共享推进在 rt.mu 内取一致性切片（含 SentBytes/EMA 聚合字段与各单元槽位）
func (j *SyncJob) snapshot() *SyncJob {
	j.rt.mu.Lock()
	cp := *j
	cp.Units = append([]UnitProgress(nil), j.Units...)
	cp.FinishedAt = j.FinishedAt
	j.rt.mu.Unlock()
	return &cp
}

// touch 重算聚合字节并（节流后）广播
func (j *SyncJob) touch(hub *progressHub) {
	j.rt.mu.Lock()
	var sent int64
	for i := range j.Units {
		sent += j.Units[i].Sent
	}
	j.SentBytes = sent
	now := time.Now()
	// 速率采样窗：距上次采样 ≥ speedWindow 才重算 EMA（小文件批量防抖）
	if !j.rt.lastSampleAt.IsZero() && now.Sub(j.rt.lastSampleAt) >= speedWindow {
		dt := now.Sub(j.rt.lastSampleAt).Seconds()
		if dt > 0 {
			inst := float64(sent-j.rt.sampleSent) / dt
			if j.SpeedBytesPerSec == 0 {
				j.SpeedBytesPerSec = inst
			} else {
				// EMA：alpha 由半衰期与窗长推导
				alpha := 1 - expNeg(speedWindow.Seconds()/speedEMAHalfLife.Seconds())
				j.SpeedBytesPerSec = j.SpeedBytesPerSec*(1-alpha) + inst*alpha
			}
		}
		j.rt.lastSampleAt = now
		j.rt.sampleSent = sent
	}
	if j.SpeedBytesPerSec > 0 {
		j.EtaSeconds = float64(j.TotalBytes-sent) / j.SpeedBytesPerSec
		if j.EtaSeconds < 0 {
			j.EtaSeconds = 0
		}
	}
	j.rt.mu.Unlock()
	hub.dirty(j)
}

// expNeg e^-x（泰勒近似不必要，标准库足够；独立小函数避免 math 全量引入的可读噪声）
func expNeg(x float64) float64 {
	// 3s/3s 量级下逐项泰勒 4 项误差 <1e-3，够速率平滑用
	term, sum := 1.0, 1.0
	for i := 1; i <= 6; i++ {
		term *= -x / float64(i)
		sum += term
	}
	return sum
}

// progressHub 进度中心（模块级单例；jobs 保留最近 maxJobsFinished 份终态供结果卡回看）
type progressHub struct {
	mu       sync.Mutex
	current  *SyncJob
	past     []*SyncJob
	subs     func(snapshot *SyncJob)
	lastEmit time.Time
	pending  bool
	// emitTimer 节流尾沿定时器（500ms 窗内合并重复 dirty）
	emitTimer *time.Timer
}

const maxJobsFinished = 5

var hub = &progressHub{}

// setBroadcaster 注入广播口（模块 Start 装配为 notification.BroadcastEvent；
// 测试可注入桩）
func setBroadcaster(fn func(snapshot *SyncJob)) {
	hub.mu.Lock()
	hub.subs = fn
	hub.mu.Unlock()
}

// beginJob 开新任务（同刻只保留一个 running——手动与定时撞车时后到者直接
// 拒绝在 handler 层，本层兜底替换）。锁序纪律：rt.mu 与 hub.mu 不嵌套持有
// （touch/snapshot 同款）——上一任务的收口在 hub.mu 外经 demoteIfRunning
// 完成，past 入账二次入 hub.mu，两把锁互不嵌套无死锁面
func beginJob(j *SyncJob) {
	hub.mu.Lock()
	prev := hub.current
	hub.current = j
	hub.mu.Unlock()
	if prev != nil && prev.demoteIfRunning() {
		hub.mu.Lock()
		hub.past = append(hub.past, prev)
		hub.trimLocked()
		hub.mu.Unlock()
	}
	hub.emit(j)
}

func (h *progressHub) dirty(j *SyncJob) {
	h.mu.Lock()
	now := time.Now()
	// 首沿直发 + 500ms 尾沿合并：进度高频 touch 时至多每 500ms 一条广播
	if now.Sub(h.lastEmit) >= progressThrottle {
		h.lastEmit = now
		h.mu.Unlock()
		h.emit(j)
		return
	}
	if h.emitTimer != nil {
		h.mu.Unlock()
		return
	}
	h.pending = true
	h.emitTimer = time.AfterFunc(progressThrottle, func() {
		h.mu.Lock()
		h.emitTimer = nil
		if !h.pending {
			h.mu.Unlock()
			return
		}
		h.pending = false
		h.lastEmit = time.Now()
		cur := h.current
		h.mu.Unlock()
		if cur != nil {
			h.emit(cur)
		}
	})
	h.mu.Unlock()
}

func (h *progressHub) emit(j *SyncJob) {
	h.mu.Lock()
	fn := h.subs
	h.mu.Unlock()
	if fn != nil {
		fn(j.snapshot())
	}
}

func (h *progressHub) trimLocked() {
	if len(h.past) > maxJobsFinished {
		h.past = h.past[len(h.past)-maxJobsFinished:]
	}
}

// finishJob 收尾（outcome=done/partial/failed；终态也广播一次让所有标签页同帧
// 收口）。Outcome/FinishedAt 经 markFinished 入 rt.mu——在途节流尾沿定时器的
// emit→snapshot 读同锁域无撕裂
func finishJob(j *SyncJob, outcome string) {
	j.markFinished(outcome)
	hub.mu.Lock()
	hub.current = nil
	hub.past = append(hub.past, j)
	hub.trimLocked()
	hub.mu.Unlock()
	hub.emit(j)
}

// currentProgress 当前任务快照（无 running 时返回最近一份终态供结果卡回看）
func currentProgress() *SyncJob {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.current != nil {
		return hub.current.snapshot()
	}
	if n := len(hub.past); n > 0 {
		return hub.past[n-1].snapshot()
	}
	return nil
}

// syncProgressEvent WS 广播的消息 type 值（前端 opsEvents 注册同串）
const syncProgressEvent = "sync.progress"

// broadcastProgress 组合根/模块装配的默认广播口
func broadcastProgress(snap *SyncJob) {
	notification.BroadcastEvent(syncProgressEvent, snap)
}
