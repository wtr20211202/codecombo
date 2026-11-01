package remoteterminal

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockPTY 最小 PTYConn mock：Read 模拟阻塞读（sleep 后返回 0,nil，不终止 readLoop）
type mockPTY struct{ closed bool }

func (m *mockPTY) Write(p []byte) (int, error)       { return len(p), nil }
func (m *mockPTY) Read(p []byte) (int, error)        { time.Sleep(time.Second); return 0, nil }
func (m *mockPTY) Resize(uint16, uint16) error       { return nil }
func (m *mockPTY) Close() error                      { m.closed = true; return nil }
func (m *mockPTY) SetReadDeadline(t time.Time) error { return nil }

// scriptPTY 按序返回预设数据的 mock，耗尽后模拟阻塞读
type scriptPTY struct {
	mu     sync.Mutex
	chunks [][]byte
	closed bool
}

func (p *scriptPTY) Write(b []byte) (int, error) { return len(b), nil }
func (p *scriptPTY) Read(b []byte) (int, error) {
	p.mu.Lock()
	if len(p.chunks) > 0 {
		c := p.chunks[0]
		p.chunks = p.chunks[1:]
		p.mu.Unlock()
		return copy(b, c), nil
	}
	p.mu.Unlock()
	time.Sleep(500 * time.Millisecond)
	return 0, nil
}
func (p *scriptPTY) Resize(uint16, uint16) error { return nil }
func (p *scriptPTY) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	return nil
}
func (p *scriptPTY) SetReadDeadline(t time.Time) error { return nil }

// errPTY Read 立即返回 error 的 mock（模拟 SSH 连接建立后即断开）
type errPTY struct{ closed bool }

func (p *errPTY) Write(b []byte) (int, error)       { return 0, errors.New("conn dead") }
func (p *errPTY) Read(b []byte) (int, error)        { return 0, errors.New("conn reset by peer") }
func (p *errPTY) Resize(uint16, uint16) error       { return nil }
func (p *errPTY) Close() error                      { p.closed = true; return nil }
func (p *errPTY) SetReadDeadline(t time.Time) error { return nil }

// dialerFunc 函数适配 Dialer 接口（测试注入自定义拨号行为）
type dialerFunc func(spec SessionSpec) (PTYConn, error)

func (f dialerFunc) DialPTY(spec SessionSpec) (PTYConn, error) { return f(spec) }

// mockDialer 默认拨号 mock：总是返回可用的 mockPTY
type mockDialer struct{}

func (mockDialer) DialPTY(spec SessionSpec) (PTYConn, error) { return &mockPTY{}, nil }

// waitFor 轮询等待条件成立（10ms 间隔），超时返回 false
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

func TestSessionLifecycle(t *testing.T) {
	m := NewManager(mockDialer{}, 20)
	s, err := m.CreateSession("host-1", 24, 80, "")
	if err != nil || s == nil {
		t.Fatalf("create: %v", err)
	}
	if len(s.ID) != 32 {
		t.Fatalf("sessionId must be 32-hex, got %q", s.ID)
	}
	if strings.Trim(s.ID, "0123456789abcdef") != "" {
		t.Fatalf("sessionId must be hex, got %q", s.ID)
	}
	if !s.TryAcquireConn() {
		t.Fatal("first acquire should succeed")
	}
	if s.TryAcquireConn() {
		t.Fatal("second acquire should fail")
	}
	s.ReleaseConn()
	if !s.TryAcquireConn() {
		t.Fatal("re-acquire after release should succeed")
	}
	m.KillHostSessions("host-1")
	if m.GetSession(s.ID) != nil {
		t.Fatal("session should be killed")
	}
}

func TestSessionLimit(t *testing.T) {
	m := NewManager(mockDialer{}, 2)
	s1, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	s2, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	if s1.ID == s2.ID {
		t.Fatal("session ids must be unique")
	}
	if _, err := m.CreateSession("h", 24, 80, ""); err == nil {
		t.Fatal("expect session limit error")
	} else if !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("limit error must wrap ErrSessionLimit (API 层 errors.Is 区分 409/502), got %v", err)
	}
}

// TestGCAfterDisconnect WS 断开后超过 GC 窗口（测试注入 80ms）无重连 → 会话被回收
func TestGCAfterDisconnect(t *testing.T) {
	m := NewManagerWithGC(mockDialer{}, 20, 80*time.Millisecond)
	s, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	if !s.TryAcquireConn() {
		t.Fatal("acquire should succeed")
	}
	s.ReleaseConn()
	if !waitFor(t, 2*time.Second, func() bool { return m.GetSession(s.ID) == nil }) {
		t.Fatal("session should be killed after GC window expires")
	}
}

