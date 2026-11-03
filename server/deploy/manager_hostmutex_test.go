package deploy

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// startSilentListener 静默 TCP 监听器：接受连接后不回应（SSH 版本交换挂起到
// 客户端 15s 拨号超时），让首个部署任务稳定停留在 running/queued 态——per-host
// 互斥的「被占」窗口由此可测。返回的 cleanup 幂等（显式排空调用 + t.Cleanup
// 兜底双场景），关闭监听并断开已吞连接，让挂起任务快速 EOF 失败收尾
func startSilentListener(t *testing.T) (port int, cleanup func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				select {
				case <-done: // 测试收尾：断开让对端拨号立即失败
				case <-time.After(30 * time.Second):
				}
			}(c)
		}
	}()
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(portStr)
	return p, func() {
		once.Do(func() {
			ln.Close()
			<-done
		})
	}
}

func mutexTriggerReq(hostID string) TriggerRequest {
	return TriggerRequest{HostID: hostID, Instances: []config.DeployerInstance{{DeployerID: "init_user"}}}
}

// installTaskDoneStore 装配独立文件 store 供通知钩子落库——Trigger 派生的任务
// goroutine 结束时会读全局 store（notifyTaskDone），后续测试会 swap 全局 store，
// 残留 goroutine 的读取即数据竞态，故互斥链测试必须装 store 并排空后再返回
func installTaskDoneStore(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	// 预热通知偏好懒缓存（GetPrefs 首调会无锁写 r.prefs）：排队唤醒链（P-20261004-36）
	// 下前后两个任务并发 finish，两条 notifyTaskDone 并发 Add——预热后 GetPrefs
	// 只读，并发 Add 不再构成懒初始化写竞态
	store.Get().Notification.GetPrefs()
	t.Cleanup(func() { store.SetDefault(nil) })
}

