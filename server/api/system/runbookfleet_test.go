package system

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 舰队运行书执行单测（P-20261005-147）：handler 契约（目标集校验/同书互斥/
// 缺席早失败）+ 引擎核心伪会话注入（fakeFleetTarget）——逐格聚合/stop 尾跳过/
// 无 OSC133 降级标注/中止广播 \x03/单台重试。真 PTY 的多目标执行闭环由 e2e
//（runbook-fleet-run.spec.ts，两伪目标×三步含中途失败停）覆盖；等待原语本体
// 在 terminal 包单测。

// fakeFleetTarget 伪目标会话：frames=是否见过 OSC133 帧（降级判定开关）；
// exitCh 非 nil 时 WaitCommandExit 阻塞到送达/超时（中止路径用）；
// exitCodes 按 WaitCommandExit 调用序消费（逐步不同退出码；耗尽回落 exitCode）；
// writeLog 收写入原文（\x03 广播断言用）
type fakeFleetTarget struct {
	id        string
	frames    bool
	writeErr  error
	exitCode  int
	exitCodes []int
	codeIdx   int
	delay     time.Duration
	exitCh    chan int
	waitFalse bool

	mu       sync.Mutex
	writeLog [][]byte
}

func (f *fakeFleetTarget) TargetID() string { return f.id }

func (f *fakeFleetTarget) WriteInput(data []byte) error {
	f.mu.Lock()
	cp := make([]byte, len(data))
	copy(cp, data)
	f.writeLog = append(f.writeLog, cp)
	f.mu.Unlock()
	return f.writeErr
}

func (f *fakeFleetTarget) WaitCommandExit(timeout time.Duration) (int, bool) {
	if f.waitFalse {
		// 远程会话形态：确认信号不回传，等待原语即时返回（不烧等待窗）
		return 0, false
	}
	if f.exitCh != nil {
		select {
		case code := <-f.exitCh:
			return code, true
		case <-time.After(timeout):
			return 0, false
		}
	}
	f.mu.Lock()
	code := f.exitCode
	if f.codeIdx < len(f.exitCodes) {
		code = f.exitCodes[f.codeIdx]
	}
	f.codeIdx++
	f.mu.Unlock()
	time.Sleep(f.delay)
	return code, true
}

func (f *fakeFleetTarget) OscFramesSeen() bool { return f.frames }

func (f *fakeFleetTarget) writes() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.writeLog))
	copy(out, f.writeLog)
	return out
}

// newFleetStateForTest 组装注册表条目（镜像 handler 建档段，矩阵预分配）
func newFleetStateForTest(bookID string, cmds []string, targetIDs []string, onFailure string, timeout time.Duration) *fleetRunState {
	steps := make([]store.RunbookStep, len(cmds))
	for i, c := range cmds {
		steps[i] = store.RunbookStep{Command: c}
	}
	st := &fleetRunState{
		runID:       "frb_test_" + bookID,
		bookID:      bookID,
		title:       "t",
		commands:    cmds,
		steps:       steps,
		onFailure:   onFailure,
		stepTimeout: timeout,
		targetIDs:   targetIDs,
		matrix:      make([]fleetRunStepResult, len(cmds)),
		status:      "running",
		abortCh:     make(chan struct{}),
		abortAck:    make(chan struct{}),
		lastUse:     time.Now(),
	}
	registerFleetRun(st)
	return st
}

func TestDedupeFleetIDs(t *testing.T) {
	got := dedupeFleetIDs([]string{"b", " a ", "a", "b", "", "a"})
	want := []string{"b", "a"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("dedupe = %v, want %v（去重保序 + 空白剔除）", got, want)
	}
}

