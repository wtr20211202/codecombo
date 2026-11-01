package agentcron

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/api/terminal"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 调度器与触发链单测（P-20261002-43）：launch 经桩注入捕获参数，存储用真实
// filestore（单文档数组仓储的读改写路径一并覆盖），通知入账走真实通知存储

// testEnv 单测装配：全局 store + 桩 launch（捕获触发参数，按脚本返回）。
// got 加锁：runDue 经钳 3 并发池并行调桩（P-20261005-216），桩自身须并发安全
// （生产侧 LaunchAgentSession 经 HTTP 面本就并发可达，桩对齐该契约）
type testEnv struct {
	module *Module
	mu     sync.Mutex
	got    []launchCall
	failOn map[string]error // 按任务名注入失败
}

type launchCall struct {
	name, runtime, dir, launchArgs string
}

func (e *testEnv) record(call launchCall) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.got = append(e.got, call)
}

// snapshot 桩调用记录的锁内拷贝（断言读侧与并发写侧同锁）
func (e *testEnv) snapshot() []launchCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]launchCall(nil), e.got...)
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	env := &testEnv{failOn: map[string]error{}}
	env.module = newModuleWithLauncher(func(name, runtime, dir, launchArgs string) (*terminal.AgentLaunch, error) {
		env.record(launchCall{name, runtime, dir, launchArgs})
		if err := env.failOn[name]; err != nil {
			return nil, err
		}
		return &terminal.AgentLaunch{
			ID: "agent-" + name, Name: name, Path: dir, CreatedAt: time.Now(),
			Runtime: runtime, Launched: true,
		}, nil
	})
	return env
}

func mustCreate(t *testing.T, input store.AgentCron) store.AgentCron {
	t.Helper()
	c, err := store.Get().AgentCron.Create(input)
	if err != nil {
		t.Fatalf("create cron: %v", err)
	}
	return *c
}

func mustGet(t *testing.T, id string) store.AgentCron {
	t.Helper()
	c, err := store.Get().AgentCron.Get(id)
	if err != nil {
		t.Fatalf("get cron: %v", err)
	}
	return *c
}

func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
}

func TestRunDue_TriggersDueTaskAndRecords(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{
		Name: "夜间审查", Hour: 2, Minute: 0, Prompt: "审查当日改动", Dir: "D:/repo", Enabled: true,
	})
	// 槽点 + 30s 的巡检：到点触发
	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)

	if len(env.snapshot()) != 1 {
		t.Fatalf("expect 1 launch, got %d", len(env.snapshot()))
	}
	call := env.snapshot()[0]
	if call.name != "夜间审查" || call.dir != "D:/repo" {
		t.Fatalf("launch args mismatch: %+v", call)
	}
	// prompt 经服务端常量模板组装：单行 + 计划槽点时间戳
	if !strings.Contains(call.launchArgs, "审查当日改动") || !strings.Contains(call.launchArgs, "[scheduled 2026-10-02 02:00") {
		t.Fatalf("launchArgs = %q", call.launchArgs)
	}
	after := mustGet(t, created.ID)
	if after.LastResult != resultLaunched {
		t.Fatalf("lastResult = %q, want launched", after.LastResult)
	}
	if after.LastRunAt.IsZero() {
		t.Fatal("lastRunAt should be recorded")
	}
}

func TestRunDue_SkipsDisabled(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "停用", Hour: 2, Minute: 0, Prompt: "p", Enabled: false})
	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)
	if len(env.snapshot()) != 0 {
		t.Fatalf("disabled task should be skipped, got %d launches", len(env.snapshot()))
	}
	if c := mustGet(t, created.ID); !c.LastRunAt.IsZero() {
		t.Fatal("disabled task should not record runs")
	}
}

func TestRunDue_NoDuplicateWithinWindow(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "每日", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	// 窗口内两轮巡检（LastRunAt 已随首跑落库，但同槽判定仍可能先行）：
	// 进程内槽点标记兜底幂等
	now1 := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now1)
	// 模拟第一轮落库前的竞态视图：仍带旧 LastRunAt 的同任务再来一轮
	stale := created
	env.module.r.runDue([]store.AgentCron{stale}, now1.Add(20*time.Second))
	if len(env.snapshot()) != 1 {
		t.Fatalf("same slot should launch once, got %d", len(env.snapshot()))
	}
}

