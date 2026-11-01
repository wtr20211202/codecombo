package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// per-host SSH 连接池（P-20261005-159）：remote 域短操作（文件浏览/编辑读写/
// 诊断/exec/git 对照）此前每请求付全套 TCP+SSH 握手+密钥交换（LAN 数百 ms、
// WAN 秒级 × 高频交互）。sshclient.Client 单连接天然支持多次 exec/sftp
// （client.go 自述），此前只有隧道键复用，本池兑现之。
//
// 形态：hostID → 一条共享连接（SSH 单连接多路复用，并发短操作各开通道并行）；
// 5 分钟空闲 TTL 关闭；per-host 并发借出上限（超出短排队，不无限排队拖死
// 请求）；复用前按空闲时长 keepalive 探活（半开检测）+ 操作首错弃置重建
// 一次（WithLease，WAN 网络抖动自愈）；凭据/指纹/主机配置变更由 api 层
// FlushHost 丢弃旧连接（旧连接即时失效语义）。
//
// 分界（有意不池化）：远程终端 PTY 与 SSH 隧道持独占长连接（terminal 四处
// Dialer 与 tunnel.go 生命周期自管），池只服务短操作。
//
// TOFU 语义注记：主机指纹校验发生在 Dial 内——池化连接存活期跳过重复校验
// 即「同一信任连接」的正确语义；指纹重置/主机配置变更由 api 层 FlushHost
// 触发重建再校验（与 hostkey 重置入口的重新 TOFU 语义闭环）。

const (
	// DefaultPoolTTL 空闲回收窗口：最后一次使用静默该时长即关底层连接
	DefaultPoolTTL = 5 * time.Minute
	// DefaultPoolPerHostLimit 单主机并发借出上限（同连接多通道并行；防单主机
	// 操作风暴把连接打成瓶颈或触发服务端 MaxSessions）
	DefaultPoolPerHostLimit = 4
	// DefaultPoolQueueWait 借出排队上限：并发满时短等再失败（不无限排队拖死请求）
	DefaultPoolQueueWait = 10 * time.Second
	// poolProbeTimeout 探活应答上限（WAN RTT 富余；超时按半开弃置重建）
	poolProbeTimeout = 5 * time.Second
)

// poolProbeAfter 复用前探活的空闲阈值：静默超过该时长才发 keepalive 探测
// （热路径连击免一跳 RTT；刚用过的连接视为存活——真死了由首错重建兜底）。
// var 仅为测试可收缩窗口
var poolProbeAfter = 30 * time.Second

// ErrPoolBusy 单主机并发借出满且排队超时
var ErrPoolBusy = errors.New("ssh conn pool busy")

// ClientPool hostID 维度的共享 SSH 连接池
type ClientPool struct {
	mu        sync.Mutex
	hosts     map[string]*pooledHost
	ttl       time.Duration
	limit     int
	queueWait time.Duration
	// dial 拨号实现（生产恒 Dial；同包测试指向进程内 fake server）
	dial func(ConnectOptions) (*Client, error)

	dials  atomic.Int64 // 连接建立计数（含重建）
	reuses atomic.Int64 // 复用计数（复用率 = reuses/(dials+reuses)，随 debug 日志观测）
}

// pooledHost 单主机的共享连接与借出状态（自有锁：跨主机操作互不阻塞）。
// 条目常驻不删（map 尺寸以历史出现过的主机数为上界，量级=主机清单），
// 惰性建、FlushHost 只清连接不清条目
type pooledHost struct {
	mu       sync.Mutex
	client   *Client
	lastUsed time.Time
	inflight int
	slots    chan struct{}
}

// NewClientPool 创建连接池（limit/ttl/queueWait 非正时取默认值）
func NewClientPool(limit int, ttl time.Duration) *ClientPool {
	if limit <= 0 {
		limit = DefaultPoolPerHostLimit
	}
	if ttl <= 0 {
		ttl = DefaultPoolTTL
	}
	return &ClientPool{
		hosts:     make(map[string]*pooledHost),
		ttl:       ttl,
		limit:     limit,
		queueWait: DefaultPoolQueueWait,
		dial:      Dial,
	}
}

