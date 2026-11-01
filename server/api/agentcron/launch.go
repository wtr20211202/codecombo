package agentcron

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/api/terminal"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// launcher 会话创建口（生产绑定 terminal.LaunchAgentSession，单测换桩）
type launcher = func(name, runtime, dir, launchArgs string) (*terminal.AgentLaunch, error)

// watch 已触发任务的完成回执监听条目：智能体经 ops-notify 上报 task.progress
// done/failed 时由 ai 模块观察者旁路落库（store.AgentTask），巡检逐分钟只读
// 复用该数据面回填 lastResult 并入账通知（P-20261002-15 未落地的降级路径）
type watch struct {
	cronID     string
	name       string
	extract    string    // 指标抽取规则（P-20261005-237，触发时快照；空 = 不抽取）
	launchedAt time.Time // 触发时刻（LastRunAt 语义锚点，不随后续回执漂移）
	since      time.Time
	deadline   time.Time
}

// resultLaunched 等 LastResult 稳定值（前端按值映射 i18n 文案）
const (
	resultLaunched = "launched"
	resultDone     = "done"
	resultFailed   = "failed"
	resultSkipped  = "skipped" // 前序完成触发被跳过（父失败/未执行，P-20261003-124）
	resultError    = "error"   // 入库形态 resultError + ": " + msg
)

// 错过槽处置词汇（P-20261006-22，MissedHistory 条目 Action 稳定值，前端按值
// 映射三态色标：灰 = 未开补偿跳过、绿 = 补跑发起成功、红 = 补跑发起失败）。
// 与 resultSkipped 词汇不同域（错过账 vs 运行账），agent 按 missedHistory 键
// 归属区分；补跑自身的运行终态（done/failed）照常落运行账，不在本词汇内
const (
	missedSkipped  = "skipped"   // 未开补偿：只标记不补跑
	missedCaughtUp = "caught-up" // 补跑发起成功（运行终态随后入运行账）
	missedFailed   = "failed"    // 补跑发起失败（ErrSummary 带错误摘要）
)

// launchConcurrency 单轮巡检的并发发起上限（P-20261005-216）：launch 是进程
// spawn（秒级），集中到期（整点多任务）时串行逐个发起的末位延迟可达数十秒；
// 钳值与批量拉取池（project.fetchAllConcurrency）同量级取 3——并行缩短尾延迟
// 且瞬时 spawn 压力有界
const launchConcurrency = 3

// runner 触发执行链：任务 → 会话（复用 agent 终端创建核心）→ 运行期事实落库
// → 失败入账通知。一个实例同时服务调度器到期触发与设置页「立即试跑」
type runner struct {
	launch launcher
	// tailFn 输出尾窗读取口（生产绑定 readSessionTail；单测换桩——指标抽取
	// 的会话滚回依赖面，与 launch 同款注入惯例）
	tailFn func(sessionID string) string

	mu       sync.Mutex
	checked  map[string]string // cronID → 已处理槽点（进程内去重，防同槽重复触发）
	watching map[string]watch  // sessionID → 完成回执监听（触发成功后登记）
}

func newRunner(launch launcher) *runner {
	return &runner{
		launch:   launch,
		tailFn:   readSessionTail,
		checked:  map[string]string{},
		watching: map[string]watch{},
	}
}

// markChecked 槽点去重标记置位（幂等）
func (r *runner) markChecked(cronID, key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.checked[cronID] = key
}

// checkedFor 槽点是否已处理过
func (r *runner) checkedFor(cronID, key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.checked[cronID] == key
}

