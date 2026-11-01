package remoteterminal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/terminal"
)

// ErrSessionLimit 会话数达到全局上限（API 层用 errors.Is 区分：
// 命中返回 409，拨号/凭据失败返回 502）
var ErrSessionLimit = errors.New("remote terminal session limit reached")

const (
	// DefaultSessionLimit 全局会话数上限（远程 SSH 连接资源占用大，防无界增长）
	DefaultSessionLimit = 20
	// DefaultGCDelay WS 断开后会话保留窗口：60s 内可重连，超期回收
	DefaultGCDelay = 60 * time.Second
)

// Manager 远程终端会话管理器
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	dialer   Dialer
	limit    int
	gcDelay  time.Duration
}

// NewManager 创建管理器（默认 60s 重连窗口）
func NewManager(dialer Dialer, limit int) *Manager {
	return NewManagerWithGC(dialer, limit, DefaultGCDelay)
}

// NewManagerWithGC 创建管理器并自定义 GC 窗口时长（测试注入短窗口用）
func NewManagerWithGC(dialer Dialer, limit int, gcDelay time.Duration) *Manager {
	if limit <= 0 {
		limit = DefaultSessionLimit
	}
	if gcDelay <= 0 {
		gcDelay = DefaultGCDelay
	}
	return &Manager{
		sessions: make(map[string]*Session),
		dialer:   dialer,
		limit:    limit,
		gcDelay:  gcDelay,
	}
}

// newSessionID 生成 crypto/rand 16 字节 hex（32 字符）
// 随机 ID 防 60s 重连窗内被新会话抢占（对比 term-<unixnano> 形式的时钟碰撞风险）
func newSessionID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate session id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// CreateSession 拨号并注册新会话
// 超过全局上限返回 error；拨号失败不注册（不留半开资源）
//
// 持锁拨号与 terminal.Manager.CreateSession 持锁 backend.Create 一致：
// 创建操作本就串行等待，锁内拨号让 limit 检查与注册原子化（防并发创建超限）
func (m *Manager) CreateSession(hostID string, rows, cols uint16, tmuxName string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.sessions) >= m.limit {
		return nil, fmt.Errorf("%w (%d)", ErrSessionLimit, m.limit)
	}

	// crypto/rand ID 碰撞概率可忽略（2^-128），仍做防重检查兜底
	var id string
	for i := 0; i < 3; i++ {
		candidate, err := newSessionID()
		if err != nil {
			return nil, err
		}
		if _, exists := m.sessions[candidate]; !exists {
			id = candidate
			break
		}
	}
	if id == "" {
		return nil, fmt.Errorf("failed to generate unique session id")
	}

	spec := SessionSpec{ID: id, HostID: hostID, Rows: rows, Cols: cols, TmuxName: tmuxName}
	conn, err := m.dialer.DialPTY(spec)
	if err != nil {
		slog.Error("remoteterminal: dial failed", "hostId", hostID, "err", err)
		return nil, fmt.Errorf("dial remote host: %w", err)
	}

	s := &Session{
		ID:        id,
		HostID:    hostID,
		Rows:      rows,
		Cols:      cols,
		CreatedAt: time.Now(),

		conn:    conn,
		sb:      terminal.NewScrollback(),
		gcDelay: m.gcDelay,
	}
	// 自移除回调需在 s 赋值后挂载（闭包引用 s 自身，字面量内不可见）
	s.onExit = func() { m.removeSession(s) }
	m.sessions[id] = s

	go s.readLoop()

	slog.Info("remoteterminal: session created", "id", id, "hostId", hostID,
		"sessions", len(m.sessions))
	return s, nil
}

// GetSession 按 ID 查找会话
func (m *Manager) GetSession(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

// ListSessions 列出全部会话
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		result = append(result, s)
	}
	return result
}

// KillSession 关闭并移除单个会话（用户主动关闭 tab / DELETE API）
func (m *Manager) KillSession(id string) {
	m.mu.RLock()
	s := m.sessions[id]
	m.mu.RUnlock()
	if s != nil {
		s.Kill() // Kill 内部经 onExit → removeSession 自移除
	}
}

// KillHostSessions 级联关闭某远程主机的全部会话（主机删除/凭据变更时调用）
// 会话上限 20，遍历过滤足够（无需维护 hostID → sessionIDs 反向索引）
// 返回关闭的会话数
func (m *Manager) KillHostSessions(hostID string) int {
	m.mu.RLock()
	targets := make([]*Session, 0)
	for _, s := range m.sessions {
		if s.HostID == hostID {
			targets = append(targets, s)
		}
	}
	m.mu.RUnlock()

	for _, s := range targets {
		s.Kill()
	}
	return len(targets)
}

// BroadcastWrite 把同一段输入写入多个远程会话（P-20261005-11 舰队广播的远程
// 半边）：与 terminal.Manager.BroadcastWrite 同构的逐会话语义——id 去重防
// 重复执行、单会话失败不中断整批（舰队语义，个别掉队不拖累其余）、
// missing/failed 逐类回告。结果类型复用 terminal.BroadcastResult（两端回告
// 契约同形，API 层合并后统一整形）。
// 远程写入路径是服务端中继（WS 输入经 WriteInput 直写 SSH stdin），广播与
// 单会话输入同一条通道，无新协议面。断连会话（closed/conn 置 nil）WriteInput
// 返回错误计 failed，不阻塞其余目标——GC 窗口内的会话在 60s 重连窗内仍可写。
// 量级：会话上限 DefaultSessionLimit=20，每次写入是一次进 SSH channel 的内存
// 写，整体 O(ids×len(data))，无热点
func (m *Manager) BroadcastWrite(ids []string, data []byte) terminal.BroadcastResult {
	res := terminal.BroadcastResult{Missing: []string{}, Failed: []string{}}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		s := m.GetSession(id)
		if s == nil {
			res.Missing = append(res.Missing, id)
			continue
		}
		if err := s.WriteInput(data); err != nil {
			res.Failed = append(res.Failed, id)
			continue
		}
		res.Written++
	}
	return res
}

// removeSession 会话终结回调（Session.onExit）目标：从 map 自移除
// 指针比对防止误删同 ID 的新会话（极端 ID 重放场景）
func (m *Manager) removeSession(s *Session) {
	m.mu.Lock()
	if cur, ok := m.sessions[s.ID]; ok && cur == s {
		delete(m.sessions, s.ID)
	}
	count := len(m.sessions)
	m.mu.Unlock()
	slog.Info("remoteterminal: session removed", "id", s.ID, "hostId", s.HostID,
		"sessions", count)
}

// 包级单例：由 remoteterminal 模块 Init 装配、Stop 卸载（roadmap M2.1：
// 原 SetManager setter 已消除）。未装配时 GetManager 返回 nil，调用方判空
var (
	managerMu  sync.RWMutex
	defaultMgr *Manager
)

// GetManager 获取包级单例；未装配时返回 nil
func GetManager() *Manager {
	managerMu.RLock()
	defer managerMu.RUnlock()
	return defaultMgr
}
