package sshclient

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH 反向隧道管理器（P-20261019-11）：实例主动连用户自带的 VPS 中继，
// 经 ssh.Client.Listen（RFC 4254 tcpip-forward）请求远端监听端口，accept
// 后把每条入站连接双向搬运到本机主服务端口——「任意手机网络访问家里实例」
// 的接入面。与 tunnel.go（远端→本机 direct-tcpip 正向取端口）方向相反，
// 两者共用既有 Dial/TOFU 主机密钥/凭据解析基建。
//
// 生命周期（单活）：同一时刻至多一条反向隧道；Start 新档案 = 停旧 → 起新
// （一键切换，秒级中断）。断线自动重连（指数退避 + 状态机 + keepalive
// 半开探测），Stop 幂等，模块停机级联 CloseAll。
//
// 安全边界：只做裸 TCP 转发到本机回环主端口（TLS/鉴权由主服务自身承担）；
// 远端绑定地址由档案决定（0.0.0.0 公网直连 / 127.0.0.1 供 VPS 反代）；
// 并发入站连接硬上限（默认 64）防无界 goroutine/内存放大。

const (
	// ReverseStateStopped 未启用
	ReverseStateStopped = "stopped"
	// ReverseStateConnecting 首次拨号中（Start 同步阶段，短暂态）
	ReverseStateConnecting = "connecting"
	// ReverseStateOnline 隧道在线（远端监听已建立）
	ReverseStateOnline = "online"
	// ReverseStateReconnecting 已在线过但连接断开，退避重连中
	ReverseStateReconnecting = "reconnecting"
	// ReverseStateFailed 首次建立失败（不自动重试——避免对错误配置/
	// 错误凭据持续撞 sshd 触发 fail2ban；修好后手动重试）
	ReverseStateFailed = "failed"
)

// DefaultReverseMaxConns 单条反向隧道并发入站连接上限
const DefaultReverseMaxConns = 64

// reverseReconnectBase/Max 重连指数退避区间
const (
	reverseReconnectBase = 1 * time.Second
	reverseReconnectMax  = 30 * time.Second
	reverseKeepalive     = 20 * time.Second
	reverseDialTimeout   = 15 * time.Second
	reverseLocalDialTO   = 10 * time.Second
)

// 事件类型（API 层据此审计/广播；与状态机变迁一一对应）
const (
	ReverseEventStarted      = "started"
	ReverseEventStopped      = "stopped"
	ReverseEventFailed       = "failed"       // 首次建立失败
	ReverseEventReconnecting = "reconnecting" // 连接断开，进入退避重连
	ReverseEventReconnected  = "reconnected"  // 重连成功
	ReverseEventReconnectErr = "reconnect_failed"
)

// ErrReverseNoDialer 未提供拨号闭包（编程错误）
var ErrReverseNoDialer = errors.New("reverse tunnel dialer is nil")

// ErrReverseShutdown 管理器已随模块停机关闭（停机后不再接受新隧道）
var ErrReverseShutdown = errors.New("reverse tunnel manager is shut down")

// ReverseSpec 一条反向隧道的运行参数（API 层由档案 + 本机端口构造）
type ReverseSpec struct {
	// ProfileID 档案 id（状态/幂等判定键；展示口径）
	ProfileID string
	// RemoteBindHost 远端绑定地址（0.0.0.0 | 127.0.0.1）
	RemoteBindHost string
	// RemotePort 远端绑定端口
	RemotePort int
	// LocalAddr 本机目标地址（127.0.0.1:<主服务端口>）
	LocalAddr string
	// PublicURL 公网访问 URL（域名优先；空 = 无直接地址，如回环+反代未配域名）
	PublicURL string
	// MaxConns 并发入站上限（<=0 取默认）
	MaxConns int
	// ClientIP 触发本次启动的客户端 IP（审计归属；自动恢复为空）
	ClientIP string
	// Dial 拨号闭包：每次首次建立/重连时重新解析凭据拨号（跟随最新配置）
	Dial func() (*ssh.Client, error)
}

// ReverseStatus 隧道状态快照（REST/事件载荷单一事实源）
type ReverseStatus struct {
	State        string `json:"state"`
	ProfileID    string `json:"profileId,omitempty"`
	RemoteHost   string `json:"remoteBindHost,omitempty"`
	RemotePort   int    `json:"remotePort,omitempty"`
	PublicURL    string `json:"publicUrl,omitempty"`
	StartedAt    string `json:"startedAt,omitempty"`   // RFC3339
	OnlineSince  string `json:"onlineSince,omitempty"` // RFC3339（本次连接建立时刻）
	LastError    string `json:"lastError,omitempty"`
	LastErrorAt  string `json:"lastErrorAt,omitempty"` // RFC3339
	Attempts     int    `json:"reconnectAttempts"`     // 当前连续重连次数（成功后归零）
	ActiveConns  int    `json:"activeConnections"`     // 在途入站连接数
	TotalConns   int64  `json:"totalConnections"`      // 累计入站连接数
	DroppedConns int64  `json:"droppedConnections"`    // 超并发上限被拒连接数
}

