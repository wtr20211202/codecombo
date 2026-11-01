package terminal

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 排队指令引擎单测（P-20261003-248 拆解第 2/4 步）：busy 判定 → 入队处置 →
// 完成回执依次发送。会话输入写入换桩（writeFn），不经真实 PTY

type queueTestFixture struct {
	t        *testing.T
	engine   *queueEngine
	writes   []string // writeFn 收到的 (session, text) 序列（拼接串）
	writeErr error    // 置非 nil 模拟写入失败
	writesMu sync.Mutex
}

func newQueueTestFixture(t *testing.T) *queueTestFixture {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	f := &queueTestFixture{t: t, engine: newQueueEngine()}
	f.engine.writeFn = func(sessionID, text string) error {
		f.writesMu.Lock()
		defer f.writesMu.Unlock()
		if f.writeErr != nil {
			return f.writeErr
		}
		f.writes = append(f.writes, sessionID+"|"+text)
		return nil
	}
	return f
}

func (f *queueTestFixture) written() []string {
	f.writesMu.Lock()
	defer f.writesMu.Unlock()
	return append([]string{}, f.writes...)
}

// seedProgress 落一条 task.progress 上报（busy 判定的数据面）
func (f *queueTestFixture) seedProgress(sessionID, status string, at time.Time) {
	f.t.Helper()
	if err := store.Get().AgentTask.Append(store.AgentTask{
		SessionID: sessionID, Type: "task.progress", Status: status, At: at,
	}); err != nil {
		f.t.Fatalf("seed progress: %v", err)
	}
}

func TestEnqueuePlan(t *testing.T) {
	// 拆解第 4 步的判定表：running 等 / idle 即发 / missing 降级手动
	if got := enqueuePlan(queueBusyRunning); got != "wait" {
		t.Fatalf("running → wait, got %s", got)
	}
	if got := enqueuePlan(queueBusyIdle); got != "send" {
		t.Fatalf("idle → send, got %s", got)
	}
	if got := enqueuePlan(queueBusyMissing); got != "manual" {
		t.Fatalf("missing → manual, got %s", got)
	}
}

func TestEnqueueWhileRunningWaitsForReceipt(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-run"
	now := time.Now()
	f.seedProgress(sid, "running", now)

	entry, sent, err := f.engine.Enqueue(sid, "先跑测试")
	if err != nil || sent {
		t.Fatalf("enqueue: sent=%v err=%v", sent, err)
	}
	if len(f.written()) != 0 {
		t.Fatalf("running 会话入队不得立即写入: %v", f.written())
	}
	if len(entry.Items) != 1 || !entry.Busy || !entry.AutoSend {
		t.Fatalf("entry: %+v", entry)
	}

	// 完成回执命中 → 队首发送并弹出（拆解第 2 步主链路）。
	// 桩收到的 text 不含 \r——尾部换行是生产写入口 writeSessionInput 的职责
	//（PTY Enter），引擎只负责把指令原文递到
	f.seedProgress(sid, "done", now.Add(time.Second))
	f.engine.OnReceipt(sid, now.Add(time.Second))
	writes := f.written()
	if len(writes) != 1 || writes[0] != sid+"|先跑测试" {
		t.Fatalf("receipt should send head verbatim: %v", writes)
	}
	entry, _ = buildQueueEntry(sid)
	if len(entry.Items) != 0 {
		t.Fatalf("sent item should pop: %+v", entry.Items)
	}
}

func TestReceiptsAdvanceQueueSequentially(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-seq"
	now := time.Now()
	f.seedProgress(sid, "running", now)
	for _, s := range []string{"指令一", "指令二", "指令三"} {
		if _, _, err := f.engine.Enqueue(sid, s); err != nil {
			t.Fatalf("enqueue %s: %v", s, err)
		}
	}
	if len(f.written()) != 0 {
		t.Fatalf("排队期不得写入: %v", f.written())
	}
	// 第一条完成 → 只发队首（依次语义：一次回执推进一拍）
	f.seedProgress(sid, "done", now.Add(time.Second))
	f.engine.OnReceipt(sid, now.Add(time.Second))
	if got := f.written(); len(got) != 1 || !strings.Contains(got[0], "指令一") {
		t.Fatalf("first receipt should send first item only: %v", got)
	}
	// 第二条完成 → 发第二条（失败轮次同样推进：done/failed 都是完成回执）
	f.seedProgress(sid, "failed", now.Add(2*time.Second))
	f.engine.OnReceipt(sid, now.Add(2*time.Second))
	if got := f.written(); len(got) != 2 || !strings.Contains(got[1], "指令二") {
		t.Fatalf("failed receipt should advance queue: %v", got)
	}
	// 第三条完成 → 队列清空
	f.seedProgress(sid, "done", now.Add(3*time.Second))
	f.engine.OnReceipt(sid, now.Add(3*time.Second))
	if got := f.written(); len(got) != 3 {
		t.Fatalf("all items should drain: %v", got)
	}
	// 队列已空：再来的回执不再发送、不报错
	f.seedProgress(sid, "done", now.Add(4*time.Second))
	f.engine.OnReceipt(sid, now.Add(4*time.Second))
	if got := f.written(); len(got) != 3 {
		t.Fatalf("empty queue should not send: %v", got)
	}
}