// RunNow 立即试跑（设置页按钮）：与到期触发同一执行链；slot 传零值 =
// 时间戳后缀取当前时刻，且不做槽点去重（试跑不应被「今日已跑」拦截）
func (r *runner) RunNow(t store.AgentCron) (*terminal.AgentLaunch, error) {
	res, err := r.trigger(t, time.Time{})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// dueTask 收集阶段产出的待发起任务（携带计划槽点：启动阶段只消费，不再判定）
type dueTask struct {
	t    store.AgentCron
	slot time.Time
}

// runDue 单轮巡检两阶段（P-20261005-216 集中到期并发发起）：
//
//	收集阶段（串行）：到期/错过判定 + 槽点幂等标记 + 错过档处置——幂等标记
//	在启动阶段前完成，并发 worker 不再查标，防并发重判
//	启动阶段（钳 3 并发池）：逐任务 goroutine + WaitGroup + buffered chan 钳
//	（project.fetchAllProjects 同款惯例），launch（进程 spawn，秒级）并行缩短
//	集中到期的末位延迟；逐任务 panic recover 守卫，单任务发起链的 bug 不拖垮
//	同轮其余任务与调度器 goroutine
//
// 并发安全：runner 的 checked/watching 表本就有 mu 全护，record/recordMissed/
// recordRelay 走 store 仓内互斥 + filestore kind 锁，opschannel/通知/timeline
// 各自并发安全——并发面只新增「trigger 并行」本身，记账链零新增锁。
// 定时巡检专属（试跑不走评估，直接 trigger）。前序完成触发任务（P-20261003-124）
// 不参与时刻调度——由父任务完成回执经 onParentOutcome 级联驱动，这里一律跳过
func (r *runner) runDue(crons []store.AgentCron, now time.Time) {
	due := make([]dueTask, 0)
	for _, t := range crons {
		if !t.Enabled {
			continue // 停用任务：配置保留，调度跳过
		}
		if t.IsAfterTrigger() {
			continue // 依赖链任务：时刻字段不消费，等父任务回执
		}
		ev := Evaluate(t, now)
		if !ev.Due && !ev.Missed {
			continue
		}
		key := slotKey(ev.Slot)
		if r.checkedFor(t.ID, key) {
			continue // 同槽已处理（含补跑过），进程内幂等
		}
		if ev.Missed && !t.MissCatchUp {
			// 错过且未开补偿：只做标记（防同日反复判定），不补跑也不算失败；
			// 错过条目入账（P-20261006-22 可见性：跳过也是运维答案的一半——
			// 「为什么没跑」= 错过了且未开补偿）
			r.markChecked(t.ID, key)
			r.recordMissed(t.ID, ev.Slot, missedSkipped, "")
			continue
		}
		r.markChecked(t.ID, key)
		due = append(due, dueTask{t: t, slot: ev.Slot})
	}
	if len(due) == 0 {
		return
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, launchConcurrency)
	for _, d := range due {
		wg.Add(1)
		go func(d dueTask) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			defer func() {
				if rec := recover(); rec != nil {
					// 泄漏守卫：panic 是发起链的 bug 场景（正常错误走 trigger
					// 返回值），只记日志围堵，不伪装成业务失败入账
					slog.Error("agentcron trigger panicked", "id", d.t.ID, "name", d.t.Name, "panic", rec)
				}
			}()
			if _, err := r.trigger(d.t, d.slot); err != nil {
				// 补跑发起失败：红档入错过历史（错误明细已随 error: 入运行历史 +
				// 失败通知，这里只记槽点维度的事实）
				r.recordMissed(d.t.ID, d.slot, missedFailed, err.Error())
				return
			}
			r.recordMissed(d.t.ID, d.slot, missedCaughtUp, "")
		}(d)
	}
	wg.Wait()
}

// trigger 触发执行链主体：组装 launchArgs → 创建 agent 会话 → lastRunAt/
// lastResult 落库 → 成功登记完成回执监听 / 失败入账通知。slot 为零值时时间
// 戳取当前时刻（试跑路径）。
// 自动接力（P-20261005-207）为 launch 前置一步：配置了 RelayFrom 的任务先解析
// 源会话结论装箱成前言再拼接——前言注入成功与否不影响发起（降级语义见
// relay.go 头注），接力事实照实落 LastRelay 账、降级并发 task.relaySkipped 事件
func (r *runner) trigger(t store.AgentCron, slot time.Time) (*terminal.AgentLaunch, error) {
	stamp := slot
	if stamp.IsZero() {
		// 试跑路径：按任务评估时区取当下（P-20261005-217）——[scheduled] 后缀与
		// {date}/{time}/{weekday} 展开同源同区，agent 读到的时刻语义与任务配置一致
		stamp = time.Now().In(TaskLocation(t.Timezone))
	}
	args := ComposeLaunchArgs(t.Prompt, stamp)
	preface, note := relayPreface(t, stamp)
	if note != "" {
		recordRelay(t.ID, note)
		if strings.HasPrefix(note, relayNoteSkippedPrefix) {
			emitRelaySkipped(t, note)
		}
	}
	if preface != "" {
		args = preface + " " + args
	}
	res, err := r.launch(t.Name, t.Runtime, t.Dir, args)
	now := time.Now()
	if err != nil {
		r.record(t.ID, now, resultError+": "+err.Error(), err.Error())
		notifyLaunchFailed(t, err, slot)
		// 启动失败 = 父任务从未执行：子任务两档都不触发，一律标 skipped
		//（P-20261003-124 失败传播；级联触发链复用本函数，孙级随子任务自身
		// 的启动失败继续传播，链无环由保存口环检测保证）
		r.onParentOutcome(t.ID, resultError)
		return nil, err
	}
	r.record(t.ID, now, resultLaunched, "")
	r.addWatch(watch{
		cronID:     t.ID,
		name:       t.Name,
		extract:    t.Extract,
		launchedAt: now,
		since:      now,
		deadline:   now.Add(watchTimeout),
	}, res.ID)
	return res, nil
}

