// Package recording 审批窗口过程留证（P-20261001-15）：
// 仅在 ops-confirm 产生到裁决后短窗口开启 PTY tap，录下高危操作前后的屏幕
// 实况（asciinema v2 cast 追加写，写盘前流式遮蔽敏感值）。审批事件带
// sessionId，窗口起止精确联动：
//
//	approval.pending  → 对应会话开录（同会话并发审批并入同一录制并续窗）
//	approval.resolved → 最后一个 pending 裁决后 +graceStopDelay 缓冲洗停
//	会话退出/被关      → 已录部分立即落盘（handlers 被清空的 Kill 路径由
//	                     terminal.AddOnChange 兜底）
//
// 录制是独立持久化对象：元数据索引进车道 1（store.Recording，含审批标记/
// 起止/大小），cast 文件本体走车道 2 artifacts/recordings/；保留策略长保留档
// （每日 ticker 清理），不挂靠会话生命周期。全局设置默认关（隐私边界）。
package recording

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/mask"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

const (
	// maxWindowDuration 单窗口硬上限：resolved 事件丢失（重启/广播丢弃）时
	// 兜底停录，防永录吞磁盘
	maxWindowDuration = 15 * time.Minute
	// recordingRetention 保留策略长保留档：证据类数据长于一般业务 30 天档
	//（7985583 保留策略治理以来的最长档），每日 ticker 清理
	recordingRetention = 90 * 24 * time.Hour
)

// graceStopDelay 裁决后缓冲窗口：高危操作的实际执行发生在放行之后，
// 缓冲几秒让「执行过程+输出」进证据。var 仅为窗口联动单测可注入短时延
var graceStopDelay = 10 * time.Second

// TapSession 可录制会话能力抽象（*terminal.Session 结构性满足）；
// 测试以桩实现注入
type TapSession interface {
	OnOutput(handler func(data []byte)) (unregister func())
	OnExit(handler func(exitCode int)) (unregister func())
	Size() (cols, rows uint16)
}

// sessionLookup 会话解析：默认走 terminal.DefaultManager（与 terminal 包级
// 单例先例一致）；测试经 SetSessionLookup 注入桩
var (
	lookupMu      sync.Mutex
	sessionLookup = func(id string) TapSession {
		return terminal.DefaultManager.GetSession(id)
	}
)

// SetSessionLookup 覆盖会话解析（测试注入；nil 恢复默认）
func SetSessionLookup(fn func(id string) TapSession) {
	lookupMu.Lock()
	defer lookupMu.Unlock()
	if fn == nil {
		sessionLookup = func(id string) TapSession {
			return terminal.DefaultManager.GetSession(id)
		}
		return
	}
	sessionLookup = fn
}

func lookupSession(id string) TapSession {
	lookupMu.Lock()
	fn := sessionLookup
	lookupMu.Unlock()
	return fn(id)
}

// Manager 录制窗口管理器：审批事件驱动的录制生命周期
type Manager struct {
	mu     sync.Mutex
	active map[string]*activeRec // sessionId → 活动录制
}

// DefaultManager 包级单例（terminal.DefaultManager 同款先例）：模块装配使用，
// API 层删除录制前经 Finalize 收尾活动窗口
var DefaultManager = NewManager()

// NewManager 创建管理器
func NewManager() *Manager {
	return &Manager{active: make(map[string]*activeRec)}
}

// Finalize 按 recording ID 立即收尾活动窗口（导出供 API 层删除前调用；幂等）
func (m *Manager) Finalize(recID string) { m.finalize(recID) }

// activeRec 一次活动录制：cast 写入 + 遮蔽器 + 窗口状态。
// 锁纪律：m.mu 只护 active map（查到即放，绝不在持 m.mu 时取 ar.mu）；
// ar.mu 护写盘与状态，仅 tap 回调（readLoop goroutine）与窗口管理路径竞争
type activeRec struct {
	mu         sync.Mutex
	rec        store.Recording
	pendings   map[string]struct{} // 窗口内未裁决审批 id（最后一个裁决触发缓冲洗停）
	mask       *mask.Masker
	w          *castWriter
	sess       TapSession
	mgr        *Manager // 反持管理器：timer/失败路径从 active 表摘除自身
	tapCancel  func()
	exitCancel func()
	graceTimer *time.Timer
	maxTimer   *time.Timer
	stopped    bool
}

