package remoteterminal

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/terminal"
)

// Session 远程主机的 SSH PTY 会话
// 与项目终端 terminal.Session 同构但精简：无 backend 分层（仅 SSH）、无 tmux 持久化——
// 断线重连窗口由 GC timer 实现（WS 断开保留 gcDelay，超期未重连则 Kill）
//
// 输出分发对齐 terminal 包语义：readLoop 同步调用 OnOutput 回调（阻塞反背压），
// WS 慢时 handler 阻塞 → readLoop 阻塞 → SSH channel 缓冲满 → 远端 shell stdout
// 自然反压，避免大流量下丢字节导致 xterm 显示错乱（WS 侧重连时从 scrollback 补齐）
type Session struct {
	ID        string    `json:"id"`
	HostID    string    `json:"hostId"`
	Rows      uint16    `json:"rows"`
	Cols      uint16    `json:"cols"`
	CreatedAt time.Time `json:"createdAt"`

	mu   sync.Mutex
	conn PTYConn
	// scrollback 复用 terminal 包的环形缓冲（导出共享，不复制代码）
	sb *terminal.ScrollbackBuffer
	// onOutput / nextHandlerID 输出回调注册（map + 自增 id，对齐 terminal.Session 模式）
	onOutput      map[int64]func(data []byte)
	nextHandlerID int64

	// connHeld 单连接 CAS 占位标志：同一会话同一时刻仅允许一个 WS 挂载
	//（在 WS Upgrade 前由 handler 调 TryAcquireConn 抢占，防两个标签页双写）
	connHeld bool
	// gcTimer WS 断开后的重连窗口计时器，到期未重连则 Kill
	gcTimer *time.Timer
	// gcDelay 重连窗口时长（由 Manager 创建时注入，测试可缩短）
	gcDelay time.Duration
	// lastRows / lastCols 上次成功同步给远端的尺寸，Resize 去重用
	lastRows uint16
	lastCols uint16
	closed   bool
	// onExit 会话终结回调（Manager 注入，用于从 sessions map 自移除）
	onExit func()
	// exitHooks API 层注册的终结钩子（如远端 tmux 孤儿会话清理），
	// Kill 任意路径触发一次（语义对齐 terminal.Session.OnOutput 的 map+自增 id 模式）
	exitHooks  map[int64]func()
	nextHookID int64
}

// TryAcquireConn 尝试占用会话的唯一连接位（WS Upgrade 前调用）
// 返回 false 表示会话已被其他连接占用或已关闭
// 占用成功同时停掉 GC 计时器（GC 窗口内重连，会话复活）
func (s *Session) TryAcquireConn() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.connHeld {
		return false
	}
	s.connHeld = true
	if s.gcTimer != nil {
		s.gcTimer.Stop()
		s.gcTimer = nil
	}
	return true
}

// ReleaseConn 归还连接位（WS 断开时调用）
// 不立即杀会话：启动 GC 计时器，gcDelay 内重连（TryAcquireConn）则取消，超期 Kill
// 幂等：重复调用（连接位已归还）直接忽略，GC 窗口从首次断开起算
func (s *Session) ReleaseConn() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.connHeld {
		return
	}
	s.connHeld = false
	delay := s.gcDelay
	if delay <= 0 {
		delay = DefaultGCDelay
	}
	s.gcTimer = time.AfterFunc(delay, func() {
		// 持锁二次检查：与 TryAcquireConn 在同一把锁上串行化，
		// 消除 "timer 已触发但重连恰好成功" 的竞态窗口
		s.mu.Lock()
		if s.closed || s.connHeld {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		slog.Info("remoteterminal: session expired after reconnect window",
			"id", s.ID, "hostId", s.HostID)
		s.Kill()
	})
}

// OnOutput 注册输出回调，返回反注册函数
// WS handler（Task 6）在回调内同步写 WS channel；断开时必须调用反注册避免泄漏
func (s *Session) OnOutput(handler func(data []byte)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.onOutput == nil {
		s.onOutput = make(map[int64]func(data []byte))
	}
	id := s.nextHandlerID
	s.nextHandlerID++
	s.onOutput[id] = handler
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.onOutput, id)
	}
}