// record 运行期事实落库（失败仅告警：调度主链路不因记账失败中断）。
// errSummary 失败摘要随行入运行历史（store 侧 rune 截断）
func (r *runner) record(id string, at time.Time, result, errSummary string) {
	if err := store.Get().AgentCron.RecordRun(id, at, result, errSummary); err != nil {
		slog.Warn("agentcron record run failed", "id", id, "err", err)
	}
}

// recordMissed 错过槽事实落库（P-20261006-22；record 同款容错——记账失败仅
// 告警，调度主链路不因错过历史中断）。slot 为判定的计划槽点，action 词汇见
// missedSkipped 等常量
func (r *runner) recordMissed(id string, slot time.Time, action, errSummary string) {
	if err := store.Get().AgentCron.RecordMissed(id, slot, action, errSummary); err != nil {
		slog.Warn("agentcron record missed failed", "id", id, "err", err)
	}
}

// addWatch 登记完成回执监听（sessionID 为空时不登记：无归属锚点无从对账）
func (r *runner) addWatch(w watch, sessionID string) {
	if sessionID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.watching[sessionID] = w
}

// pollWatches 完成回执巡检：AgentTask 落库流（最新在前）中找本会话自触发后
// 的 task.progress done/failed，命中即回填 lastResult 并入账通知、解除监听；
// 超时静默解除（结果停留 launched）。智能体未上报进度（普通 shell 会话 /
// 未带 SC skill 的运行时）的任务停留 launched，属预期降级语义
func (r *runner) pollWatches() {
	r.mu.Lock()
	if len(r.watching) == 0 {
		r.mu.Unlock()
		return
	}
	now := time.Now()
	// 快照活监听 + 顺带清超时项（自有内存表，锁内直接改）；查库（List 走
	// 文件系统）在锁外进行
	watching := make(map[string]watch, len(r.watching))
	for sid, w := range r.watching {
		if now.After(w.deadline) {
			delete(r.watching, sid)
			continue
		}
		watching[sid] = w
	}
	r.mu.Unlock()

	if len(watching) == 0 {
		return
	}
	tasks, err := store.Get().AgentTask.List(200, "")
	if err != nil {
		return
	}
	for sid, w := range watching {
		status, detail, _ := findFinalStatus(tasks, sid, w.since)
		if status == "" {
			continue
		}
		r.mu.Lock()
		delete(r.watching, sid)
		r.mu.Unlock()
		// LastRunAt 保持触发时刻语义（回执只翻写结果）；失败摘要随行入历史
		summary := ""
		if status == resultFailed {
			summary = detail
		}
		r.record(w.cronID, w.launchedAt, status, summary)
		notifyRunFinished(w.name, status, detail, sid)
		// 指标抽取（P-20261005-237）：完成回执落定后按触发时快照的规则从输出
		// 尾窗取数值入任务时序（无规则跳过；无命中不落点——「无数据」如实，
		// 见 extract.go 头注）
		if w.extract != "" {
			extractMetricPoint(w.cronID, w.extract, sid, r.tailFn)
		}
		// 前序完成触发的级联收口（P-20261003-124）：父回执落定后按档位处置
		// 其子任务（触发 / 标 skipped）
		r.onParentOutcome(w.cronID, status)
	}
}

// onParentOutcome 父任务结局 → 子任务处置的唯一收口（P-20261003-124）：
//   - done：子任务按档位触发（success/always 都接受）
//   - failed：档位 success → 子标 skipped 入运行历史（失败传播：前序失败时
//     后续任务不得在错误状态上执行）；档位 always → 照常触发（完成即触发）
//   - error:（启动失败，父从未执行）：两档都不触发，子一律标 skipped
//
// 触发复用 trigger 全链（记账/回执监听/失败通知/更下层级联）；停用子任务与
// 非本父的 after 任务一律跳过。父任务已删除则无从级联（子任务保留配置，
// 等父重建或人工处置——删除口另有「有子任务拒绝删除」守卫，此处兜底）
func (r *runner) onParentOutcome(parentID, status string) {
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		return
	}
	parentName := ""
	found := false
	for _, c := range crons {
		if c.ID == parentID {
			parentName, found = c.Name, true
			break
		}
	}
	if !found {
		return
	}
	for _, child := range crons {
		if !child.Enabled || !child.IsAfterTrigger() || child.AfterCronID != parentID {
			continue
		}
		if !AfterModeAccepts(child.AfterMode, status) {
			summary := fmt.Sprintf("predecessor %q %s", parentName, status)
			r.record(child.ID, time.Now(), resultSkipped, summary)
			continue
		}
		if r.liveWatchFor(child.ID) != "" {
			// 重入策略（拍板）：子任务已有在途运行（上次触发的会话尚未回报
			// 终态）→ 静默跳过本次级联。一子任务同时至多一个在途会话，防父
			// 任务短间隔重复完成（试跑+到点）堆叠并行子会话；子任务自身回执
			// 照常落历史，父任务第二次完成在父历史可查。不记 skipped：在途
			// 任务 LastResult 仍是 launched，记账会假象翻写
			slog.Info("agentcron: cascade skipped, child already in flight", "child", child.Name)
			continue
		}
		_, _ = r.trigger(child, time.Time{})
	}
}