// HandleEvent opschannel 观察者入口（审批联动 + settings.changed 停录）
func (m *Manager) HandleEvent(ev opschannel.Event) {
	switch ev.Type {
	case opschannel.EventApprovalPending:
		var a store.AgentApproval
		if b, err := json.Marshal(ev.Payload); err != nil || json.Unmarshal(b, &a) != nil {
			return
		}
		m.onPending(a)
	case opschannel.EventApprovalResolved:
		var p struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionId"`
		}
		if b, err := json.Marshal(ev.Payload); err != nil || json.Unmarshal(b, &p) != nil {
			return
		}
		m.onResolved(p.ID, p.SessionID)
	case opschannel.EventSettingsChanged:
		// 隐私边界即时生效：录制开关被关 → 活动录制立即收尾（不等到裁决）
		if !recordingEnabled() {
			m.StopAll("approval recording disabled")
		}
	}
}

// recordingEnabled 全局开关（默认关——隐私边界）
func recordingEnabled() bool {
	if cfg := store.Get().Settings.Get(); cfg != nil {
		return cfg.Server.ApprovalRecordingOrDefault()
	}
	return false
}

// onPending 审批产生：开录或并入同会话活动窗口
func (m *Manager) onPending(a store.AgentApproval) {
	if !recordingEnabled() || a.SessionID == "" {
		return
	}
	sess := lookupSession(a.SessionID)
	if sess == nil {
		// 审批挂在已结束会话上（agentguard 非终端场景 sessionId 常为空）：
		// 无 PTY 可 tap，无从录制
		return
	}

	m.mu.Lock()
	ar, ok := m.active[a.SessionID]
	if !ok {
		ar = &activeRec{
			rec: store.Recording{
				ID:          store.NewRecordingID(),
				SessionID:   a.SessionID,
				ApprovalIDs: []string{a.ID},
				Agent:       a.Agent,
				Op:          a.Op,
				Target:      a.Target,
				Status:      store.RecordingStatusRecording,
				StartedAt:   time.Now(),
			},
			pendings: map[string]struct{}{a.ID: {}},
			mask:     mask.NewMasker(),
			sess:     sess,
			mgr:      m,
		}
		m.active[a.SessionID] = ar
		m.mu.Unlock()
		ar.start()
		return
	}
	m.mu.Unlock()
	// 同会话并发审批：并入同一录制并续窗（取消既定的缓冲洗停）
	ar.attachApproval(a)
}

// onResolved 审批裁决：最后一个 pending 裁决后调度缓冲洗停。
// pendings 并发面：pending/resolved 各自来自不同 HTTP goroutine 的同步广播，
// 读写必须持 ar.mu（map 并发读写会直接 panic）
func (m *Manager) onResolved(approvalID, sessionID string) {
	m.mu.Lock()
	var target *activeRec
	for _, ar := range m.active {
		ar.mu.Lock()
		_, is := ar.pendings[approvalID]
		ar.mu.Unlock()
		if is {
			target = ar
			break
		}
	}
	if target == nil && sessionID != "" {
		// pending 与 resolved 间跨重启（或 pending 广播丢弃）：
		// 以 sessionId 兜底命中活动录制
		target = m.active[sessionID]
	}
	if target == nil {
		m.mu.Unlock()
		return
	}
	target.mu.Lock()
	delete(target.pendings, approvalID)
	last := len(target.pendings) == 0
	target.mu.Unlock()
	m.mu.Unlock()

	if last {
		target.scheduleStop()
	}
}

// sessionChanged 会话集合变更（terminal.AddOnChange）：会话被 Kill 时
// onOutput/onExit handlers 已被清空，靠此对账收尾（已录部分落盘）
func (m *Manager) sessionChanged() {
	m.mu.Lock()
	var orphans []*activeRec
	for sid, ar := range m.active {
		if lookupSession(sid) == nil {
			orphans = append(orphans, ar)
			delete(m.active, sid)
		}
	}
	m.mu.Unlock()
	for _, ar := range orphans {
		ar.stop()
	}
}

// StopAll 收尾全部活动录制（模块 Stop / 开关关闭）
func (m *Manager) StopAll(reason string) {
	m.mu.Lock()
	all := make([]*activeRec, 0, len(m.active))
	for sid, ar := range m.active {
		all = append(all, ar)
		delete(m.active, sid)
	}
	m.mu.Unlock()
	for _, ar := range all {
		slog.Info("recording: force stop", "id", ar.recID(), "reason", reason)
		ar.stop()
	}
}