// waitTasksDrained 等任务全部落终态且终态通知到达。notifyTaskDone 是任务
// goroutine 倒数第二步、Notification.Add 返回即通知已入库——通知到齐才是
// 「goroutine 已退出」的确定性栅栏（仅等终态状态存在 persist 先于 notify 的
// 残余窗口）。本包任务在无远端环境下全部以 failed 收尾，各推一条通知
func waitTasksDrained(t *testing.T, s *fakeTaskStore, ids ...string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for _, id := range ids {
		for time.Now().Before(deadline) {
			st, ok := s.lastStatusByID(id)
			if ok && st != config.TaskStatusQueued && st != config.TaskStatusRunning {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if st, ok := s.lastStatusByID(id); !ok || st == config.TaskStatusQueued || st == config.TaskStatusRunning {
			t.Fatalf("task %s should reach terminal state in time, status=%q found=%v", id, st, ok)
		}
	}
	// 通知到达轮询（状态 persist 先于 notify 的残余窗口——慢 FS runner 上
	// 立即断言曾丢后到通知，实锚 got 1/2）：窗口内等通知到齐再放行
	nDeadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(nDeadline) {
		if len(store.Get().Notification.List(0)) >= len(ids) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if n := len(store.Get().Notification.List(0)); n < len(ids) {
		t.Fatalf("expected ≥%d task-done notifications as drain barrier, got %d", len(ids), n)
	}
}

// 锁原语契约：tryLock 互斥、被占上报持锁者、仅持锁者可释放（幂等）、不同主机互不干扰
func TestHostMutexPrimitives(t *testing.T) {
	m := NewManager(&fakeTaskStore{})
	if _, ok := m.tryLockHost("h1", "t1"); !ok {
		t.Fatal("first acquire should succeed")
	}
	if holder, ok := m.tryLockHost("h1", "t2"); ok {
		t.Fatalf("second acquire should be rejected, ok=%v", ok)
	} else if holder != "t1" {
		t.Fatalf("rejection should report holder t1, got %q", holder)
	}
	m.unlockHost("h1", "t2") // 非持锁者释放必须无效
	if _, ok := m.tryLockHost("h1", "t3"); ok {
		t.Fatal("lock should still be held after foreign release")
	}
	m.unlockHost("h1", "t1")
	if _, ok := m.tryLockHost("h1", "t3"); !ok {
		t.Fatal("lock should be acquirable after holder release")
	}
	if _, ok := m.tryLockHost("h2", "t4"); !ok {
		t.Fatal("different host should not be blocked")
	}
}

// 同主机并发触发 NoWait 二拒一（P-20261003-41 拒绝式契约，P-20261004-36 起为
// 「不等候」开关的保留路径）：首个任务占锁（静默监听器让 SSH 拨号挂起，任务
// 稳定在途），后续并发触发全部被拒且错误携带持锁任务 ID，被拒触发不产生任务
// 记录；另一台主机不受影响。并发形状供 -race 门禁检验锁正确性
func TestTriggerHostMutexRejectsConcurrentSameHost(t *testing.T) {
	installTaskDoneStore(t)
	port, cleanup := startSilentListener(t)
	t.Cleanup(cleanup)
	s := &fakeTaskStore{}
	m := NewManager(s)
	h := &config.RemoteHost{ID: "h1", Host: "127.0.0.1", Port: port, User: "u", AuthType: "password", Password: "x"}

	first, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("first trigger: %v", err)
	}

	var wg sync.WaitGroup
	rejected := 0
	var rejectedMu sync.Mutex
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := mutexTriggerReq(h.ID)
			req.NoWait = true
			_, err := m.Trigger(context.Background(), req, h, &config.DeployConfig{})
			rejectedMu.Lock()
			defer rejectedMu.Unlock()
			rejected++
			if err == nil {
				t.Error("concurrent no-wait trigger on same host should be rejected")
				return
			}
			if !strings.Contains(err.Error(), "deploy already in progress") || !strings.Contains(err.Error(), first) {
				t.Errorf("rejection should name mutex + holder task, got: %v", err)
			}
		}()
	}
	wg.Wait()
	if rejected != 6 {
		t.Fatalf("expected 6 rejections, got %d", rejected)
	}
	// 被拒触发不得创建新任务（数去重 ID 而非 Save 次数——run/finishTask 对
	// 同一任务会追加持久化）
	if n := s.distinctTaskIDs(); n != 1 {
		t.Fatalf("rejected triggers must not create tasks, got %d distinct tasks", n)
	}

	// 另一台主机不受同主机互斥影响
	other := &config.RemoteHost{ID: "h2", Host: "127.0.0.1", Port: 1, User: "u", AuthType: "password", Password: "x"}
	h2Task, err := m.Trigger(context.Background(), mutexTriggerReq("h2"), other, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("different host should trigger fine: %v", err)
	}

	// 排空按任务串行：notificationRepo 的 prefs 惰性读写无锁（既有实现），
	// 两任务并发 finish 会构成 Add→GetPrefs 数据竞态，故逐个等通知到齐
	waitTasksDrained(t, s, h2Task)
	// 断开静默监听让挂起拨号 EOF 失败，再等首任务终态 + 通知到齐，
	// 不给后续测试留读全局 store 的残留 goroutine
	cleanup()
	waitTasksDrained(t, s, first)
}