// ReverseEvent 生命周期事件（API 层审计 + ops-channel 广播）
type ReverseEvent struct {
	Type     string
	Status   ReverseStatus
	Err      error
	ClientIP string // 触发启动的客户端 IP（审计归属；自动恢复为空）
}

// ReverseTunnelManager 反向隧道管理器（单活）
type ReverseTunnelManager struct {
	opMu     sync.Mutex // 串行化 Start/Stop/CloseAll（连接建立可在锁外进行）
	mu       sync.Mutex
	cur      *reverseTunnel
	onEvent  func(ReverseEvent)
	shutdown bool
}

// NewReverseTunnelManager 创建管理器；onEvent 可为 nil（测试/无审计场景）
func NewReverseTunnelManager(onEvent func(ReverseEvent)) *ReverseTunnelManager {
	return &ReverseTunnelManager{onEvent: onEvent}
}

// SetEventHandler 运行期注入事件回调（模块 Init 装配审计/广播）
func (m *ReverseTunnelManager) SetEventHandler(fn func(ReverseEvent)) {
	m.mu.Lock()
	m.onEvent = fn
	m.mu.Unlock()
}

// Start 启动（或幂等复用）反向隧道。同 ProfileID 已在线/重连中直接返回当前
// 状态；不同档案会先停旧再起新（一键切换语义：切换期间短暂中断）。
// 首次建立失败不自动重试（返回 error + failed 状态），修好配置后手动重试；
// 只有「曾经在线过」的连接断开才进入自动重连。
func (m *ReverseTunnelManager) Start(spec ReverseSpec) (ReverseStatus, error) {
	if spec.Dial == nil {
		return ReverseStatus{State: ReverseStateFailed}, ErrReverseNoDialer
	}
	if spec.MaxConns <= 0 {
		spec.MaxConns = DefaultReverseMaxConns
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.shutdown {
		return ReverseStatus{State: ReverseStateFailed}, ErrReverseShutdown
	}

	m.mu.Lock()
	cur := m.cur
	if cur != nil {
		st := cur.status()
		if cur.spec.ProfileID == spec.ProfileID && (st.State == ReverseStateOnline || st.State == ReverseStateReconnecting || st.State == ReverseStateConnecting) {
			m.mu.Unlock()
			return st, nil
		}
	}
	m.mu.Unlock()
	if cur != nil {
		m.stopTunnel(cur, "switch")
	}

	t := &reverseTunnel{
		spec:      spec,
		state:     ReverseStateConnecting,
		startedAt: time.Now(),
		closed:    make(chan struct{}),
		emit:      m.emit,
	}
	// 先把 connecting 态挂上，Status 在拨号窗口内可读（不持锁拨号）
	m.mu.Lock()
	m.cur = t
	m.mu.Unlock()

	client, err := t.connectOnce()
	if err != nil {
		// failed 态保留在槽位供 UI/agent 读 lastError（不入自动重连）
		t.setFailed(err)
		ev := t.event(ReverseEventFailed, err)
		m.emit(ev)
		return ev.Status, err
	}
	t.setOnline(client)
	ev := t.event(ReverseEventStarted, nil)
	go t.run()
	m.emit(ev)
	return ev.Status, nil
}

// Stop 停止当前隧道（幂等）。返回是否确有隧道被停以及停止后的状态。
func (m *ReverseTunnelManager) Stop() (bool, ReverseStatus) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	cur := m.cur
	m.mu.Unlock()
	if cur == nil {
		return false, ReverseStatus{State: ReverseStateStopped}
	}
	st := m.stopTunnel(cur, "manual")
	return true, st
}

// CloseAll 模块停机级联关闭（不广播/不审计——进程正在退出）
func (m *ReverseTunnelManager) CloseAll() {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.shutdown = true
	m.mu.Lock()
	cur := m.cur
	m.mu.Unlock()
	if cur != nil {
		m.stopTunnel(cur, "shutdown")
	}
}

// Status 当前状态快照（无隧道 = stopped）
func (m *ReverseTunnelManager) Status() ReverseStatus {
	m.mu.Lock()
	cur := m.cur
	m.mu.Unlock()
	if cur == nil {
		return ReverseStatus{State: ReverseStateStopped}
	}
	return cur.status()
}