func TestRunDue_MissedWithoutCatchUpSkipped(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "错过不补", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	// 服务 09:00 启动，槽点 02:00 已过窗口，未开补偿 → 不补跑
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)
	env.module.r.runDue([]store.AgentCron{created}, now.Add(time.Minute))
	if len(env.snapshot()) != 0 {
		t.Fatalf("missed without catch-up should not run, got %d", len(env.snapshot()))
	}
	if c := mustGet(t, created.ID); !c.LastRunAt.IsZero() || c.LastResult != "" {
		t.Fatal("missed skip should not touch run facts")
	}
	// 错过条目入账（P-20261006-22）：灰档 skipped，槽点 = 判定的计划槽点；
	// 第二轮巡检同槽再判被进程内标记挡住，不堆重复条目
	c := mustGet(t, created.ID)
	if len(c.MissedHistory) != 1 {
		t.Fatalf("missed history should have exactly one entry, got %d", len(c.MissedHistory))
	}
	if c.MissedHistory[0].Action != missedSkipped || c.MissedHistory[0].ErrSummary != "" {
		t.Fatalf("missed entry = %+v, want skipped with no summary", c.MissedHistory[0])
	}
	if want := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local); !c.MissedHistory[0].Slot.Equal(want) {
		t.Fatalf("missed slot = %v, want %v", c.MissedHistory[0].Slot, want)
	}
}

func TestRunDue_MissedWithCatchUpCompensates(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "错过补跑", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, MissCatchUp: true})
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)
	env.module.r.runDue([]store.AgentCron{created}, now.Add(time.Minute))
	if len(env.snapshot()) != 1 {
		t.Fatalf("missed with catch-up should run exactly once, got %d", len(env.snapshot()))
	}
	// 补跑的时间戳后缀取计划槽点（prompt 中「当日」解释锚点不漂移）
	if !strings.Contains(env.snapshot()[0].launchArgs, "[scheduled 2026-10-02 02:00") {
		t.Fatalf("catch-up should stamp the missed slot, got %q", env.snapshot()[0].launchArgs)
	}
	// 错过条目入账（P-20261006-22）：绿档 caught-up，且错过账不吞运行账
	//（补跑发起的 launched 事实照常落 History）
	c := mustGet(t, created.ID)
	if len(c.MissedHistory) != 1 || c.MissedHistory[0].Action != missedCaughtUp {
		t.Fatalf("missed history = %+v, want one caught-up entry", c.MissedHistory)
	}
	if c.LastResult != resultLaunched || len(c.History) != 1 {
		t.Fatalf("catch-up run facts diverged: lastResult=%q history=%d", c.LastResult, len(c.History))
	}
}

func TestRunDue_MissedCatchUpLaunchFailureRecordsFailed(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "补跑失败", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, MissCatchUp: true})
	env.failOn["补跑失败"] = errors.New("directory does not exist")
	now := time.Date(2026, 10, 2, 9, 0, 0, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)
	// 错过条目入账（P-20261006-22）：红档 failed 带错误摘要；运行账照常记
	// error（LaunchAgentSession 失败链），两账各记各的事实
	c := mustGet(t, created.ID)
	if len(c.MissedHistory) != 1 || c.MissedHistory[0].Action != missedFailed {
		t.Fatalf("missed history = %+v, want one failed entry", c.MissedHistory)
	}
	if c.MissedHistory[0].ErrSummary != "directory does not exist" {
		t.Fatalf("missed errSummary = %q, want launch error", c.MissedHistory[0].ErrSummary)
	}
	if !strings.HasPrefix(c.LastResult, resultError+":") {
		t.Fatalf("lastResult = %q, want error prefix (run account intact)", c.LastResult)
	}
}