// liveWatchFor 任务是否有在途回执监听（有 = 上次触发的会话尚未回报终态）。
// watching 以 sessionID 为键、量级 = 在途任务数（用户手工维护清单 + 24h
// deadline 上界），线性扫足够
func (r *runner) liveWatchFor(cronID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for sid, w := range r.watching {
		if w.cronID == cronID {
			return sid
		}
	}
	return ""
}

// findFinalStatus 在落库任务流（最新在前）中找归属会话（SessionID 以终端 ID
// 为首段，ai 模块观察者拼 "terminalId sessionId"）、触发之后的终结态上报。
// 返回首个命中的 (status, step 摘要, 事件时刻)；无命中返回空串
func findFinalStatus(tasks []store.AgentTask, sessionID string, since time.Time) (string, string, time.Time) {
	for _, t := range tasks {
		if t.Type != opschannel.EventTaskProgress || t.At.Before(since) {
			continue
		}
		if t.SessionID != sessionID && !strings.HasPrefix(t.SessionID, sessionID+" ") {
			continue
		}
		if t.Status != resultDone && t.Status != resultFailed {
			continue
		}
		return t.Status, t.Step, t.At
	}
	return "", "", time.Time{}
}

// notifyLaunchFailed 发起失败入账通知中心（error 类）。Action='cron-retry'
// （P-20261006-14 失败态行动化对称）：与完成通知 terminal 直达（notifyRunFinished）
// 同族——失败恢复从「开设置→找任务→点试跑」三步收一点。payload 为 JSON 单串
// {cronId,slot}（ActionPayload 单槽字符串承载双值的形态）：cronId 寻址既有试跑
// 端点 POST /api/agent-crons/:id/run，slot 是失败当次的计划槽点（试跑路径零值
// 取当下）供前端语义注记——重试本身走 RunNow 既有语义按当下发起，不回补历史
// 槽点。核对面：试跑路径不经 runDue 的 checkedFor 幂等标记（trigger 直调），
// 同槽去重无冲突；重试再失败经本函数再入账（用户手动再点，服务端不自动递归
// ——重试风暴防线）
func notifyLaunchFailed(t store.AgentCron, err error, slot time.Time) {
	stamp := slot
	if stamp.IsZero() {
		stamp = time.Now() // 试跑路径（RunNow）槽点零值，与 trigger 时间戳同口径
	}
	store.Get().Notification.Add(notification.Notification{
		Type:          "error",
		Category:      notification.CategoryTask,
		TitleKey:      "agentcron.notify.launchFailed.title",
		BodyKey:       "agentcron.notify.launchFailed.body",
		Title:         "定时任务发起失败",
		Body:          fmt.Sprintf("%s: %v", t.Name, err),
		MsgParams:     map[string]any{"name": t.Name, "error": err.Error()},
		Action:        "cron-retry",
		ActionPayload: fmt.Sprintf(`{"cronId":%q,"slot":%q}`, t.ID, stamp.Format(time.RFC3339)),
	})
}

// notifyRunFinished 完成/失败回执入账通知中心，Action 直达触发会话
// （P-31 action 机制 terminal:<sessionId>）
func notifyRunFinished(name, status, step, sessionID string) {
	if status == resultDone {
		store.Get().Notification.Add(notification.Notification{
			Type:          "success",
			Category:      notification.CategoryTask,
			TitleKey:      "agentcron.notify.done.title",
			BodyKey:       "agentcron.notify.done.body",
			Title:         "定时任务完成",
			Body:          name,
			MsgParams:     map[string]any{"name": name},
			Action:        "terminal",
			ActionPayload: sessionID,
		})
		return
	}
	detail := step
	if detail == "" {
		detail = "task reported failure"
	}
	if len(detail) > 200 {
		detail = detail[:200]
	}
	store.Get().Notification.Add(notification.Notification{
		Type:          "error",
		Category:      notification.CategoryTask,
		TitleKey:      "agentcron.notify.failedRun.title",
		BodyKey:       "agentcron.notify.failedRun.body",
		Title:         "定时任务失败",
		Body:          fmt.Sprintf("%s: %s", name, detail),
		MsgParams:     map[string]any{"name": name, "detail": detail},
		Action:        "terminal",
		ActionPayload: sessionID,
	})
}