func TestExecuteFleetRunAggregation(t *testing.T) {
	// 双目标 × 2 步全成功：逐格退出码聚合 + status completed
	a := &fakeFleetTarget{id: "t-a", frames: true, exitCode: 0, delay: time.Millisecond}
	b := &fakeFleetTarget{id: "t-b", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk1", []string{"echo one", "echo two"}, []string{"t-a", "t-b"}, "stop", 500*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{a, b})
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed", res.Status)
	}
	for i, s := range res.Steps {
		if s.Status != "done" {
			t.Errorf("step%d = %q, want done", i, s.Status)
		}
		for _, c := range s.Targets {
			if c.Status != "done" || c.ExitCode == nil || *c.ExitCode != 0 {
				t.Errorf("step%d target %s = %+v, want done exit 0", i, c.ID, c)
			}
		}
	}
	// 写入真发生：每目标每步一条
	if len(a.writes()) != 2 {
		t.Fatalf("target a writes = %d, want 2", len(a.writes()))
	}
}

func TestExecuteFleetRunStopOnFailure(t *testing.T) {
	// 2 目标 × 3 步，B 在第 2 步失败（exit 7）+ stop：第 3 步整行 skipped，
	// A 的第 3 步也没发（停=中止全书，提案语义）
	a := &fakeFleetTarget{id: "t-a", frames: true, exitCode: 0, delay: time.Millisecond}
	b := &fakeFleetTarget{id: "t-b", frames: true, exitCodes: []int{0, 7}, delay: time.Millisecond}
	st := newFleetStateForTest("bk2", []string{"s1", "s2", "s3"}, []string{"t-a", "t-b"}, "stop", 500*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{a, b})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if res.Steps[0].Status != "done" {
		t.Errorf("step0 = %q, want done", res.Steps[0].Status)
	}
	cells := res.Steps[1].Targets
	if cells[0].Status != "done" || cells[1].Status != "failed" || cells[1].ExitCode == nil || *cells[1].ExitCode != 7 {
		t.Fatalf("step1 cells = %+v %+v, want a done / b failed exit 7", cells[0], cells[1])
	}
	for _, c := range res.Steps[2].Targets {
		if c.Status != "skipped" {
			t.Errorf("step2 %s = %q, want skipped", c.ID, c.Status)
		}
	}
	// 第 3 步未发送（每目标 writes = 2 条 = 步 0/1）
	if len(a.writes()) != 2 || len(b.writes()) != 2 {
		t.Fatalf("writes after stop: a=%d b=%d, want 2/2（停=全书中止，余步不发）", len(a.writes()), len(b.writes()))
	}
}

func TestExecuteFleetRunContinueRecordsAndProceeds(t *testing.T) {
	// continue：失败格如实记录且不拦截——后续步照常对全目标执行；
	// 全程跑完但有过失败格 → 终态 failed（不虚报 completed）
	a := &fakeFleetTarget{id: "t-a", frames: true, exitCode: 0, delay: time.Millisecond}
	b := &fakeFleetTarget{id: "t-b", frames: true, exitCodes: []int{0, 3, 0}, delay: time.Millisecond}
	st := newFleetStateForTest("bk3", []string{"s1", "s2", "s3"}, []string{"t-a", "t-b"}, "continue", 500*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{a, b})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed（有失败格不虚报 completed）", res.Status)
	}
	if res.Steps[1].Targets[1].Status != "failed" || *res.Steps[1].Targets[1].ExitCode != 3 {
		t.Fatalf("step1 b = %+v, want failed exit 3", res.Steps[1].Targets[1])
	}
	if res.Steps[2].Status != "done" {
		t.Fatalf("step2 = %q, want done（失败不拦截后续）", res.Steps[2].Status)
	}
}