// TestRunDue_ConcurrentLaunchClampedToThree（P-20261005-216）：5 个同槽到期任务
// 经钳 3 并发池发起——屏障式确定性断言（非计时启发）：
//   - 桩 launch 阻塞在 release 上不返回 → 钳 3 语义下恰有 3 个任务进入 launch
//     （第 4/5 个 worker 拿不到信号量；串行实现只进 1 个 → 等第 3 个信号超时即红）
//   - maxInFlight == 3：并发上限未被突破（无钳实现会到 5）
//   - 放行后 5 个任务全部恰发起一次、记账/回执监听齐备，同槽幂等标记未被并发破坏
func TestRunDue_ConcurrentLaunchClampedToThree(t *testing.T) {
	env := newTestEnv(t)
	var inFlight, maxInFlight atomic.Int32
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	blockedLauncher := env.module.r.launch // 原始记录桩：计数/记账由它单点承担
	env.module.r.launch = func(name, runtime, dir, launchArgs string) (*terminal.AgentLaunch, error) {
		cur := inFlight.Add(1)
		for {
			m := maxInFlight.Load()
			if cur <= m || maxInFlight.CompareAndSwap(m, cur) {
				break
			}
		}
		started <- struct{}{}
		<-release
		inFlight.Add(-1)
		return blockedLauncher(name, runtime, dir, launchArgs)
	}

	var tasks []store.AgentCron
	for _, name := range []string{"任务一", "任务二", "任务三", "任务四", "任务五"} {
		tasks = append(tasks, mustCreate(t, store.AgentCron{Name: name, Hour: 2, Minute: 0, Prompt: "p", Enabled: true}))
	}
	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	done := make(chan struct{})
	go func() {
		env.module.r.runDue(tasks, now)
		close(done)
	}()

	// 阶段一：钳 3 下恰 3 个任务同时进入 launch（5s 超时防实现回归时挂死）
	for i := 0; i < 3; i++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatalf("expect 3 launches in flight under clamp, only %d entered", i)
		}
	}
	if got := maxInFlight.Load(); got != 3 {
		t.Fatalf("max in-flight = %d, want clamp 3", got)
	}
	// 阶段二：放行，等整轮收束
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runDue did not settle after release")
	}

	got := env.snapshot()
	if len(got) != 5 {
		t.Fatalf("expect 5 launches, got %d", len(got))
	}
	for _, tk := range tasks {
		if n := launchesOf(env, tk.Name); n != 1 {
			t.Fatalf("task %s launched %d times, want 1", tk.Name, n)
		}
		if c := mustGet(t, tk.ID); c.LastResult != resultLaunched {
			t.Fatalf("task %s lastResult = %q, want launched", tk.Name, c.LastResult)
		}
		if env.module.r.liveWatchFor(tk.ID) == "" {
			t.Fatalf("task %s should register a completion watch", tk.Name)
		}
	}
	// 幂等标记在收集阶段（串行）完成：同槽第二轮零重判零重发
	env.module.r.runDue(tasks, now)
	if len(env.snapshot()) != 5 {
		t.Fatalf("same-slot rerun should be idempotent, got %d launches", len(env.snapshot()))
	}
}