// finalize 按 recording ID 收尾（grace/max timer 回调入口）
func (m *Manager) finalize(recID string) {
	m.mu.Lock()
	var target *activeRec
	for sid, ar := range m.active {
		if ar.rec.ID == recID {
			target = ar
			delete(m.active, sid)
			break
		}
	}
	m.mu.Unlock()
	if target != nil {
		target.stop()
	}
}

// start 拉起一次录制：cast 文件 + tap 注册 + 元数据落库 + 硬上限计时。
// 失败静默放弃（录制是旁路增强，不阻断审批流）
func (ar *activeRec) start() {
	recID := ar.rec.ID
	cols, rows := ar.sess.Size()
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	w, err := newCastWriter(recID, cols, rows, ar.rec.StartedAt)
	if err != nil {
		slog.Warn("recording: cast writer create failed, skip recording", "id", recID, "err", err)
		ar.mgr.discard(ar)
		return
	}
	ar.mu.Lock()
	ar.w = w
	ar.mu.Unlock()

	// tap 注册在元数据落库前：防「索引已可见但字节流还没接上」的窗口期。
	// OnOutput/OnExit 由 readLoop/waitLoop 快照调用，注册即生效
	ar.tapCancel = ar.sess.OnOutput(ar.onOutput)
	ar.exitCancel = ar.sess.OnExit(func(int) { ar.mgr.finalize(recID) })
	ar.maxTimer = time.AfterFunc(maxWindowDuration, func() { ar.mgr.finalize(recID) })

	if err := store.Get().Recording.Save(ar.snapshotRec()); err != nil {
		slog.Warn("recording: metadata save failed", "id", recID, "err", err)
	}
	slog.Info("recording: approval window opened", "id", recID,
		"session", ar.rec.SessionID, "approval", ar.rec.ApprovalIDs, "op", ar.rec.Op)
}

// attachApproval 同会话并发审批并入：追加审批标记 + 取消既定缓冲洗停
func (ar *activeRec) attachApproval(a store.AgentApproval) {
	ar.mu.Lock()
	if ar.stopped {
		ar.mu.Unlock()
		return
	}
	dup := false
	for _, id := range ar.rec.ApprovalIDs {
		if id == a.ID {
			dup = true
			break
		}
	}
	if !dup {
		ar.rec.ApprovalIDs = append(ar.rec.ApprovalIDs, a.ID)
	}
	ar.pendings[a.ID] = struct{}{}
	if ar.rec.Agent == "" {
		ar.rec.Agent = a.Agent
	}
	if ar.graceTimer != nil {
		ar.graceTimer.Stop()
		ar.graceTimer = nil
	}
	ar.mu.Unlock()
	ar.saveMeta()
}

// scheduleStop 缓冲洗停调度（重复裁决幂等：timer 已设则跳过）。
// 回调走 mgr.finalize：从 active 表摘除后再收尾——只 stop 会把已完成的
// 录制永留 active 表（泄漏 + 后续 onPending 误并入死窗口）
func (ar *activeRec) scheduleStop() {
	ar.mu.Lock()
	if ar.stopped || ar.graceTimer != nil {
		ar.mu.Unlock()
		return
	}
	ar.graceTimer = time.AfterFunc(graceStopDelay, func() {
		ar.mgr.finalize(ar.recID())
	})
	ar.mu.Unlock()
}

// onOutput PTY tap 热路径：遮蔽后追加写（readLoop 单 goroutine）。
// 写盘全程持 ar.mu——stop 收尾的 flushTail 与本写入串行化（否则遮蔽器
// 状态与文件偏移并发损坏）；代价是收尾等一次在途写，可接受
func (ar *activeRec) onOutput(data []byte) {
	ar.mu.Lock()
	if ar.stopped || ar.w == nil {
		ar.mu.Unlock()
		return
	}
	if err := ar.w.writeOutput(data, ar.mask); err != nil {
		// 写盘失败：证据链断裂，立即收尾（宁短勿错）。
		// 锁内不做收尾（stop 会再取 ar.mu）——先释放再走 finalize（幂等）
		ar.mu.Unlock()
		slog.Warn("recording: cast write failed, stop", "id", ar.recID(), "err", err)
		ar.mgr.finalize(ar.recID())
		return
	}
	ar.mu.Unlock()
}

