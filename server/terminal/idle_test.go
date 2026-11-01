package terminal

import (
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ============== 测试夹具 ==============

// idleFakeConn 内存假 PTY 连接：Read 阻塞至 Close（模拟真实 PTY 的「关闭即
// 读错误」），Close 幂等并计数——断言 Detach 只关一次
type idleFakeConn struct {
	once   sync.Once
	closed chan struct{}
	closes int
}

func newIdleFakeConn() *idleFakeConn {
	return &idleFakeConn{closed: make(chan struct{})}
}

func (c *idleFakeConn) Read(_ []byte) (int, error) {
	<-c.closed
	return 0, io.EOF
}

func (c *idleFakeConn) Write(p []byte) (int, error) { return len(p), nil }

func (c *idleFakeConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	c.closes++
	return nil
}

func (c *idleFakeConn) Wait() (*os.ProcessState, error) { return nil, nil }

// idleFakeBackend 可编程持久化语义的假后端：persistent=true 模拟 tmux
// （Reattach 可用），false 模拟 native（Reattach 拒绝）
type idleFakeBackend struct {
	persistent bool
	reattaches int
}

func (b *idleFakeBackend) Create(SessionSpec) (ptyConn, error) { return newIdleFakeConn(), nil }
func (b *idleFakeBackend) CaptureScrollback(SessionSpec, int) ([]byte, error) {
	return nil, nil
}
func (b *idleFakeBackend) CaptureHistory(SessionSpec, int) ([]byte, error) { return nil, nil }
func (b *idleFakeBackend) RedrawClient(SessionSpec)                        {}
func (b *idleFakeBackend) Resize(ptyConn, SessionSpec, uint16, uint16) error {
	return nil
}
func (b *idleFakeBackend) Kill(ptyConn, SessionSpec) error { return nil }
func (b *idleFakeBackend) Alive(SessionSpec) bool          { return true }
func (b *idleFakeBackend) IsPersistent() bool              { return b.persistent }
func (b *idleFakeBackend) Reattach(spec SessionSpec) (ptyConn, error) {
	if !b.persistent {
		return nil, io.EOF
	}
	b.reattaches++
	return newIdleFakeConn(), nil
}

// newIdleFixture 造一个内存 Manager + 一枚可编程会话（fake backend + 假连接
// + readLoop 实跑，覆盖 Detach → readLoop 退出 → handleAttachExit 全链）
func newIdleFixture(t *testing.T, persistent bool) (*Manager, *Session, *idleFakeConn, *idleFakeBackend) {
	t.Helper()
	backend := &idleFakeBackend{persistent: persistent}
	conn := newIdleFakeConn()
	s := &Session{
		ID:       "term-idle",
		Name:     "空闲会话",
		Backend:  map[bool]string{true: "tmux", false: "native"}[persistent],
		spec:     SessionSpec{ID: "term-idle", TmuxName: "sc-x-abc123"},
		backend:  backend,
		ptmx:     conn,
		onOutput: make(map[int64]func([]byte)),
		onExit:   make(map[int64]func(int)),
	}
	s.touchActivity()
	m := &Manager{sessions: map[string]*Session{"term-idle": s}, ports: map[int]PortEntry{}}
	s.mgr = m
	go s.readLoop()
	t.Cleanup(func() { _ = conn.Close() })
	return m, s, conn, backend
}

// setIdleSettings 种空闲阈值设置（分钟），测试结束回落默认存储
func setIdleSettings(t *testing.T, mins int) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	cfg := store.Get().Settings.Get()
	cfg.Server.TerminalIdleTimeoutMin = mins
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

// waitAttachExited 等待 readLoop 退出处理落地（attachExited 由独立 goroutine
// 写，轮询免时序假设）。只等 attachExited：closed 语义两后端相反（tmux 保留
// false，native 才置 true），由各自用例断言
func waitAttachExited(t *testing.T, s *Session, want bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		got := s.attachExited
		s.mu.Unlock()
		if got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("attachExited not settled to %v within deadline", want)
}

// ============== 阈值解析 ==============

// TestIdleTimeoutThresholdDefaults 默认关：未配置（0）= 0 时长；越界脏值
// （负数/超上限）读取侧收敛为关闭——判定路径不报错，写入口已拦
func TestIdleTimeoutThresholdDefaults(t *testing.T) {
	for _, mins := range []int{0, -5, 43201} {
		setIdleSettings(t, mins)
		if got := IdleTimeoutThreshold(); got != 0 {
			t.Fatalf("threshold(%d) = %v, want 0 (off)", mins, got)
		}
	}
}

// TestIdleTimeoutThresholdValid 有效配置换算为时长
func TestIdleTimeoutThresholdValid(t *testing.T) {
	setIdleSettings(t, 480)
	if got := IdleTimeoutThreshold(); got != 480*time.Minute {
		t.Fatalf("threshold(480) = %v, want 8h", got)
	}
	setIdleSettings(t, 1)
	if got := IdleTimeoutThreshold(); got != time.Minute {
		t.Fatalf("threshold(1) = %v, want 1m", got)
	}
}

// ============== 判定门（时间注入，免 sleep） ==============

// TestDetachIfIdleGates 四重门逐一验证：阈值内不分离 / 无人附着门 /
// 已知运行中豁免 / known=false 不豁免
func TestDetachIfIdleGates(t *testing.T) {
	m, s, conn, _ := newIdleFixture(t, true)

	now := time.Now()

	// 门 3：活动时钟新鲜（10 分钟前） < 阈值（8 小时）→ 不分离
	s.mu.Lock()
	s.lastActivity.Store(now.Add(-10 * time.Minute).UnixNano())
	s.mu.Unlock()
	if _, ok := m.detachIfIdle(s, 8*time.Hour, now); ok {
		t.Fatalf("fresh session must not be detached")
	}

	// 门 3 越线：空闲 9 小时 → 命中分离
	s.mu.Lock()
	s.lastActivity.Store(now.Add(-9 * time.Hour).UnixNano())
	s.mu.Unlock()
	entry, ok := m.detachIfIdle(s, 8*time.Hour, now)
	if !ok || entry.SessionID != s.ID || !entry.Persistent {
		t.Fatalf("idle session must be detached, got %+v ok=%v", entry, ok)
	}
	waitAttachExited(t, s, true) // readLoop 退出处理：attachExited，session 保留

	// 已分离的会话不重复进入回执（Detach 幂等跳过）
	if _, ok := m.detachIfIdle(s, time.Nanosecond, now); ok {
		t.Fatalf("detached session must be skipped on re-scan")
	}
	_ = conn
}

// TestDetachIfIdleClientAttachedGate 门 2：有客户端附着的会话绝不分离——
// 前端断线自动重连，对着在用会话分离只会得到分离→重连的无谓抖动
func TestDetachIfIdleClientAttachedGate(t *testing.T) {
	m, s, conn, _ := newIdleFixture(t, true)
	now := time.Now()
	s.mu.Lock()
	s.lastActivity.Store(now.Add(-9 * time.Hour).UnixNano())
	s.mu.Unlock()
	s.AttachClient()
	defer s.DetachClient()

	if _, ok := m.detachIfIdle(s, 8*time.Hour, now); ok {
		t.Fatalf("client-attached session must not be detached")
	}
	if conn.closes != 0 {
		t.Fatalf("conn must stay open, closes=%d", conn.closes)
	}
}

// TestDetachIfIdleRunningGate 门 4：已知前台在跑（静默长任务）豁免；
// known=false（Windows ConPTY 不可判定）不豁免——取舍见 idle.go 文件头
func TestDetachIfIdleRunningGate(t *testing.T) {
	m, s, conn, _ := newIdleFixture(t, true)
	now := time.Now()
	s.mu.Lock()
	s.lastActivity.Store(now.Add(-9 * time.Hour).UnixNano())
	// 模拟 probeRunningLoop 已缓存的「运行中」探测结果
	s.runningKnown, s.running = true, true
	s.mu.Unlock()

	if _, ok := m.detachIfIdle(s, 8*time.Hour, now); ok {
		t.Fatalf("known-running session must be exempt")
	}
	if conn.closes != 0 {
		t.Fatalf("conn must stay open, closes=%d", conn.closes)
	}

	// 同一会话探测为「已知空闲」→ 命中分离
	s.mu.Lock()
	s.runningKnown, s.running = true, false
	s.mu.Unlock()
	if _, ok := m.detachIfIdle(s, 8*time.Hour, now); !ok {
		t.Fatalf("known-idle session must be detached")
	}
}

// ============== 分离语义（后端分叉） ==============

// TestCheckIdleSessionsDisabledOff 默认关零变化：阈值 0 时扫描直返，
// 超空闲会话原样保留（存量行为零变化的守卫断言）
func TestCheckIdleSessionsDisabledOff(t *testing.T) {
	setIdleSettings(t, 0) // 默认关
	m, s, conn, _ := newIdleFixture(t, true)
	s.mu.Lock()
	s.lastActivity.Store(time.Now().Add(-100 * time.Hour).UnixNano())
	s.mu.Unlock()

	if entries := m.CheckIdleSessions(); len(entries) != 0 {
		t.Fatalf("disabled sweep must return no entries, got %v", entries)
	}
	if m.GetSession(s.ID) == nil {
		t.Fatalf("session must survive when feature is off")
	}
	if conn.closes != 0 {
		t.Fatalf("conn must stay open, closes=%d", conn.closes)
	}
}

// TestCheckIdleSessionsTmuxPreserved tmux 档：分离后连接已关、attachExited
// 置位、会话仍在 Manager，Reattach 可重连——「分离非杀进程」的守卫断言
func TestCheckIdleSessionsTmuxPreserved(t *testing.T) {
	setIdleSettings(t, 1) // 1 分钟阈值
	m, s, conn, backend := newIdleFixture(t, true)
	s.mu.Lock()
	s.lastActivity.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	s.mu.Unlock()

	entries := m.CheckIdleSessions()
	if len(entries) != 1 || entries[0].SessionID != s.ID {
		t.Fatalf("expect exactly one detach entry, got %+v", entries)
	}
	if conn.closes == 0 {
		t.Fatalf("attach conn must be closed")
	}
	waitAttachExited(t, s, true)
	if m.GetSession(s.ID) == nil {
		t.Fatalf("tmux session must stay registered for reattach")
	}
	// 重连链路完整可用：EnsureAttached → Reattach → attachExited 复位
	if err := s.EnsureAttached(); err != nil {
		t.Fatalf("reattach after idle detach: %v", err)
	}
	if backend.reattaches != 1 {
		t.Fatalf("backend.Reattach calls = %d, want 1", backend.reattaches)
	}
	s.mu.Lock()
	reattached := !s.attachExited && s.ptmx != nil
	s.mu.Unlock()
	if !reattached {
		t.Fatalf("session must be attached again after reattach")
	}
}

// TestCheckIdleSessionsNativeEnds native 档：PTY 释放即会话终结并自移除
// （语义差异注记的守卫断言——不冒充可重连）
func TestCheckIdleSessionsNativeEnds(t *testing.T) {
	setIdleSettings(t, 1)
	m, s, conn, _ := newIdleFixture(t, false)
	s.mu.Lock()
	s.lastActivity.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	s.mu.Unlock()

	entries := m.CheckIdleSessions()
	if len(entries) != 1 || entries[0].Persistent {
		t.Fatalf("expect one non-persistent detach entry, got %+v", entries)
	}
	// native 走 handleAttachExit 的 shell 自行退出同款路径：closed + 自移除
	waitAttachExited(t, s, true)
	if got := m.GetSession(s.ID); got != nil {
		t.Fatalf("native session must be removed from manager after idle detach")
	}
	if conn.closes == 0 {
		t.Fatalf("pty conn must be closed")
	}
}

// TestCheckIdleSessionsMixedBatches 混合编队：只分离命中的，没到阈值的
// 同批会话不受影响（「活动会话不受影响」e2e 的单测对位）
func TestCheckIdleSessionsMixedBatches(t *testing.T) {
	setIdleSettings(t, 1)
	m, idleS, _, _ := newIdleFixture(t, true)
	idleS.mu.Lock()
	idleS.lastActivity.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	idleS.mu.Unlock()

	// 同批造一枚「刚活动过」的会话
	freshBackend := &idleFakeBackend{persistent: true}
	freshConn := newIdleFakeConn()
	fresh := &Session{
		ID: "term-fresh", Name: "活动会话", Backend: "tmux",
		spec:     SessionSpec{ID: "term-fresh", TmuxName: "sc-x-fresh"},
		backend:  freshBackend,
		ptmx:     freshConn,
		onOutput: make(map[int64]func([]byte)),
		onExit:   make(map[int64]func(int)),
	}
	fresh.touchActivity()
	m.mu.Lock()
	m.sessions[fresh.ID] = fresh
	m.mu.Unlock()
	fresh.mgr = m
	t.Cleanup(func() { _ = freshConn.Close() })

	entries := m.CheckIdleSessions()
	if len(entries) != 1 || entries[0].SessionID != idleS.ID {
		t.Fatalf("only the idle session must be detached, got %+v", entries)
	}
	if m.GetSession(fresh.ID) == nil || freshConn.closes != 0 {
		t.Fatalf("active session must be untouched")
	}
}