// TestRunDue_PanicInLaunchContained（P-20261005-216 逐任务 recover 守卫）：单个
// 任务的发起链 panic 不拖垮同轮其余任务——panic 是 bug 信号非业务失败，围堵在
// 日志（不伪装成 error 入运行账），同轮兄弟任务照常发起记账
func TestRunDue_PanicInLaunchContained(t *testing.T) {
	env := newTestEnv(t)
	plainLauncher := env.module.r.launch
	env.module.r.launch = func(name, runtime, dir, launchArgs string) (*terminal.AgentLaunch, error) {
		if name == "炸点" {
			panic("boom in launch chain")
		}
		return plainLauncher(name, runtime, dir, launchArgs)
	}
	bomb := mustCreate(t, store.AgentCron{Name: "炸点", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	sibling := mustCreate(t, store.AgentCron{Name: "邻居", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})

	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{bomb, sibling}, now) // panic 未被守卫会击穿测试进程

	if n := launchesOf(env, "邻居"); n != 1 {
		t.Fatalf("sibling should launch despite neighbor panic, got %d", n)
	}
	if c := mustGet(t, sibling.ID); c.LastResult != resultLaunched {
		t.Fatalf("sibling lastResult = %q, want launched", c.LastResult)
	}
	if c := mustGet(t, bomb.ID); c.LastResult != "" {
		t.Fatalf("panicked task must not gain business facts, got lastResult %q", c.LastResult)
	}
	if env.module.r.liveWatchFor(bomb.ID) != "" {
		t.Fatal("panicked task must not register a watch")
	}
}

func TestRunDue_FailureRecordedAndNotified(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "会失败", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	env.failOn["会失败"] = errors.New("directory does not exist")
	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)

	after := mustGet(t, created.ID)
	if !strings.HasPrefix(after.LastResult, resultError+":") {
		t.Fatalf("lastResult = %q, want error prefix", after.LastResult)
	}
	notes := store.Get().Notification.List(0)
	// 失败态行动化（P-20261006-14）：action='cron-retry' + payload=任务 ID+失败槽点
	//（JSON 单串，前端 useCronRetry.parseCronRetryPayload 同构解析）
	note := findNote(t, "agentcron.notify.launchFailed.title")
	if note == nil {
		t.Fatalf("launch failure should land in notification center, got %+v", notes)
	}
	if note.Action != "cron-retry" {
		t.Fatalf("action = %q, want cron-retry", note.Action)
	}
	var retryPayload struct {
		CronID string `json:"cronId"`
		Slot   string `json:"slot"`
	}
	if err := json.Unmarshal([]byte(note.ActionPayload), &retryPayload); err != nil {
		t.Fatalf("actionPayload %q not JSON: %v", note.ActionPayload, err)
	}
	if retryPayload.CronID != created.ID {
		t.Fatalf("payload cronId = %q, want %q", retryPayload.CronID, created.ID)
	}
	if !strings.HasPrefix(retryPayload.Slot, "2026-10-02T02:00") {
		t.Fatalf("payload slot = %q, want the failed scheduled slot", retryPayload.Slot)
	}
	// 失败同样记账 LastRunAt：当日不再重试（等下一个槽点）
	if after.LastRunAt.IsZero() {
		t.Fatal("failed attempt should also record lastRunAt")
	}
	// 运行历史随行（P-20261002-143）：发起失败带错误摘要入历史
	if len(after.History) != 1 {
		t.Fatalf("history should record the failed attempt, got %d", len(after.History))
	}
	if after.History[0].ErrSummary != "directory does not exist" {
		t.Fatalf("history errSummary = %q, want launch error", after.History[0].ErrSummary)
	}
}

func TestRunDue_WeekdayFilter(t *testing.T) {
	env := newTestEnv(t)
	// 仅周五触发；2026-10-02 是周五，2026-10-03 是周六
	created := mustCreate(t, store.AgentCron{Name: "周报", Hour: 9, Minute: 0, Weekdays: []int{5}, Prompt: "p", Enabled: true})
	friday := time.Date(2026, 10, 2, 9, 0, 30, 0, time.Local)
	saturday := time.Date(2026, 10, 3, 9, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, saturday)
	if len(env.snapshot()) != 0 {
		t.Fatal("non-member weekday should not trigger")
	}
	env.module.r.runDue([]store.AgentCron{created}, friday)
	if len(env.snapshot()) != 1 {
		t.Fatalf("member weekday should trigger, got %d", len(env.snapshot()))
	}
}

func TestRunNow_BypassesSlotDedup(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "试跑", Hour: 23, Minute: 59, Prompt: "p", Enabled: true})
	// 槽点远未到，试跑仍应立即发起
	if _, err := env.module.r.RunNow(created); err != nil {
		t.Fatalf("run now: %v", err)
	}
	if len(env.snapshot()) != 1 {
		t.Fatalf("run now should launch, got %d", len(env.snapshot()))
	}
	if c := mustGet(t, created.ID); c.LastResult != resultLaunched {
		t.Fatalf("lastResult = %q", c.LastResult)
	}
}

