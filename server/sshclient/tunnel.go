package sshclient

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH 本地转发隧道（P-20261004-5）：把远端主机回环端口经 SSH direct-tcpip
// 映射到实例本机临时端口，预览面板（/preview/:port 回环反代）由此够得着
// 远程 dev server——远端开发形态「终端里 npm run dev → 面板里直接看」的
// 跨机补全。转发技法为 x/crypto/ssh 成熟直发模式：每条本地连接开一路
// direct-tcpip 通道，io.Copy 双向搬运，无第三方依赖。
//
// 安全边界：本地监听硬编码 127.0.0.1（net.Listen("tcp", "127.0.0.1:0")），
// 不暴露 LAN；远端目标同样限定回环（dev server 绑远端 127.0.0.1）——
// 借道隧道探测远端内网其他主机不在能力面内。
// 泄漏双护栏：并发上限（默认 5）+ 空闲 TTL（默认 15min）自动回收；
// 显式关闭（REST DELETE / 主机删除级联 / 模块停机）随时释放。

const (
	// DefaultTunnelLimit 单实例并发隧道上限（每条隧道占用一条 SSH 连接 +
	// 一个本地监听口，防无界增长）
	DefaultTunnelLimit = 5
	// DefaultTunnelTTL 空闲回收窗口：最后一次本地连接静默该时长即回收
	//（dev server 还在跑没关系——预览再用时前端/agent 重开隧道即可）
	DefaultTunnelTTL = 15 * time.Minute
)

// ErrTunnelLimit 隧道数达到上限（API 层 errors.Is 区分 → 409）
var ErrTunnelLimit = errors.New("tunnel limit reached")

// TunnelInfo 隧道条目（REST 响应体；LastActive 由 lastUsed 快照得出）
type TunnelInfo struct {
	HostID     string    `json:"hostId"`
	RemotePort int       `json:"remotePort"`
	LocalPort  int       `json:"localPort"`
	CreatedAt  time.Time `json:"createdAt"`
	LastActive time.Time `json:"lastActive"`
}

// TunnelDialer 建立底层 SSH 连接。闭包在每次调用时解析凭据——断线重连
// 自动跟随最新凭据（主机改密后无需重建隧道）
type TunnelDialer func() (*ssh.Client, error)

// tunnel 单条隧道：本地回环监听 + 独占 SSH 连接
type tunnel struct {
	info TunnelInfo
	ln   net.Listener
	dial TunnelDialer

	// mu 串行化通道拨号与断线重连（多条本地连接并发 pipe 时只锁拨号瞬间）
	mu   sync.Mutex
	ssh  *ssh.Client
	dead atomic.Bool // 已显式关闭：acceptLoop 退出不再告警

	lastUsed atomic.Int64 // 最近一次本地连接（unix nano；TTL 与展示同源）
}

// TunnelManager 隧道管理器：hostID+remotePort 去重、并发上限、TTL 回收
type TunnelManager struct {
	mu      sync.Mutex
	tunnels map[string]*tunnel // key: hostID + "\n" + remotePort（远端目标恒为回环，不入键）
	limit   int
	ttl     time.Duration
}

// NewTunnelManager 创建管理器（limit/ttl 非正时取默认值）
func NewTunnelManager(limit int, ttl time.Duration) *TunnelManager {
	if limit <= 0 {
		limit = DefaultTunnelLimit
	}
	if ttl <= 0 {
		ttl = DefaultTunnelTTL
	}
	return &TunnelManager{tunnels: make(map[string]*tunnel), limit: limit, ttl: ttl}
}

func tunnelKey(hostID string, remotePort int) string {
	return hostID + "\n" + strconv.Itoa(remotePort)
}

// Open 打开（或复用）一条「远端回环 remotePort → 本机临时端口」的转发隧道。
// 同 key 幂等复用（前端重试/agent 重复上报不重复占口），命中即 touch 并返回
// 既有映射。监听口先占（内核分配临时端口，天然不冲突），SSH 拨号失败不落资源
func (m *TunnelManager) Open(hostID string, remotePort int, dial TunnelDialer) (TunnelInfo, error) {
	if hostID == "" {
		return TunnelInfo{}, fmt.Errorf("host id is empty")
	}
	if remotePort < 1 || remotePort > 65535 {
		return TunnelInfo{}, fmt.Errorf("invalid remote port %d", remotePort)
	}

	m.mu.Lock()
	key := tunnelKey(hostID, remotePort)
	if t, ok := m.tunnels[key]; ok {
		m.mu.Unlock()
		t.touch()
		return t.snapshot(), nil
	}
	if len(m.tunnels) >= m.limit {
		m.mu.Unlock()
		return TunnelInfo{}, fmt.Errorf("%w (%d)", ErrTunnelLimit, m.limit)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		m.mu.Unlock()
		return TunnelInfo{}, fmt.Errorf("listen local loopback: %w", err)
	}
	client, err := dial()
	if err != nil {
		_ = ln.Close()
		m.mu.Unlock()
		return TunnelInfo{}, fmt.Errorf("ssh dial for tunnel: %w", err)
	}
	now := time.Now()
	t := &tunnel{
		ln:   ln,
		dial: dial,
		info: TunnelInfo{
			HostID:     hostID,
			RemotePort: remotePort,
			LocalPort:  ln.Addr().(*net.TCPAddr).Port,
			CreatedAt:  now,
			LastActive: now,
		},
	}
	t.ssh = client
	t.lastUsed.Store(now.UnixNano())
	m.tunnels[key] = t
	m.mu.Unlock()

	go t.acceptLoop()
	slog.Info("sshclient: tunnel opened", "hostId", hostID,
		"remotePort", remotePort, "localPort", t.info.LocalPort)
	return t.snapshot(), nil
}