func TestExecuteFleetRunNoSignalDegrade(t *testing.T) {
	// 本地裸 shell 形态（帧全程未现 + 等待原语阻塞到超时）：等待烧满超时窗后
	// 按帧判据降级——格 done + noSignal，不算失败；命令真写入了（写前跳过会
	// 吞命令，e2e 实测踩坑）
	bare := &fakeFleetTarget{id: "t-bare", frames: false, exitCh: make(chan int)}
	live := &fakeFleetTarget{id: "t-live", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk4", []string{"s1"}, []string{"t-bare", "t-live"}, "stop", 300*time.Millisecond)
	start := time.Now()
	res := executeFleetRun(st, []fleetTarget{bare, live})
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed（无信号格不算失败）", res.Status)
	}
	cell := res.Steps[0].Targets[0]
	if cell.Status != "done" || !cell.NoSignal || cell.ExitCode != nil {
		t.Fatalf("bare cell = %+v, want done+noSignal 无退出码", cell)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("run took %v, want bounded by step timeout", elapsed)
	}
	if len(bare.writes()) != 1 {
		t.Fatalf("bare writes = %d, want 1（命令恒写入，无信号不跳过写）", len(bare.writes()))
	}
}

func TestExecuteFleetRunRemoteInstantNoSignal(t *testing.T) {
	// 远程会话形态（等待原语即时返回 false——确认信号不回传）：noSignal
	// 即时落格，不烧等待窗（提案「超时即视为完成」对远程无谓等待的消除）
	remote := &fakeFleetTarget{id: "t-remote", frames: false, waitFalse: true}
	live := &fakeFleetTarget{id: "t-live", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk4b", []string{"s1", "s2"}, []string{"t-remote", "t-live"}, "continue", 30*time.Second)
	start := time.Now()
	res := executeFleetRun(st, []fleetTarget{remote, live})
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed", res.Status)
	}
	cell := res.Steps[0].Targets[0]
	if cell.Status != "done" || !cell.NoSignal || cell.ExitCode != nil {
		t.Fatalf("remote cell = %+v, want done+noSignal 无退出码", cell)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("run took %v, want immediate（远程等待原语即时返回）", elapsed)
	}
}

func TestExecuteFleetRunFreshSessionJudgedByDFrame(t *testing.T) {
	// 回归测试（e2e 实测踩坑）：刚建好的集成会话首命令前一帧未见
	//（启动期 D 被抑制）——命令必须照写、按 D 帧退出码判定，
	// 不得写前判「无信号」跳过写吞掉真命令
	fresh := &fakeFleetTarget{id: "t-fresh", frames: false, exitCh: make(chan int, 1)}
	st := newFleetStateForTest("bk4c", []string{"echo hi"}, []string{"t-fresh"}, "stop", 500*time.Millisecond)
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(30 * time.Millisecond) // 模拟首提示符渲染后命令开跑出 D
		fresh.exitCh <- 0
	}()
	res := executeFleetRun(st, []fleetTarget{fresh})
	<-done
	cell := res.Steps[0].Targets[0]
	if cell.Status != "done" || cell.ExitCode == nil || *cell.ExitCode != 0 {
		t.Fatalf("fresh cell = %+v, want done exit 0（按 D 帧判定，非 noSignal 跳过）", cell)
	}
	if cell.NoSignal || cell.TimedOut {
		t.Fatalf("fresh cell = %+v, 不得标 noSignal/timedOut", cell)
	}
	if len(fresh.writes()) != 1 {
		t.Fatalf("fresh writes = %d, want 1（命令真写入了）", len(fresh.writes()))
	}
}

func TestExecuteFleetRunTimeoutTreatedDone(t *testing.T) {
	// 有信号但超时：视为完成 + timedOut 如实标注（CMD_TIMEOUT 惯例）
	slow := &fakeFleetTarget{id: "t-slow", frames: true, exitCh: make(chan int)}
	st := newFleetStateForTest("bk5", []string{"long-build"}, []string{"t-slow"}, "stop", 30*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{slow})
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed", res.Status)
	}
	c := res.Steps[0].Targets[0]
	if c.Status != "done" || !c.TimedOut || c.ExitCode != nil {
		t.Fatalf("slow cell = %+v, want done+timedOut 无退出码", c)
	}
}