// TestGCStoppedOnReconnect 断开后 GC 窗口内重连 → GC 取消；再次断开 → GC 重新触发
func TestGCStoppedOnReconnect(t *testing.T) {
	m := NewManagerWithGC(mockDialer{}, 20, 100*time.Millisecond)
	s, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	if !s.TryAcquireConn() {
		t.Fatal("acquire should succeed")
	}
	s.ReleaseConn()
	if !s.TryAcquireConn() {
		t.Fatal("reconnect within GC window should succeed")
	}
	time.Sleep(250 * time.Millisecond) // 超过 GC 窗口时长，但已重连，不应被回收
	if m.GetSession(s.ID) == nil {
		t.Fatal("session must survive when reconnected within GC window")
	}
	s.ReleaseConn()
	if !waitFor(t, 2*time.Second, func() bool { return m.GetSession(s.ID) == nil }) {
		t.Fatal("session should be GC'd after second disconnect")
	}
}

// TestScrollbackReplay readLoop 消费 PTY 输出写入 scrollback，ScrollbackBytes 可取回完整历史
func TestScrollbackReplay(t *testing.T) {
	pty := &scriptPTY{chunks: [][]byte{[]byte("hello "), []byte("remote world")}}
	m := NewManagerWithGC(dialerFunc(func(spec SessionSpec) (PTYConn, error) { return pty, nil }), 20, time.Hour)
	s, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	want := "hello remote world"
	if !waitFor(t, 2*time.Second, func() bool { return len(s.ScrollbackBytes()) >= len(want) }) {
		t.Fatalf("scrollback should capture PTY output, got %q", string(s.ScrollbackBytes()))
	}
	if got := string(s.ScrollbackBytes()); got != want {
		t.Fatalf("scrollback = %q, want %q", got, want)
	}
}

// TestDialError 拨号失败返回 error 且不注册会话
func TestDialError(t *testing.T) {
	boom := errors.New("dial failed")
	m := NewManagerWithGC(dialerFunc(func(spec SessionSpec) (PTYConn, error) { return nil, boom }), 20, time.Hour)
	if _, err := m.CreateSession("h", 24, 80, ""); err == nil {
		t.Fatal("expect dial error")
	}
	if len(m.ListSessions()) != 0 {
		t.Fatal("failed session must not be registered")
	}
}

// TestKillHostSessionsCascade 级联只杀目标主机，其他主机会话存活
func TestKillHostSessionsCascade(t *testing.T) {
	ptyA := &scriptPTY{chunks: [][]byte{[]byte("a")}}
	ptyB := &scriptPTY{chunks: [][]byte{[]byte("b")}}
	m := NewManagerWithGC(dialerFunc(func(spec SessionSpec) (PTYConn, error) {
		if spec.HostID == "host-a" {
			return ptyA, nil
		}
		return ptyB, nil
	}), 20, time.Hour)

	sa, err := m.CreateSession("host-a", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	sb, err := m.CreateSession("host-b", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}

	if n := m.KillHostSessions("host-a"); n != 1 {
		t.Fatalf("KillHostSessions should kill 1 session, got %d", n)
	}
	if m.GetSession(sa.ID) != nil {
		t.Fatal("host-a session should be killed")
	}
	if m.GetSession(sb.ID) == nil {
		t.Fatal("host-b session must survive")
	}
	if !ptyA.closed {
		t.Fatal("host-a PTY conn should be closed")
	}
	if ptyB.closed {
		t.Fatal("host-b PTY conn must stay open")
	}
}

// TestReadErrorSelfCleanup readLoop 读到 error（SSH 断开）→ Kill → onExit → removeSession
// 验证会话从 Manager 自移除且底层连接被关闭的自清理链路
func TestReadErrorSelfCleanup(t *testing.T) {
	pty := &errPTY{}
	m := NewManagerWithGC(dialerFunc(func(spec SessionSpec) (PTYConn, error) { return pty, nil }), 20, time.Hour)
	s, err := m.CreateSession("h", 24, 80, "")
	if err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 2*time.Second, func() bool { return m.GetSession(s.ID) == nil }) {
		t.Fatal("session should self-remove from manager after read error")
	}
	if !pty.closed {
		t.Fatal("PTY conn should be closed on read error")
	}
}