// readLoop 持续读取远端 PTY 输出：scrollback 缓存 + 同步分发回调
// Read 返回 error（SSH 断开 / Kill 唤醒）时终结会话并从 Manager 自移除
func (s *Session) readLoop() {
	// 读缓冲 32KB（P-20261004-26）：与 terminal 包 readLoop 同款——远端 SSH
	// channel 每次读一个系统调用，大缓冲砍高频次；SSH channel 就绪即返不凑满，
	// 交互延迟不受影响（下游 scrollback 环按字节覆盖，块大小无假设）
	buf := make([]byte, 32768)
	for {
		s.mu.Lock()
		conn := s.conn
		s.mu.Unlock()
		if conn == nil {
			return
		}

		n, err := conn.Read(buf)
		if err != nil {
			slog.Debug("remoteterminal: pty read ended", "id", s.ID, "err", err)
			s.Kill()
			return
		}
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			if s.sb != nil {
				s.sb.Write(data)
			}

			// 持锁快照回调列表，锁外逐个同步调用（阻塞反背压语义见类型注释）
			s.mu.Lock()
			handlers := make([]func([]byte), 0, len(s.onOutput))
			for _, h := range s.onOutput {
				handlers = append(handlers, h)
			}
			s.mu.Unlock()
			for _, h := range handlers {
				h(data)
			}
		}
	}
}

// WriteInput 键盘输入写入远端 PTY
func (s *Session) WriteInput(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("session closed")
	}
	if s.conn == nil {
		return fmt.Errorf("session not connected")
	}
	_, err := s.conn.Write(data)
	return err
}

// Resize 调整远端 PTY 尺寸
// 相同尺寸的重复 resize 直接跳过：冗余 resize 会触发远端 shell 重绘 banner，
// 与项目终端 terminal.Session.Resize 的去重语义一致
func (s *Session) Resize(rows, cols uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("session closed")
	}
	if s.conn == nil {
		return nil
	}
	if s.lastRows == rows && s.lastCols == cols {
		return nil
	}
	s.lastRows = rows
	s.lastCols = cols
	return s.conn.Resize(rows, cols)
}

// ScrollbackBytes 返回缓存的远端输出历史（WS 重连时重放，maxLines=0 返回全部）
func (s *Session) ScrollbackBytes() []byte {
	s.mu.Lock()
	sb := s.sb
	s.mu.Unlock()
	if sb == nil {
		return nil
	}
	return sb.Snapshot(0)
}

// EarliestTime 现存缓冲最早字节的写入时刻估计（P-20261005-233 断档检测）：
// 远端输出经本机中转落环形缓冲，时间戳即本机时钟（无跨机时钟差问题），
// 与本地终端同一检测原语。nil 缓冲返回 false=完整性未知
func (s *Session) EarliestTime() (time.Time, bool) {
	s.mu.Lock()
	sb := s.sb
	s.mu.Unlock()
	if sb == nil {
		return time.Time{}, false
	}
	return sb.EarliestTime()
}

// OnExit 注册会话终结钩子：Kill（GC 超期 / SSH 断开 / 用户关闭 / 主机级联关闭）
// 任意路径终结时触发且仅触发一次。返回反注册函数（会话生命周期内不反注册也安全——
// Kill 会清空全部钩子）。回调在 Kill 内锁外调用，实现须快速返回，
// 阻塞任务（如异步 SSH 拨号清理）请自行 go 出去。
func (s *Session) OnExit(hook func()) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exitHooks == nil {
		s.exitHooks = make(map[int64]func())
	}
	id := s.nextHookID
	s.nextHookID++
	s.exitHooks[id] = hook
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.exitHooks, id)
	}
}

// IsClosed 只读快照：会话是否已终结（供 API 层注册 OnExit 钩子后补查——
// 注册动作可能晚于会话终结：CreateSession 返回时 readLoop 已在跑）
func (s *Session) IsClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Kill 彻底终结会话：关闭远端连接、停 GC 计时器、触发 Manager 自移除
// 幂等：重复调用（GC 到期 / SSH 断开 / 用户关闭三方竞态）只生效一次
//
// 主动关闭前清空 onOutput：避免残留 handler 继续向已废弃的 WS channel 写数据
func (s *Session) Kill() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	clear(s.onOutput)
	// 终结钩子快照 + 清空：保证只触发一次，锁外调用避免回调死锁
	hooks := make([]func(), 0, len(s.exitHooks))
	for _, h := range s.exitHooks {
		hooks = append(hooks, h)
	}
	clear(s.exitHooks)
	conn := s.conn
	// conn 置 nil 让 readLoop 下一轮退出（SetReadDeadline 不生效的实现靠此兜底）
	s.conn = nil
	if s.gcTimer != nil {
		s.gcTimer.Stop()
		s.gcTimer = nil
	}
	onExit := s.onExit
	s.mu.Unlock()

	if conn != nil {
		// 先 deadline 后 close：尽力唤醒阻塞在 Read 上的 readLoop
		_ = conn.SetReadDeadline(time.Now())
		_ = conn.Close()
	}
	for _, h := range hooks {
		h()
	}
	if onExit != nil {
		onExit()
	}
}