// stopTunnel 停止并移出当前槽位（调用方持 opMu；reason 只入日志）
func (m *ReverseTunnelManager) stopTunnel(t *reverseTunnel, reason string) ReverseStatus {
	t.stop()
	m.mu.Lock()
	if m.cur == t {
		m.cur = nil
	}
	m.mu.Unlock()
	st := t.status()
	slog.Info("sshclient: reverse tunnel stopped", "profile", t.spec.ProfileID, "reason", reason)
	if reason != "shutdown" {
		m.emit(ReverseEvent{Type: ReverseEventStopped, Status: st})
	}
	return st
}

func (m *ReverseTunnelManager) emit(ev ReverseEvent) {
	m.mu.Lock()
	fn := m.onEvent
	m.mu.Unlock()
	if fn != nil {
		fn(ev)
	}
}

// reverseTunnel 单条反向隧道：独占 SSH 连接 + 远端监听
type reverseTunnel struct {
	spec ReverseSpec

	mu        sync.Mutex
	client    *ssh.Client
	listener  net.Listener
	state     string
	startedAt time.Time
	onlineAt  time.Time
	lastErr   string
	lastErrAt time.Time
	attempts  int
	active    int
	total     int64
	dropped   int64

	stopped   atomic.Bool
	closeOnce sync.Once
	closed    chan struct{} // 停止信号（stop 关闭）
	emit      func(ReverseEvent)
}

// connectOnce 拨号并请求远端监听（不改变状态，调用方决定成败状态）
func (t *reverseTunnel) connectOnce() (*ssh.Client, error) {
	client, err := t.spec.Dial()
	if err != nil {
		return nil, fmt.Errorf("ssh dial for reverse tunnel: %w", err)
	}
	addr := net.JoinHostPort(t.spec.RemoteBindHost, strconv.Itoa(t.spec.RemotePort))
	ln, err := client.Listen("tcp", addr)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("remote bind %s failed (check AllowTcpForwarding / GatewayPorts and whether the port is already in use): %w", addr, err)
	}
	t.mu.Lock()
	t.client = client
	t.listener = ln
	t.mu.Unlock()
	return client, nil
}

func (t *reverseTunnel) setOnline(client *ssh.Client) {
	t.mu.Lock()
	t.client = client
	t.state = ReverseStateOnline
	t.onlineAt = time.Now()
	t.attempts = 0
	t.lastErr = ""
	t.mu.Unlock()
}

func (t *reverseTunnel) setFailed(err error) {
	t.mu.Lock()
	t.state = ReverseStateFailed
	t.lastErr = err.Error()
	t.lastErrAt = time.Now()
	t.mu.Unlock()
}

func (t *reverseTunnel) setReconnecting(err error) {
	t.mu.Lock()
	t.state = ReverseStateReconnecting
	t.attempts++
	t.lastErr = err.Error()
	t.lastErrAt = time.Now()
	t.mu.Unlock()
}

func (t *reverseTunnel) snapshotLocked(now time.Time, st ReverseStatus) ReverseStatus {
	st.State = t.state
	st.ProfileID = t.spec.ProfileID
	st.RemoteHost = t.spec.RemoteBindHost
	st.RemotePort = t.spec.RemotePort
	st.PublicURL = t.spec.PublicURL
	st.Attempts = t.attempts
	st.ActiveConns = t.active
	st.TotalConns = t.total
	st.DroppedConns = t.dropped
	if !t.startedAt.IsZero() {
		st.StartedAt = t.startedAt.Format(time.RFC3339)
	}
	if !t.onlineAt.IsZero() {
		st.OnlineSince = t.onlineAt.Format(time.RFC3339)
	}
	if t.lastErr != "" {
		st.LastError = t.lastErr
		if !t.lastErrAt.IsZero() {
			st.LastErrorAt = t.lastErrAt.Format(time.RFC3339)
		}
	}
	return st
}

func (t *reverseTunnel) status() ReverseStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked(time.Now(), ReverseStatus{})
}

func (t *reverseTunnel) event(typ string, err error) ReverseEvent {
	return ReverseEvent{Type: typ, Status: t.status(), Err: err, ClientIP: t.spec.ClientIP}
}

// run 在线后的生命周期：serve 当前连接 → 断开则指数退避重连 → 直到 stop
func (t *reverseTunnel) run() {
	for {
		t.serve()
		if t.stopped.Load() {
			return
		}
		t.setReconnecting(errors.New("ssh connection closed; reconnecting"))
		t.emit(t.event(ReverseEventReconnecting, nil))
		for {
			if t.stopped.Load() {
				return
			}
			delay := reverseBackoff(t.currentAttempts())
			select {
			case <-t.closed:
				return
			case <-time.After(delay):
			}
			client, err := t.connectOnce()
			if err != nil {
				t.mu.Lock()
				t.attempts++
				t.lastErr = err.Error()
				t.lastErrAt = time.Now()
				t.mu.Unlock()
				slog.Warn("sshclient: reverse tunnel reconnect failed", "profile", t.spec.ProfileID, "err", err)
				t.emit(t.event(ReverseEventReconnectErr, err))
				continue
			}
			// Stop 与重连拨号竞态：stop() 已执行完（closeOnce 不再生效），
			// 新建立的连接与远端监听必须就地回收，否则停止后仍会接受入站
			if t.stopped.Load() {
				t.closeConn(client)
				return
			}
			t.setOnline(client)
			slog.Info("sshclient: reverse tunnel reconnected", "profile", t.spec.ProfileID)
			t.emit(t.event(ReverseEventReconnected, nil))
			break
		}
	}
}