// Get 借出主机的共享连接：并发满则短排队；命中既有连接先按空闲时长探活
// （半开即弃置重建）。用完必须 End（建议 defer），连接级失败先 MarkDead。
// 返回的连接与同主机其他在借请求共享（SSH 多路复用）：调用方不得 Close
func (p *ClientPool) Get(hostID string, opts ConnectOptions) (*PoolLease, error) {
	h := p.host(hostID)
	timer := time.NewTimer(p.queueWait)
	defer timer.Stop()
	select {
	case h.slots <- struct{}{}:
	case <-timer.C:
		return nil, fmt.Errorf("%w: host %s checkout limit %d (waited %s)", ErrPoolBusy, hostID, p.limit, p.queueWait)
	}
	client, reused, err := p.acquire(h, hostID, opts)
	if err != nil {
		<-h.slots // 拨号失败不占槽
		return nil, err
	}
	// ⑥ 连接建立/复用计数入 debug 日志（复用率可观测：reuses/(dials+reuses)）
	slog.Debug("sshclient: pool lease", "hostId", hostID, "reused", reused,
		"dials", p.dials.Load(), "reuses", p.reuses.Load())
	return &PoolLease{p: p, h: h, id: hostID, client: client}, nil
}

// host 取（或惰性建）主机槽位
func (p *ClientPool) host(hostID string) *pooledHost {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.hosts[hostID]
	if h == nil {
		h = &pooledHost{slots: make(chan struct{}, p.limit)}
		p.hosts[hostID] = h
	}
	return h
}

// acquire 取连接或拨新（持主机锁：同主机的探活/拨号串行，防并发双拨）。
// 返回 reused 供日志区分复用/新建
func (p *ClientPool) acquire(h *pooledHost, hostID string, opts ConnectOptions) (*Client, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.inflight++
	if h.client != nil {
		idle := time.Since(h.lastUsed)
		switch {
		case p.ttl > 0 && idle > p.ttl:
			p.dropHostClient(h, hostID, "idle expired") // 懒过期（reap 循环兜底）
		case idle <= poolProbeAfter || p.probe(h.client):
			h.lastUsed = time.Now()
			p.reuses.Add(1)
			return h.client, true, nil
		default:
			p.dropHostClient(h, hostID, "half-open probe failed") // 半开：弃置重建
		}
	}
	client, err := p.dial(opts)
	if err != nil {
		h.inflight--
		return nil, false, err
	}
	p.dials.Add(1)
	h.client = client
	h.lastUsed = time.Now()
	return client, false, nil
}

// probe keepalive 探活：连接级半开（对端重启/断网/NAT 静默超时）的最小判据。
// wantReply 的往返成功即活性证明；超时按半开处理（迟到的应答随连接关闭自然
// 消亡，goroutine 不悬挂引用）
func (p *ClientPool) probe(c *Client) bool {
	done := make(chan error, 1)
	go func() {
		_, _, err := c.UnderlyingClient().SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(poolProbeTimeout):
		return false
	}
}

// dropHostClient 弃置主机当前连接（置空即让位给重建；Close 的迟到错误无意义）
func (p *ClientPool) dropHostClient(h *pooledHost, hostID, why string) {
	if h.client != nil {
		_ = h.client.Close()
		h.client = nil
		slog.Debug("sshclient: pool conn dropped", "hostId", hostID, "why", why)
	}
}

// PoolLease 一次借出：短操作期间持有共享连接的使用权与并发槽
type PoolLease struct {
	p      *ClientPool
	h      *pooledHost
	id     string
	client *Client
	dead   bool
	ended  bool
}

// Client 借出的共享连接。不得 Close——归还由 End 负责
func (l *PoolLease) Client() *Client { return l.client }

// MarkDead 声明连接级失败：End 时弃置不回池（下次 Get 重建）
func (l *PoolLease) MarkDead() { l.dead = true }

// End 归还：释放并发槽并把连接留在池内（touch 活跃时间）。dead 或已被替换
// /flush 的连接就地关闭。幂等
func (l *PoolLease) End() {
	if l.ended {
		return
	}
	l.ended = true
	l.h.mu.Lock()
	l.h.inflight--
	l.h.lastUsed = time.Now()
	current := l.h.client
	switch {
	case current == l.client && !l.dead:
		l.h.mu.Unlock() // 健康归还：连接留池
	case current == l.client:
		l.h.client = nil
		l.h.mu.Unlock()
		_ = l.client.Close() // MarkDead：弃置
	default:
		l.h.mu.Unlock()
		_ = l.client.Close() // 已被替换/flush：租约手里的旧连接就地关
	}
	<-l.h.slots // 释放借出时占用的并发槽（Get 的排队准入配对）
}

// WithLease 借出执行 fn 并归还；连接级首错弃置重建一次重试（半开自愈——
// 半开连接的首个操作必败，重建后重试即恢复）。fn 需可安全重跑：remote 域
// 短操作均为只读探测或幂等写原语（连接级失败时远端命令多半未启动，重放面
// 有界）。业务失败（非零退出/SFTP 状态错误）不触发重建
func (p *ClientPool) WithLease(hostID string, opts ConnectOptions, fn func(*Client) error) error {
	err := p.withLeaseOnce(hostID, opts, fn)
	if err == nil || !IsConnLevelError(err) {
		return err
	}
	return p.withLeaseOnce(hostID, opts, fn)
}