// Close 显式关闭指定隧道（按本地端口寻址，REST DELETE 语义）。
// 未命中返回 false（API 层 → 404）
func (m *TunnelManager) Close(hostID string, localPort int) bool {
	m.mu.Lock()
	var victim *tunnel
	for k, t := range m.tunnels {
		if t.info.HostID == hostID && t.info.LocalPort == localPort {
			victim = t
			delete(m.tunnels, k)
			break
		}
	}
	m.mu.Unlock()
	if victim == nil {
		return false
	}
	victim.shutdown()
	slog.Info("sshclient: tunnel closed", "hostId", hostID, "localPort", localPort)
	return true
}

// List 某主机的全部隧道（按本地端口升序；空切片而非 nil，REST 序列化稳定）
func (m *TunnelManager) List(hostID string) []TunnelInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]TunnelInfo, 0)
	for _, t := range m.tunnels {
		if t.info.HostID == hostID {
			out = append(out, t.snapshot())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LocalPort < out[j].LocalPort })
	return out
}

// CloseHost 级联关闭某主机的全部隧道（主机删除时调用），返回关闭数
func (m *TunnelManager) CloseHost(hostID string) int {
	m.mu.Lock()
	victims := make([]*tunnel, 0, 2)
	for k, t := range m.tunnels {
		if t.info.HostID == hostID {
			victims = append(victims, t)
			delete(m.tunnels, k)
		}
	}
	m.mu.Unlock()
	for _, t := range victims {
		t.shutdown()
	}
	if len(victims) > 0 {
		slog.Info("sshclient: host tunnels closed", "hostId", hostID, "count", len(victims))
	}
	return len(victims)
}

// ReapIdle 回收空闲超 TTL 的隧道（远程模块周期调用），返回回收数
func (m *TunnelManager) ReapIdle() int {
	m.mu.Lock()
	victims := make([]*tunnel, 0, 2)
	for k, t := range m.tunnels {
		if time.Since(time.Unix(0, t.lastUsed.Load())) > m.ttl {
			victims = append(victims, t)
			delete(m.tunnels, k)
		}
	}
	m.mu.Unlock()
	for _, t := range victims {
		t.shutdown()
		slog.Info("sshclient: idle tunnel reaped", "hostId", t.info.HostID,
			"remotePort", t.info.RemotePort, "localPort", t.info.LocalPort)
	}
	return len(victims)
}

// CloseAll 关闭全部隧道（模块停机时调用），返回关闭数
func (m *TunnelManager) CloseAll() int {
	m.mu.Lock()
	victims := make([]*tunnel, 0, len(m.tunnels))
	for k, t := range m.tunnels {
		victims = append(victims, t)
		delete(m.tunnels, k)
	}
	m.mu.Unlock()
	for _, t := range victims {
		t.shutdown()
	}
	return len(victims)
}

// acceptLoop 本地监听循环：每条入站连接起一个 pipe goroutine。
// 监听关闭（显式关闭/回收）即退出——退出是 shutdown 的预期结果，不告警
func (t *tunnel) acceptLoop() {
	for {
		conn, err := t.ln.Accept()
		if err != nil {
			if !t.dead.Load() {
				slog.Warn("sshclient: tunnel listener error", "hostId", t.info.HostID, "err", err)
			}
			return
		}
		t.touch()
		go t.pipe(conn)
	}
}

// pipe 单条本地连接 ↔ direct-tcpip 通道双向搬运。
// SSH 连接失效（主机重启/网络抖动）时就地重拨——隧道对象常驻、底层连接
// 按需重建的轻量「随连接池重建」：重建失败仅断当前本地连接（预览面板呈现
// 为上游不可达），下一条连接再试
func (t *tunnel) pipe(local net.Conn) {
	defer func() { _ = local.Close() }()
	remote, err := t.openRemote()
	if err != nil {
		slog.Warn("sshclient: tunnel forward failed", "hostId", t.info.HostID,
			"remotePort", t.info.RemotePort, "err", err)
		return
	}
	defer func() { _ = remote.Close() }()

	// 正向在本 goroutine 收尾（CloseWrite 半关让远端读完请求），
	// 反向返回即拆除——双端 Close 经 defer 解除对端阻塞
	go func() {
		_, _ = io.Copy(remote, local)
		if cw, ok := remote.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	_, _ = io.Copy(local, remote)
}

// openRemote 经（必要时重拨的）SSH 连接打开到远端回环目标的通道
func (t *tunnel) openRemote() (net.Conn, error) {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(t.info.RemotePort))
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ssh != nil {
		ch, err := t.ssh.Dial("tcp", addr)
		if err == nil {
			return ch, nil
		}
		_ = t.ssh.Close()
		t.ssh = nil
	}
	client, err := t.dial()
	if err != nil {
		return nil, err
	}
	t.ssh = client
	return client.Dial("tcp", addr)
}

func (t *tunnel) touch() { t.lastUsed.Store(time.Now().UnixNano()) }

// snapshot 管理器读用的信息快照（LastActive 由 lastUsed 得出，非可变别名）
func (t *tunnel) snapshot() TunnelInfo {
	info := t.info
	info.LastActive = time.Unix(0, t.lastUsed.Load())
	return info
}

// shutdown 终结监听与底层 SSH 连接（幂等；在途连接随通道关闭自然消亡）
func (t *tunnel) shutdown() {
	if !t.dead.CompareAndSwap(false, true) {
		return
	}
	_ = t.ln.Close()
	t.mu.Lock()
	if t.ssh != nil {
		_ = t.ssh.Close()
		t.ssh = nil
	}
	t.mu.Unlock()
}