// serve 当前连接上的远端监听 accept 循环 + keepalive。返回即连接已不可用。
func (t *reverseTunnel) serve() {
	t.mu.Lock()
	ln := t.listener
	client := t.client
	t.mu.Unlock()
	if ln == nil || client == nil {
		return
	}
	if t.stopped.Load() {
		_ = ln.Close()
		t.closeConn(client)
		return
	}
	keepDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(reverseKeepalive)
		defer ticker.Stop()
		for {
			select {
			case <-keepDone:
				return
			case <-t.closed:
				return
			case <-ticker.C:
				// 半开连接探测：只有 err 才判定死亡（老 sshd 对未知 keepalive
				// 回 failure 不代表连接不可用）
				if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
					slog.Warn("sshclient: reverse tunnel keepalive failed", "profile", t.spec.ProfileID, "err", err)
					_ = ln.Close()
					_ = client.Close()
					return
				}
			}
		}
	}()
	defer close(keepDone)
	defer func() {
		_ = ln.Close()
		_ = client.Close()
		t.mu.Lock()
		if t.listener == ln {
			t.listener = nil
		}
		if t.client == client {
			t.client = nil
		}
		t.mu.Unlock()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if !t.stopped.Load() {
				slog.Warn("sshclient: reverse tunnel listener closed", "profile", t.spec.ProfileID, "err", err)
			}
			return
		}
		if !t.admit() {
			_ = conn.Close()
			continue
		}
		go t.pipe(conn)
	}
}

// admit 并发准入（超限拒绝并计数，绝不无界起 goroutine）
func (t *reverseTunnel) admit() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active >= t.spec.MaxConns {
		t.dropped++
		return false
	}
	t.active++
	t.total++
	return true
}

func (t *reverseTunnel) release() {
	t.mu.Lock()
	if t.active > 0 {
		t.active--
	}
	t.mu.Unlock()
}

// pipe 单条入站连接 ↔ 本机主端口双向搬运
func (t *reverseTunnel) pipe(remote net.Conn) {
	defer func() {
		_ = remote.Close()
		t.release()
	}()
	local, err := net.DialTimeout("tcp", t.spec.LocalAddr, reverseLocalDialTO)
	if err != nil {
		slog.Warn("sshclient: reverse tunnel local target unreachable", "profile", t.spec.ProfileID, "local", t.spec.LocalAddr, "err", err)
		return
	}
	defer func() { _ = local.Close() }()
	go func() {
		_, _ = io.Copy(remote, local)
		if cw, ok := remote.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	_, _ = io.Copy(local, remote)
}

func (t *reverseTunnel) currentAttempts() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.attempts
}

// stop 幂等停止：关闭停止信号、远端监听与 SSH 连接（在途连接随通道关闭消亡）
func (t *reverseTunnel) stop() {
	t.closeOnce.Do(func() {
		t.stopped.Store(true)
		close(t.closed)
		t.mu.Lock()
		ln := t.listener
		client := t.client
		t.listener = nil
		t.client = nil
		t.state = ReverseStateStopped
		t.mu.Unlock()
		if ln != nil {
			_ = ln.Close()
		}
		if client != nil {
			_ = client.Close()
		}
		// 唤醒可能卡在 Dial/Listen 的首次建立？Start 持 opMu 且 stop 不能并发
		// 打断正在进行的 Start（见 Start 注释：先完成/失败再切换），这里只
		// 处理已建立的连接。
	})
}

// closeConn 关闭当前连接及其远端监听并清槽（停止竞态回收用）
func (t *reverseTunnel) closeConn(client *ssh.Client) {
	t.mu.Lock()
	ln := t.listener
	t.listener = nil
	t.client = nil
	t.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	if client != nil {
		_ = client.Close()
	}
}

// reverseBackoff 指数退避（1s,2s,4s… 封顶 30s）；attempts 从 1 起
func reverseBackoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	d := reverseReconnectBase
	for i := 1; i < attempts && d < reverseReconnectMax; i++ {
		d *= 2
	}
	if d > reverseReconnectMax {
		d = reverseReconnectMax
	}
	return d
}