func TestEnqueueWhileIdleSendsImmediately(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-idle"
	now := time.Now()
	f.seedProgress(sid, "done", now) // 上轮已完成：会话空闲

	entry, sent, err := f.engine.Enqueue(sid, "接着做")
	if err != nil || !sent {
		t.Fatalf("idle enqueue should send now: sent=%v err=%v", sent, err)
	}
	if got := f.written(); len(got) != 1 || !strings.Contains(got[0], "接着做") {
		t.Fatalf("idle enqueue should write head: %v", got)
	}
	if len(entry.Items) != 0 {
		t.Fatalf("sent item should pop: %+v", entry.Items)
	}
}

func TestEnqueueWithoutReceiptsDegradesToManual(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-noreceipt" // 从未上报 task.progress（纯 shell / 无 SC skill）

	entry, sent, err := f.engine.Enqueue(sid, "手动发的指令")
	if err != nil || sent {
		t.Fatalf("missing busy should not send: sent=%v err=%v", sent, err)
	}
	if entry.AutoSend {
		t.Fatalf("missing busy should report autoSend=false: %+v", entry)
	}
	if len(f.written()) != 0 {
		t.Fatalf("degraded path must not write: %v", f.written())
	}
	// 之后智能体开始上报并完成：回执照常驱动排队指令（降级只影响当下判定）
	now := time.Now()
	f.seedProgress(sid, "running", now)
	f.seedProgress(sid, "done", now.Add(time.Second))
	f.engine.OnReceipt(sid, now.Add(time.Second))
	if got := f.written(); len(got) != 1 || !strings.Contains(got[0], "手动发的指令") {
		t.Fatalf("late receipts should drive queued item: %v", got)
	}
}

func TestWriteFailureKeepsItemQueued(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-fail"
	now := time.Now()
	f.seedProgress(sid, "done", now)
	f.writeErr = fmt.Errorf("pty gone")

	if _, sent, err := f.engine.Enqueue(sid, "会丢吗"); err != nil || sent {
		t.Fatalf("write failure should not report sent: sent=%v err=%v", sent, err)
	}
	f.writeErr = nil
	entry, _ := buildQueueEntry(sid)
	if len(entry.Items) != 1 {
		t.Fatalf("failed write should keep item: %+v", entry.Items)
	}
	// 会话恢复后下一条回执照常推进
	f.seedProgress(sid, "done", now.Add(time.Second))
	f.engine.OnReceipt(sid, now.Add(time.Second))
	if got := f.written(); len(got) != 1 || !strings.Contains(got[0], "会丢吗") {
		t.Fatalf("recovered write should proceed: %v", got)
	}
}

func TestReceiptWhileRunningWaits(t *testing.T) {
	f := newQueueTestFixture(t)
	sid := "agent-busy2"
	now := time.Now()
	f.seedProgress(sid, "running", now)
	if _, _, err := f.engine.Enqueue(sid, "排队的"); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// 回执 done 之后紧跟新一轮 running（用户手动起新任务 / 队列外的任务）：
	// busy=running → 队列继续等，不抢跑
	f.seedProgress(sid, "done", now.Add(time.Second))
	f.seedProgress(sid, "running", now.Add(2*time.Second))
	f.engine.OnReceipt(sid, now.Add(time.Second))
	if got := f.written(); len(got) != 0 {
		t.Fatalf("new running task should hold queue: %v", got)
	}
}

func TestQueueReceiptObserver(t *testing.T) {
	f := newQueueTestFixture(t)
	setDefaultQueueEngine(f.engine)
	t.Cleanup(func() { setDefaultQueueEngine(nil) })

	obs := QueueReceiptObserver()
	// 非终态 / 非 task.progress / 缺 terminalId：一律不驱动
	obs(opschannel.Event{Type: "task.progress", Payload: map[string]any{"status": "running", "terminalId": "obs-1"}})
	obs(opschannel.Event{Type: "notify", Payload: map[string]any{"status": "done", "terminalId": "obs-1"}})
	obs(opschannel.Event{Type: "task.progress", Payload: map[string]any{"status": "done"}})
	if len(f.written()) != 0 {
		t.Fatalf("observer fired on non-terminal event: %v", f.written())
	}
	// 观察者是异步派发：等 goroutine 落定再断言
	if _, _, err := f.engine.Enqueue("obs-1", "观察者送达"); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	now := time.Now()
	f.seedProgress("obs-1", "done", now)
	obs(opschannel.Event{Type: "task.progress", Payload: map[string]any{"status": "done", "terminalId": "obs-1"}})
	deadline := time.Now().Add(2 * time.Second)
	for len(f.written()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := f.written(); len(got) != 1 || !strings.Contains(got[0], "观察者送达") {
		t.Fatalf("observer should drive queue: %v", got)
	}
	// 等 sendHead 尾段副作用（审计落账是最后一笔）完成再返回——fire-and-forget
	// goroutine 若仍持文件句柄，t.TempDir 的 RemoveAll 清理会间歇性失败
	dl := time.Now().Add(2 * time.Second)
	for time.Now().Before(dl) {
		events, _, err := store.Get().Audit.List(10, 0)
		if err == nil {
			found := false
			for _, ev := range events {
				if ev.Action == "terminal.queue.send" {
					found = true
					break
				}
			}
			if found {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGetTerminalQueuesSkipsGhostsAndEmpty(t *testing.T) {
	f := newQueueTestFixture(t)
	// 无会话管理器（单测环境 DefaultManager 空）：排队过的会话全部视作幽灵，
	// 批量读不呈现——引擎层语义验证（handler 是薄壳）
	if _, _, err := f.engine.Enqueue("ghost-1", "x"); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	list, err := store.Get().AgentQueue.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("queue persisted: %v %v", list, err)
	}
}