// stop 收尾：停 timer、摘 tap、flush 遮蔽器滞留字节、更新元数据。
// 幂等（exit 回调 / change 对账 / timer 三路竞争同一收尾）
func (ar *activeRec) stop() {
	ar.mu.Lock()
	if ar.stopped {
		ar.mu.Unlock()
		return
	}
	ar.stopped = true
	if ar.graceTimer != nil {
		ar.graceTimer.Stop()
		ar.graceTimer = nil
	}
	if ar.maxTimer != nil {
		ar.maxTimer.Stop()
		ar.maxTimer = nil
	}
	w := ar.w
	ar.w = nil
	ar.mu.Unlock()

	if ar.tapCancel != nil {
		ar.tapCancel()
	}
	if ar.exitCancel != nil {
		ar.exitCancel()
	}
	size := int64(0)
	if w != nil {
		_ = w.flushTail(ar.mask)
		size = w.size
		_ = w.close()
	}

	rec := ar.snapshotRec()
	now := time.Now()
	rec.StoppedAt = &now
	rec.SizeBytes = size
	rec.Status = store.RecordingStatusCompleted
	if err := store.Get().Recording.Save(rec); err != nil {
		slog.Warn("recording: finalize metadata save failed", "id", rec.ID, "err", err)
	}
	slog.Info("recording: approval window closed", "id", rec.ID,
		"session", rec.SessionID, "size", size)
}

// discard start 失败路径：从 active 表移除，不留半态
func (m *Manager) discard(ar *activeRec) {
	m.mu.Lock()
	cur, ok := m.active[ar.rec.SessionID]
	if ok && cur == ar {
		delete(m.active, ar.rec.SessionID)
	}
	m.mu.Unlock()
}

func (ar *activeRec) snapshotRec() store.Recording {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	return ar.rec
}

func (ar *activeRec) saveMeta() {
	if err := store.Get().Recording.Save(ar.snapshotRec()); err != nil {
		slog.Warn("recording: metadata save failed", "id", ar.recID(), "err", err)
	}
}

func (ar *activeRec) recID() string { return ar.rec.ID }

// ============== 保留策略与启动自愈 ==============

// Sweep 保留策略清理（每日 ticker）：过期元数据 + 对应 cast 文件；
// 反向孤儿（元数据丢失的 cast 文件，如崩溃残留）一并删除
func (m *Manager) Sweep() {
	cutoff := time.Now().Add(-recordingRetention)
	ids, err := store.Get().Recording.CleanupBefore(cutoff)
	if err != nil {
		slog.Warn("recording: retention cleanup failed", "err", err)
	}
	for _, id := range ids {
		if err := os.Remove(CastPath(id)); err != nil && !os.IsNotExist(err) {
			slog.Warn("recording: cast file remove failed", "id", id, "err", err)
		}
	}
	if len(ids) > 0 {
		slog.Info("recording: retention cleanup", "removed", len(ids))
	}
	m.removeOrphanCasts()
}

// removeOrphanCasts 删除无元数据索引的 cast 文件（车道 2 文件不允许脱离
// 车道 1 索引存在——不可查询的落盘即泄漏）
func (m *Manager) removeOrphanCasts() {
	entries, err := os.ReadDir(ArtifactsDir())
	if err != nil {
		return
	}
	list, err := store.Get().Recording.List()
	if err != nil {
		return
	}
	known := make(map[string]struct{}, len(list))
	for _, rec := range list {
		known[rec.ID] = struct{}{}
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".cast") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".cast")
		if _, ok := known[id]; ok {
			continue
		}
		if err := os.Remove(CastPath(id)); err == nil {
			slog.Info("recording: orphan cast removed", "id", id)
		}
	}
}

// HealStale 启动自愈：启动期 active 表为空，任何仍处 recording 态的元数据
// 都是上次进程中断的残留（含 tmux 恢复会话——恢复后 tap 未接上，不算在录），
// 统一标记完成、SizeBytes 按实际文件修正——索引不留永假的 recording 态
func (m *Manager) HealStale() {
	list, err := store.Get().Recording.List()
	if err != nil {
		return
	}
	for _, rec := range list {
		if rec.Status != store.RecordingStatusRecording {
			continue
		}
		stopped := rec.StartedAt
		rec.StoppedAt = &stopped
		if fi, err := os.Stat(CastPath(rec.ID)); err == nil {
			rec.SizeBytes = fi.Size()
		}
		rec.Status = store.RecordingStatusCompleted
		if err := store.Get().Recording.Save(rec); err != nil {
			slog.Warn("recording: stale heal save failed", "id", rec.ID, "err", err)
		} else {
			slog.Info("recording: stale recording healed", "id", rec.ID)
		}
	}
}