func TestRunNow_FailurePayloadStampsNow(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "试跑失败", Hour: 23, Minute: 59, Prompt: "p", Enabled: true})
	env.failOn["试跑失败"] = errors.New("boom")
	// 试跑路径 slot 零值：失败通知的 payload 槽位取当下（不落零值时间戳），
	// 前端「同槽重跑语义按当下发起」的注记锚点（P-20261006-14）
	before := time.Now().Add(-time.Minute)
	if _, err := env.module.r.RunNow(created); err == nil {
		t.Fatal("run now should fail")
	}
	note := findNote(t, "agentcron.notify.launchFailed.title")
	if note == nil || note.Action != "cron-retry" {
		t.Fatalf("run-now failure note missing cron-retry action: %+v", note)
	}
	var retryPayload struct {
		CronID string `json:"cronId"`
		Slot   string `json:"slot"`
	}
	if err := json.Unmarshal([]byte(note.ActionPayload), &retryPayload); err != nil {
		t.Fatalf("actionPayload %q not JSON: %v", note.ActionPayload, err)
	}
	stamped, err := time.Parse(time.RFC3339, retryPayload.Slot)
	if err != nil {
		t.Fatalf("payload slot %q not RFC3339: %v", retryPayload.Slot, err)
	}
	if stamped.Before(before) {
		t.Fatalf("payload slot = %v, want ~now (>= %v)", stamped, before)
	}
}

func seedProgress(t *testing.T, sessionID, status, step string, at time.Time) {
	t.Helper()
	_ = store.Get().AgentTask.Append(store.AgentTask{
		Type: "task.progress", Status: status, Step: step, SessionID: sessionID, At: at,
	})
}

func findNote(t *testing.T, titleKey string) *notification.Notification {
	t.Helper()
	for _, n := range store.Get().Notification.List(0) {
		if n.TitleKey == titleKey {
			cp := n
			return &cp
		}
	}
	return nil
}