// 排队模式核心契约（P-20261004-36）：同主机第二/三触发默认排队（queued +
// waitingFor=持锁任务 + FIFO 位次），取消排队摘队并接力唤醒，持锁任务终态
// 释放锁后队首自动唤醒执行（fake store 里必须出现过 running 记录，锁死「真跑过」
// 而非排队中直接判负）
func TestTriggerHostMutexQueuesThenWakes(t *testing.T) {
	installTaskDoneStore(t)
	port, cleanup := startSilentListener(t)
	t.Cleanup(cleanup)
	s := &fakeTaskStore{}
	m := NewManager(s)
	h := &config.RemoteHost{ID: "h1", Host: "127.0.0.1", Port: port, User: "u", AuthType: "password", Password: "x"}

	first, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("first trigger: %v", err)
	}
	// 等首任务进入 running（锁稳定被占），排队触发的锚点才成立
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st, _ := s.lastStatusByID(first); st == config.TaskStatusRunning {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if st, _ := s.lastStatusByID(first); st != config.TaskStatusRunning {
		t.Fatalf("first task should be running (holding lock), status=%q", st)
	}

	// 第二触发（默认排队）：200 出任务，queued + waitingFor=first + 位次 1
	second, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("queued trigger should succeed, got: %v", err)
	}
	if got := m.QueuePosition(second); got != 1 {
		t.Fatalf("second task queue position = %d, want 1", got)
	}
	if st, _ := s.lastStatusByID(second); st != config.TaskStatusQueued {
		t.Fatalf("second task should stay queued, status=%q", st)
	}
	// waitingFor 从持久化记录断言（API 详情的读取面，非内存私有态）
	if rec, ok := s.lastTaskByID(second); !ok || rec.WaitingFor != first {
		t.Fatalf("second task persisted waitingFor = %q (found=%v), want %q", rec.WaitingFor, ok, first)
	}

	// 第三触发：FIFO 位次 2；取消排队 → cancelled 出终态并摘队，位次回归
	third, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("third trigger should queue, got: %v", err)
	}
	if got := m.QueuePosition(third); got != 2 {
		t.Fatalf("third task queue position = %d, want 2", got)
	}
	if !m.Cancel(third) {
		t.Fatal("cancelling a queued task should succeed")
	}
	dl := time.Now().Add(10 * time.Second)
	for time.Now().Before(dl) {
		if st, _ := s.lastStatusByID(third); st == config.TaskStatusCancelled {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if st, _ := s.lastStatusByID(third); st != config.TaskStatusCancelled {
		t.Fatalf("third task should be cancelled, status=%q", st)
	}
	if got := m.QueuePosition(third); got != 0 {
		t.Fatalf("cancelled task should leave the queue, position = %d", got)
	}
	if got := m.QueuePosition(second); got != 1 {
		t.Fatalf("second task should advance to position 1, got %d", got)
	}

	// 断开静默监听 → 首任务 EOF 失败释放锁 → 队首（second）被唤醒自动执行：
	// 必须出现过 running 记录（排除「没跑就终态」的假绿），最终落 failed
	cleanup()
	waitTasksDrained(t, s, first, second)
	sawRunning := false
	for _, rec := range s.snapshot() {
		if rec.ID == second && rec.Status == config.TaskStatusRunning {
			sawRunning = true
			break
		}
	}
	if !sawRunning {
		t.Fatal("second task should have been woken and started running after first finished")
	}
	if st, _ := s.lastStatusByID(second); st != config.TaskStatusFailed {
		t.Fatalf("second task should fail fast on closed port after wake, status=%q", st)
	}
}

// 任务终态释放：回环死端口 SSH 拒连秒失败 → finishTask 单一收尾点释放锁 →
// 同主机可再次触发（拒绝窗口已过，二次触发成功）。
// 终态判定看持久化状态而非 IsRunning——后者在任务结束后仍随 1h TTL 回放窗口
// 返回 true
func TestTriggerHostMutexReleaseAfterFinish(t *testing.T) {
	installTaskDoneStore(t)
	s := &fakeTaskStore{}
	m := NewManager(s)
	h := &config.RemoteHost{ID: "h1", Host: "127.0.0.1", Port: 1, User: "u", AuthType: "password", Password: "x"}

	first, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("first trigger: %v", err)
	}

	// 等首个任务终态（回环拒连通常 <1s；上限 10s 防 CI 抖动）
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := s.lastStatusByID(first)
		if st != config.TaskStatusQueued && st != config.TaskStatusRunning {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if st, ok := s.lastStatusByID(first); !ok || st == config.TaskStatusQueued || st == config.TaskStatusRunning {
		t.Fatalf("first task should reach terminal state in time, status=%q found=%v", st, ok)
	}
	// 先等首任务通知到齐（goroutine 退出的确定性栅栏）再触发下一个，
	// 避免两任务并发 finish 在 notificationRepo 无锁的 GetPrefs 上竞态
	waitTasksDrained(t, s, first)

	second, err := m.Trigger(context.Background(), mutexTriggerReq(h.ID), h, &config.DeployConfig{})
	if err != nil {
		t.Fatalf("re-trigger after terminal state should succeed, got: %v", err)
	}
	waitTasksDrained(t, s, second)
}