func TestExecuteFleetRunWriteFailureCell(t *testing.T) {
	// 写失败（会话已关）：只判该格 failed 不拖累其余目标；stop 下停在当步
	dead := &fakeFleetTarget{id: "t-dead", frames: true, writeErr: errors.New("session closed")}
	live := &fakeFleetTarget{id: "t-live", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk6", []string{"s1", "s2"}, []string{"t-dead", "t-live"}, "stop", 500*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{dead, live})
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	c := res.Steps[0].Targets[0]
	if c.Status != "failed" || c.Error == "" {
		t.Fatalf("dead cell = %+v, want failed 带诊断短语", c)
	}
	if res.Steps[1].Targets[1].Status != "skipped" {
		t.Fatalf("live step1 = %q, want skipped（停=全书中止）", res.Steps[1].Targets[1].Status)
	}
}

func TestExecuteFleetRunAbortDuringWait(t *testing.T) {
	// 等待中中止：未收敛目标收到 \x03 + 格 aborted；已收敛格保留真实结果
	stuck := &fakeFleetTarget{id: "t-stuck", frames: true, exitCh: make(chan int)} // 永不收敛
	quick := &fakeFleetTarget{id: "t-quick", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk7", []string{"s1"}, []string{"t-stuck", "t-quick"}, "stop", 30*time.Second)
	done := make(chan *fleetRunResult, 1)
	go func() { done <- executeFleetRun(st, []fleetTarget{stuck, quick}) }()
	time.Sleep(50 * time.Millisecond) // 让引擎进等待段
	if already := st.requestAbort(); already {
		t.Fatal("run should not be finished yet")
	}
	res := <-done
	if res.Status != "aborted" {
		t.Fatalf("status = %q, want aborted", res.Status)
	}
	if res.Steps[0].Status != "aborted" {
		t.Fatalf("step0 status = %q, want aborted", res.Steps[0].Status)
	}
	cells := res.Steps[0].Targets
	if cells[0].Status != "aborted" {
		t.Fatalf("stuck cell = %+v, want aborted", cells[0])
	}
	if cells[1].Status != "done" {
		t.Fatalf("quick cell = %+v, want done（判据已到手不作废）", cells[1])
	}
	// \x03 广播到未收敛目标（末条写入 = Ctrl+C）
	ws := stuck.writes()
	if len(ws) == 0 || !bytes.Equal(ws[len(ws)-1], []byte{0x03}) {
		t.Fatalf("stuck last write = %v, want \\x03", ws)
	}
	select {
	case <-st.abortAck:
	default:
		t.Fatal("abortAck should be closed after terminal state")
	}
}

func TestExecuteFleetRunAbortBetweenSteps(t *testing.T) {
	// 步进间隔中止：已执行步保留 done，余下步骤整行 aborted
	a := &fakeFleetTarget{id: "t-a", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk8", []string{"s1", "s2", "s3"}, []string{"t-a"}, "continue", 500*time.Millisecond)
	go func() {
		// 等 step0 收敛（写入完成 + delay 1ms 出码），引擎随即进入 350ms 步间
		// 间隔——再留 10ms 余量后中止，落点必在间隔内
		for {
			if len(a.writes()) >= 1 {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}
		time.Sleep(10 * time.Millisecond)
		st.requestAbort()
	}()
	res := executeFleetRun(st, []fleetTarget{a})
	if res.Status != "aborted" {
		t.Fatalf("status = %q, want aborted", res.Status)
	}
	if res.Steps[0].Status != "done" {
		t.Fatalf("step0 = %q, want done（已执行步保留）", res.Steps[0].Status)
	}
	for i := 1; i < 3; i++ {
		for _, c := range res.Steps[i].Targets {
			if c.Status != "aborted" {
				t.Fatalf("step%d cell = %+v, want aborted", i, c)
			}
		}
	}
}

func TestFleetAbortFinishedRunIdempotent(t *testing.T) {
	// 已终态 run 的中止请求幂等回快照（前端重复点中止不报错、不改终态）
	a := &fakeFleetTarget{id: "t-a", frames: true, exitCode: 0, delay: time.Millisecond}
	st := newFleetStateForTest("bk9", []string{"s1"}, []string{"t-a"}, "continue", 500*time.Millisecond)
	executeFleetRun(st, []fleetTarget{a})
	if already := st.requestAbort(); !already {
		t.Fatal("finished run should report alreadyFinished")
	}
	res := st.snapshotFleetResult()
	if res.Status != "completed" {
		t.Fatalf("snapshot status = %q, want completed（幂等不改终态）", res.Status)
	}
}

// seedFleetMatrixRun 播一本真书 + 注册一个已终态（首跑失败）的舰队 run，
// 供 retry handler 契约测试寻址（目标 id 不注册进真 manager——缺席重试的
// 诚实路径由该形态天然覆盖）
func seedFleetMatrixRun(t *testing.T, targetIDs []string) (*store.Runbook, *fleetRunState, []*fakeFleetTarget) {
	t.Helper()
	book := seedRunbook(t, "舰队重试书", "stop", []string{"s1", "s2"})
	bad := &fakeFleetTarget{id: targetIDs[0], frames: true, exitCodes: []int{9, 9}, delay: time.Millisecond}
	good := &fakeFleetTarget{id: targetIDs[1], frames: true, exitCode: 0, delay: time.Millisecond}
	st := &fleetRunState{
		runID:       "frb_retry1",
		bookID:      book.ID,
		title:       book.Title,
		commands:    []string{"s1", "s2"},
		steps:       book.Steps,
		onFailure:   "stop",
		stepTimeout: 500 * time.Millisecond,
		targetIDs:   targetIDs,
		matrix:      make([]fleetRunStepResult, 2),
		status:      "running",
		abortCh:     make(chan struct{}),
		abortAck:    make(chan struct{}),
		lastUse:     time.Now(),
	}
	registerFleetRun(st)
	res := executeFleetRun(st, []fleetTarget{bad, good})
	if res.Status != "failed" || res.Steps[0].Targets[0].Status != "failed" {
		t.Fatalf("seed run = %q / cell %+v, want failed", res.Status, res.Steps[0].Targets[0])
	}
	t.Cleanup(func() {
		fleetRunRegMu.Lock()
		delete(fleetRunReg, st.runID)
		fleetRunRegMu.Unlock()
	})
	return book, st, []*fakeFleetTarget{bad, good}
}

func TestFleetRetryHandlerTargetGone(t *testing.T) {
	setupRunbookRunStore(t)
	// handler 全链：failed 格重试但目标已不在册 → 格回 failed 带「target
	// session gone」（缺席如实回填，不虚构成功）；残留 failed → run 仍 failed
	_, st, _ := seedFleetMatrixRun(t, []string{"t-bad", "t-good"})
	w := performFleetRetry(st.runID, 0, "t-bad")
	if w.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200", w.Code)
	}
	var body struct {
		Data struct {
			Status string               `json:"status"`
			Steps  []fleetRunStepResult `json:"steps"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	c := body.Data.Steps[0].Targets[0]
	if c.Status != "failed" || c.Error == "" {
		t.Fatalf("retried cell = %+v, want failed 带诊断（目标不在册）", c)
	}
	if body.Data.Status != "failed" {
		t.Fatalf("run status = %q, want failed（失败格仍在）", body.Data.Status)
	}
}

func TestFleetRetryFailedCell(t *testing.T) {
	// 单台重试核心（引擎级，伪目标直注）：格重执行 → 落格 → 整矩阵状态重算
	st, targets := func() (*fleetRunState, []*fakeFleetTarget) {
		bad := &fakeFleetTarget{id: "t-bad", frames: true, exitCodes: []int{9, 9}, delay: time.Millisecond}
		good := &fakeFleetTarget{id: "t-good", frames: true, exitCode: 0, delay: time.Millisecond}
		s := newFleetStateForTest("bk10", []string{"s1", "s2"}, []string{"t-bad", "t-good"}, "stop", 500*time.Millisecond)
		res := executeFleetRun(s, []fleetTarget{bad, good})
		if res.Status != "failed" || res.Steps[0].Targets[0].Status != "failed" {
			return nil, nil
		}
		return s, []*fakeFleetTarget{bad, good}
	}()
	if st == nil {
		t.Fatal("seed run should fail at step0 t-bad")
	}
	// 「修好了」：重试该格退出码 0（重发该步命令到该目标——写入真发生）
	targets[0].exitCodes = nil
	targets[0].exitCode = 0
	cell := execFleetCell(targets[0], st.commands[0], st.stepTimeout)
	cell.ID = "t-bad"
	if cell.Status != "done" || cell.ExitCode == nil || *cell.ExitCode != 0 {
		t.Fatalf("retried cell = %+v, want done exit 0", cell)
	}
	st.applyFleetRetryCell(0, 0, cell)
	res := st.snapshotFleetResult()
	if res.Status != "completed" {
		t.Fatalf("status after retry = %q, want completed（唯一失败格已收敛）", res.Status)
	}
	if c := res.Steps[0].Targets[0]; c.Status != "done" {
		t.Fatalf("matrix cell = %+v, want done", c)
	}
	// 重试写入真发生：该目标第 2 条写入 = 重发的步 0 命令（首跑 stop 在步 0，
	// 只有 1 次写入；重试补 1 格）
	if len(targets[0].writes()) != 2 {
		t.Fatalf("writes = %d, want 2（首跑步 0 一条 + 重试一格）", len(targets[0].writes()))
	}
}

func performFleetRetry(runID string, stepIndex int, targetID string) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(map[string]any{"runId": runID, "stepIndex": stepIndex, "targetId": targetID})
	req := httptest.NewRequest(http.MethodPost, "/api/runbooks/x/fleet-retry", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	FleetRetry(c)
	return w
}

func TestFleetRetryGuards(t *testing.T) {
	setupRunbookRunStore(t)
	// 404：runId 不在册（TTL 过期/重启同语义）
	if w := performFleetRetry("frb_no-such", 0, "t-a"); w.Code != http.StatusNotFound {
		t.Fatalf("unknown run = %d, want 404", w.Code)
	}
	// 409：run 仍在跑（矩阵在变化，挡并发改写）
	blocked := &fakeFleetTarget{id: "t-a", frames: true, exitCh: make(chan int)}
	st := newFleetStateForTest("bk11", []string{"s1"}, []string{"t-a"}, "continue", 30*time.Second)
	done := make(chan *fleetRunResult, 1)
	go func() { done <- executeFleetRun(st, []fleetTarget{blocked}) }()
	time.Sleep(20 * time.Millisecond)
	if w := performFleetRetry(st.runID, 0, "t-a"); w.Code != http.StatusConflict {
		t.Fatalf("running run retry = %d, want 409", w.Code)
	}
	st.requestAbort()
	<-done
	// aborted 格可重试：伪目标不在真 manager → 解析缺席 → 格回 failed
	//（「target session gone」诚实路径，不虚构成功）
	w := performFleetRetry(st.runID, 0, "t-a")
	if w.Code != http.StatusOK {
		t.Fatalf("aborted-cell retry = %d, want 200", w.Code)
	}
	var body struct {
		Data struct {
			Status string               `json:"status"`
			Steps  []fleetRunStepResult `json:"steps"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if c := body.Data.Steps[0].Targets[0]; c.Status != "failed" || c.Error == "" {
		t.Fatalf("retried cell = %+v, want failed 带诊断（目标不在册）", c)
	}
	// done 格不可重试（防误触双跑）
	fine := &fakeFleetTarget{id: "t-fine", frames: true, exitCode: 0, delay: time.Millisecond}
	st2 := newFleetStateForTest("bk11b", []string{"s1"}, []string{"t-fine"}, "continue", 500*time.Millisecond)
	res := executeFleetRun(st2, []fleetTarget{fine})
	if res.Status != "completed" {
		t.Fatalf("seed run = %q", res.Status)
	}
	if w := performFleetRetry(st2.runID, 0, "t-fine"); w.Code != http.StatusBadRequest {
		t.Fatalf("done-cell retry = %d, want 400 cell_not_retryable", w.Code)
	}
	if body := decodeRunResponse(t, performFleetRetry(st2.runID, 0, "t-fine")); body["code"] != "fleet.cell_not_retryable" {
		t.Fatalf("code = %v, want fleet.cell_not_retryable", body["code"])
	}
}

func TestFleetRunHandlerContract(t *testing.T) {
	setupRunbookRunStore(t)
	book := seedRunbook(t, "舰队契约书", "", []string{"echo {env}"})
	plain := seedRunbook(t, "舰队契约书-无参", "", []string{"echo hi"})

	// 404：书不在册
	if w := performFleetRun("sc_rb_none", map[string]any{}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown book = %d, want 404", w.Code)
	}
	// 400：缺 targetIds（无参书——参数校验先行于目标校验，缺参书走不了这格）
	w := performFleetRun(plain.ID, map[string]any{})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty targets = %d, want 400", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "fleet.targets_required" {
		t.Fatalf("code = %v, want fleet.targets_required", body["code"])
	}
	// 400：非法 onFailure
	if w := performFleetRun(plain.ID, map[string]any{"targetIds": []string{"t-a"}, "onFailure": "explode"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad onFailure = %d, want 400", w.Code)
	}
	// 400：缺参（参数校验先行于目标解析）
	w = performFleetRun(book.ID, map[string]any{"targetIds": []string{"t-a"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing params = %d, want 400", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "runbook.params_missing" {
		t.Fatalf("code = %v, want runbook.params_missing", body["code"])
	}
	// 400：目标不在册（missing 清单回告早失败）
	w = performFleetRun(book.ID, map[string]any{"targetIds": []string{"ghost-1", "ghost-2"}, "params": map[string]string{"env": "prod"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing targets = %d, want 400", w.Code)
	}
	body := decodeRunResponse(t, w)
	if body["code"] != "fleet.targets_not_found" {
		t.Fatalf("code = %v, want fleet.targets_not_found", body["code"])
	}
	if missing, ok := body["missing"].([]any); !ok || len(missing) != 2 {
		t.Fatalf("missing = %v, want 2 项清单", body["missing"])
	}
	// 409：同书互斥（与单会话 run 共表）
	runID, ok := admitRunbookRun(book.ID)
	if !ok {
		t.Fatal("admit")
	}
	defer releaseRunbookRun(book.ID, runID)
	w = performFleetRun(book.ID, map[string]any{"targetIds": []string{"t-a"}, "params": map[string]string{"env": "prod"}})
	if w.Code != http.StatusConflict {
		t.Fatalf("busy = %d, want 409", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "runbook.busy" {
		t.Fatalf("code = %v, want runbook.busy", body["code"])
	}
}

func performFleetRun(bookID string, body map[string]any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/runbooks/"+bookID+"/fleet-run", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Params = gin.Params{{Key: "id", Value: bookID}}
	RunFleetRunbook(c)
	return w
}

func TestFleetAbortHandlerContract(t *testing.T) {
	// 404：runId 不在册
	raw, _ := json.Marshal(map[string]any{"runId": "frb_no-such"})
	req := httptest.NewRequest(http.MethodPost, "/api/runbooks/x/fleet-abort", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	FleetAbort(c)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown run abort = %d, want 404", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "fleet.run_not_found" {
		t.Fatalf("code = %v, want fleet.run_not_found", body["code"])
	}
}

func TestPublishFleetProgressShape(t *testing.T) {
	// 进度载荷契约冒烟：start/step/final 三相广播不炸（无客户端即弃队列），
	// 形状断言由 e2e 在真实 WS 面做（runbook-fleet-run.spec.ts 探针）
	a := &fakeFleetTarget{id: "t-a", frames: false, delay: time.Millisecond}
	st := newFleetStateForTest("bk12", []string{"s1"}, []string{"t-a"}, "continue", 500*time.Millisecond)
	res := executeFleetRun(st, []fleetTarget{a})
	if res.Status != "completed" {
		t.Fatalf("status = %q", res.Status)
	}
}