func TestPollWatches_DoneReportNotified(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "完成上报", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	env.module.r.runDue([]store.AgentCron{created}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	// 智能体经 ops-notify 上报 done（ai 模块观察者落库形态：SessionID =
	// "terminalId sessionId"），只读复用该数据面。事件时刻用真实时钟：
	// trigger 记账的 since 是 time.Now()
	seedProgress(t, "agent-完成上报 claude-s1", "done", "报告已生成", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	after := mustGet(t, created.ID)
	if after.LastResult != resultDone {
		t.Fatalf("lastResult = %q, want done", after.LastResult)
	}
	note := findNote(t, "agentcron.notify.done.title")
	if note == nil {
		t.Fatal("done notification missing")
	}
	if note.Action != "terminal" || note.ActionPayload != "agent-完成上报" {
		t.Fatalf("action should jump to session, got %+v", note)
	}
}

func TestPollWatches_FailedReportNotified(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "失败上报", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	env.module.r.runDue([]store.AgentCron{created}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	seedProgress(t, "agent-失败上报", "failed", "测试失败：3 例", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	after := mustGet(t, created.ID)
	if after.LastResult != resultFailed {
		t.Fatalf("lastResult = %q, want failed", after.LastResult)
	}
	note := findNote(t, "agentcron.notify.failedRun.title")
	if note == nil {
		t.Fatal("failed notification missing")
	}
	if note.Type != "error" {
		t.Fatalf("failed notification type = %q", note.Type)
	}
	// 运行历史随行（P-20261002-143）：失败回执的 step 摘要入历史（试跑的
	// launched 首条在前，共两条）
	hist := after.History
	if len(hist) != 2 || hist[1].Result != resultFailed || hist[1].ErrSummary != "测试失败：3 例" {
		t.Fatalf("failed report should append history with step summary, got %+v", hist)
	}
}

func TestPollWatches_RunningReportKeepsWatching(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "运行中", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	env.module.r.runDue([]store.AgentCron{created}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	seedProgress(t, "agent-运行中", "running", "扫描中", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	if c := mustGet(t, created.ID); c.LastResult != resultLaunched {
		t.Fatalf("non-final report should keep launched, got %q", c.LastResult)
	}
	// 终态随后到达仍能命中（监听未被 running 清掉）
	seedProgress(t, "agent-运行中", "done", "", time.Now().Add(2*time.Minute))
	env.module.r.pollWatches()
	if c := mustGet(t, created.ID); c.LastResult != resultDone {
		t.Fatalf("final report after running should land, got %q", c.LastResult)
	}
}

func TestPollWatches_OtherSessionIgnored(t *testing.T) {
	env := newTestEnv(t)
	created := mustCreate(t, store.AgentCron{Name: "归属", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	env.module.r.runDue([]store.AgentCron{created}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	// 别的会话的 done 不该归属本任务
	seedProgress(t, "agent-别的会话", "done", "", time.Now().Add(time.Minute))
	env.module.r.pollWatches()
	if c := mustGet(t, created.ID); c.LastResult != resultLaunched {
		t.Fatalf("foreign session report should be ignored, got %q", c.LastResult)
	}
}

// ============== 依赖链：调度跳过 / 回执级联 / 失败传播（P-20261003-124） ==============

// launchesOf 按任务名统计桩 launch 调用次数
func launchesOf(env *testEnv, name string) int {
	n := 0
	for _, call := range env.snapshot() {
		if call.name == name {
			n++
		}
	}
	return n
}

func TestRunDue_SkipsAfterTrigger(t *testing.T) {
	env := newTestEnv(t)
	// after 任务即使带「已到点」的时刻字段，也不参与时刻调度
	created := mustCreate(t, store.AgentCron{
		Name: "链上任务", Hour: 2, Minute: 0, Prompt: "p", Enabled: true,
		Trigger: store.CronTriggerAfter, AfterCronID: "sc_cron_parent", AfterMode: store.CronAfterSuccess,
	})
	now := time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local)
	env.module.r.runDue([]store.AgentCron{created}, now)
	env.module.r.runDue([]store.AgentCron{created}, now.Add(time.Minute))
	if n := launchesOf(env, "链上任务"); n != 0 {
		t.Fatalf("after-trigger task must not fire on schedule, got %d launches", n)
	}
	if c := mustGet(t, created.ID); !c.LastRunAt.IsZero() {
		t.Fatal("schedule skip should not touch run facts")
	}
}

// chainEnv 装配「父（定时）→ 子（前序完成触发）」标准链
func chainEnv(t *testing.T, mode string) (*testEnv, store.AgentCron, store.AgentCron) {
	t.Helper()
	env := newTestEnv(t)
	parent := mustCreate(t, store.AgentCron{Name: "父构建", Hour: 2, Minute: 0, Prompt: "build", Enabled: true})
	child := mustCreate(t, store.AgentCron{
		Name: "子测试", Hour: 3, Minute: 0, Prompt: "test", Enabled: true,
		Trigger: store.CronTriggerAfter, AfterCronID: parent.ID, AfterMode: mode,
	})
	return env, parent, child
}

func TestCascade_ParentDoneTriggersChild(t *testing.T) {
	env, parent, child := chainEnv(t, store.CronAfterSuccess)
	env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	// 父智能体上报 done → 巡检回执命中 → 子任务自动发起（回执接线全链）
	seedProgress(t, "agent-父构建", "done", "构建完成", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	if n := launchesOf(env, "子测试"); n != 1 {
		t.Fatalf("child should cascade-launch once on parent done, got %d", n)
	}
	after := mustGet(t, child.ID)
	if after.LastResult != resultLaunched {
		t.Fatalf("child lastResult = %q, want launched", after.LastResult)
	}
	// 级联触发复用 trigger 全链：子任务也登记了回执监听——子智能体上报 done
	// 后其终态照常落账（孙级随子回执继续级联的同一机制）
	seedProgress(t, "agent-子测试", "done", "测试通过", time.Now().Add(2*time.Minute))
	env.module.r.pollWatches()
	if c := mustGet(t, child.ID); c.LastResult != resultDone {
		t.Fatalf("child done report should land, got %q", c.LastResult)
	}
}

func TestCascade_SuccessMode_FailedParentSkipsChild(t *testing.T) {
	env, parent, child := chainEnv(t, store.CronAfterSuccess)
	env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	seedProgress(t, "agent-父构建", "failed", "编译错误", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	// 失败传播：父失败且子要求成功才触发 → 子标 skipped 入运行历史，不发起
	if n := launchesOf(env, "子测试"); n != 0 {
		t.Fatalf("skipped child must not launch, got %d launches", n)
	}
	after := mustGet(t, child.ID)
	if after.LastResult != resultSkipped {
		t.Fatalf("child lastResult = %q, want skipped", after.LastResult)
	}
	if len(after.History) != 1 || after.History[0].Result != resultSkipped {
		t.Fatalf("skipped run should land in history, got %+v", after.History)
	}
	if !strings.Contains(after.History[0].ErrSummary, "父构建") {
		t.Fatalf("skipped summary should name the predecessor, got %q", after.History[0].ErrSummary)
	}
}

func TestCascade_AlwaysMode_FailedParentStillTriggers(t *testing.T) {
	env, parent, _ := chainEnv(t, store.CronAfterAlways)
	env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))

	seedProgress(t, "agent-父构建", "failed", "编译错误", time.Now().Add(time.Minute))
	env.module.r.pollWatches()

	// 完成即触发档：父 failed 照常级联（流程必须继续，如「无论构建成败都发报告」）
	if n := launchesOf(env, "子测试"); n != 1 {
		t.Fatalf("always-mode child should trigger on parent failed, got %d", n)
	}
}

func TestCascade_LaunchErrorSkipsChildBothModes(t *testing.T) {
	// 父任务发起失败（会话都没起来）：两档子任务都不触发，一律标 skipped
	for _, mode := range []string{store.CronAfterSuccess, store.CronAfterAlways} {
		env, parent, child := chainEnv(t, mode)
		env.failOn["父构建"] = errors.New("directory does not exist")
		env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))
		if n := launchesOf(env, "子测试"); n != 0 {
			t.Fatalf("mode %s: child must not launch on parent launch error, got %d", mode, n)
		}
		if c := mustGet(t, child.ID); c.LastResult != resultSkipped {
			t.Fatalf("mode %s: child lastResult = %q, want skipped", mode, c.LastResult)
		}
	}
}

func TestCascade_InFlightChildNotRetriggered(t *testing.T) {
	env, parent, _ := chainEnv(t, store.CronAfterSuccess)
	// 第一轮：父到点 → done → 子级联发起
	env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))
	seedProgress(t, "agent-父构建", "done", "", time.Now().Add(time.Minute))
	env.module.r.pollWatches()
	if n := launchesOf(env, "子测试"); n != 1 {
		t.Fatalf("first cascade should launch child, got %d", n)
	}

	// 重入样例：父重跑（试跑不经槽点去重）再次 done，而子任务上一轮会话仍在
	// 途回执未落 → 静默跳过本次级联（一子任务至多一个在途运行）
	if _, err := env.module.r.RunNow(parent); err != nil {
		t.Fatalf("parent rerun: %v", err)
	}
	seedProgress(t, "agent-父构建", "done", "", time.Now().Add(2*time.Minute))
	env.module.r.pollWatches()
	if n := launchesOf(env, "子测试"); n != 1 {
		t.Fatalf("in-flight child must not be retriggered, got %d launches", n)
	}

	// 子任务终态落定解除在途监听后，父的下一次完成可再次级联
	seedProgress(t, "agent-子测试", "done", "", time.Now().Add(3*time.Minute))
	env.module.r.pollWatches()
	if _, err := env.module.r.RunNow(parent); err != nil {
		t.Fatalf("parent rerun #2: %v", err)
	}
	seedProgress(t, "agent-父构建", "done", "", time.Now().Add(4*time.Minute))
	env.module.r.pollWatches()
	if n := launchesOf(env, "子测试"); n != 2 {
		t.Fatalf("child should cascade again after its watch settled, got %d", n)
	}
}

func TestCascade_DisabledChildIgnored(t *testing.T) {
	env, parent, child := chainEnv(t, store.CronAfterSuccess)
	// 停用子任务：级联完全跳过，也不记 skipped（停用 = 用户主动关闸，非失败）
	if _, err := store.Get().AgentCron.Update(child.ID, store.AgentCron{
		Name: child.Name, Hour: child.Hour, Minute: child.Minute, Prompt: child.Prompt,
		Enabled: false, Trigger: child.Trigger, AfterCronID: child.AfterCronID, AfterMode: child.AfterMode,
	}); err != nil {
		t.Fatalf("disable child: %v", err)
	}
	env.module.r.runDue([]store.AgentCron{parent}, time.Date(2026, 10, 2, 2, 0, 30, 0, time.Local))
	seedProgress(t, "agent-父构建", "done", "", time.Now().Add(time.Minute))
	env.module.r.pollWatches()
	if n := launchesOf(env, child.Name); n != 0 {
		t.Fatalf("disabled child must stay dormant, got %d launches", n)
	}
	if c := mustGet(t, child.ID); c.LastResult != "" || len(c.History) != 0 {
		t.Fatalf("disabled child should have no run facts, got %+v", c.History)
	}
}