func (p *ClientPool) withLeaseOnce(hostID string, opts ConnectOptions, fn func(*Client) error) error {
	l, err := p.Get(hostID, opts)
	if err != nil {
		return err
	}
	opErr := fn(l.Client())
	if opErr != nil && IsConnLevelError(opErr) {
		l.MarkDead()
	}
	l.End()
	return opErr
}

// FlushHost 丢弃指定主机的池内连接（凭据/指纹/主机配置变更语义：旧连接即时
// 失效，下次借出按最新配置重新拨号+校验）。返回关闭的连接数（0=池内无此主机
// 连接）。在借租约不受影响——其 End 走「已被替换」分支就地关闭
func (p *ClientPool) FlushHost(hostID string) int {
	p.mu.Lock()
	h := p.hosts[hostID]
	p.mu.Unlock()
	if h == nil {
		return 0
	}
	h.mu.Lock()
	client := h.client
	h.client = nil
	h.mu.Unlock()
	if client != nil {
		_ = client.Close()
		slog.Info("sshclient: pool host flushed", "hostId", hostID)
		return 1
	}
	return 0
}

// ReapIdle 回收空闲超 TTL 且无在借的连接（远程模块周期调用），返回关闭数。
// 在借（inflight>0）的连接不动——长流式操作（大文件下载/zip）借出期内不受
// TTL 影响
func (p *ClientPool) ReapIdle() int {
	p.mu.Lock()
	victims := make([]*pooledHost, 0, len(p.hosts))
	for _, h := range p.hosts {
		h.mu.Lock()
		if h.client != nil && h.inflight == 0 && time.Since(h.lastUsed) > p.ttl {
			victims = append(victims, h)
		}
		h.mu.Unlock()
	}
	p.mu.Unlock()
	closed := 0
	for _, h := range victims {
		h.mu.Lock()
		// 双检：快照后被借出则跳过（本轮 reap 已持锁窗口外，可能交错）
		if h.client != nil && h.inflight == 0 {
			_ = h.client.Close()
			h.client = nil
			closed++
		}
		h.mu.Unlock()
	}
	if closed > 0 {
		slog.Debug("sshclient: idle pool conns reaped", "count", closed)
	}
	return closed
}

// CloseAll 关闭全部池内连接（模块停机），返回关闭数。在借租约的 End 走
// 「已被替换」分支，不悬挂
func (p *ClientPool) CloseAll() int {
	p.mu.Lock()
	hosts := make([]*pooledHost, 0, len(p.hosts))
	for _, h := range p.hosts {
		hosts = append(hosts, h)
	}
	p.mu.Unlock()
	closed := 0
	for _, h := range hosts {
		h.mu.Lock()
		if h.client != nil {
			_ = h.client.Close()
			h.client = nil
			closed++
		}
		h.mu.Unlock()
	}
	return closed
}

// Stats 观测计数（dials=建立含重建，reuses=复用）：debug 日志与运维自检用
func (p *ClientPool) Stats() (dials, reuses int64) {
	return p.dials.Load(), p.reuses.Load()
}

// IsConnLevelError 连接/传输层失败判定（区别于远端命令退出码与 SFTP 状态
// 错误这类业务失败）：池的首错重建只对连接级错误生效——文件不存在、权限
// 拒绝、非零退出不该弃置连接
func IsConnLevelError(err error) bool {
	if err == nil {
		return false
	}
	// 调用方主动超时/取消必须最先排除：context.DeadlineExceeded 实现了
	// net.Error 接口，落到下方 errors.As 会被误判为网络错误
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	// x/crypto/ssh 与 pkg/sftp 在连接死亡后的典型错误文本（EOF 族已上行覆盖，
	// 这里兜底层库各路径的包装文本；"connection lost" 为 pkg/sftp 对死亡
	// 传输的规范报错——实测 fake server 断连场景的原始形态）
	// "unexpected packet in response to channel open"：半开连接上 OpenChannel
	// 的写成功进内核缓冲、confirm 读到 EOF，x/crypto/ssh 的 incoming 关闭使
	// 报文解出 <nil>（pool_test 半开重建实测形态）——首错重建必须认得它，
	// 否则半开自愈在「FIN 晚于首写」的时序下失效
	msg := err.Error()
	for _, marker := range []string{
		"connection reset", "broken pipe", "connection refused", "connection lost",
		"ssh: disconnect", "mux: ", "failed to send packet",
		"use of closed network connection",
		"unexpected packet in response to channel open",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}
