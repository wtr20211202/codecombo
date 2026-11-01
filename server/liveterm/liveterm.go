// Package liveterm 终端只读直播馈线（P-20261003-306）：把终端会话的 PTY 输出
// 经每 token 一枚流式遮蔽器（mask.Masker，P-108 模式集）灌进有界尾流缓冲，
// 供分享子服务向访客 SSE 只读推流。
//
// 严格只读契约：对会话只挂 OnOutput 输出 tap（recording 同款挂点），绝不触碰
// WriteInput/Resize——访客侧不存在任何输入通道。生命周期：
//
//	分享创建      → Wire(token, sessionID)（tap 即刻接上，尾流从创建时刻累积）
//	访客订阅      → Subscribe（先收尾流快照再接实时；单 token 并发访客 ≤ MaxGuests）
//	会话关闭/撤销  → reconcile（terminal.AddOnChange 对账）/ Unwire → 馈线终结
//
// 锁纪律：hub.mu 只护 feeds map；feed.mu 护遮蔽器状态 + 尾流 + 订阅表，tap 回调
// （readLoop 单 goroutine）与订阅/终结路径竞争——与 recording.Manager 同款两级锁。
package liveterm

import (
	"errors"
	"sync"

	"codecombo/server/mask"
	"codecombo/server/terminal"
)

// MaxGuestsPerToken 单 token 并发访客上限（带宽护栏）：超出直接拒绝订阅，
// 前端呈现「访客已达上限」。个位数是远程结对/教学的真实量级，防把子服务
// 当公开直播平台放大出口带宽
const MaxGuestsPerToken = 5

// maxTailBytes 尾流缓冲上限（字节）：快照只是「接上直播前的最近画面」，够
// 铺满数屏即可（服务端 CaptureScrollback 播种同样裁到此限）；有界是内存红线
const maxTailBytes = 128 << 10

// seedScrollbackLines 订阅播种时回看的 scrollback 行数（与跨会话输出检索
// 同一档位）：遮蔽器按序处理播种+实时流，行数只影响首屏铺多少历史
const seedScrollbackLines = 2000

// ErrTooManyGuests 单 token 并发访客超限（SSE 端点据此回 429）
var ErrTooManyGuests = errors.New("liveterm: too many guests for this share")

// LiveSession 可直播会话能力抽象（*terminal.Session 结构性满足）；测试以桩注入
type LiveSession interface {
	// OnOutput 注册输出 tap，返回注销函数（严格只读源）
	OnOutput(handler func(data []byte)) (unregister func())
	// CaptureScrollback 回看历史（订阅播种；tmux capture-pane / native 环形缓冲）
	CaptureScrollback(maxLines int) ([]byte, error)
	// Size 会话当前终端尺寸（SSE hello 帧供访客页初始化 xterm 网格）
	Size() (cols, rows uint16)
}

// 会话解析：默认走 terminal.DefaultManager（recording 同款先例）；测试经
// SetSessionLookup 注入桩
var (
	lookupMu      sync.Mutex
	sessionLookup = func(id string) LiveSession {
		return terminal.DefaultManager.GetSession(id)
	}
)

// SetSessionLookup 覆盖会话解析（测试注入；nil 恢复默认）
func SetSessionLookup(fn func(id string) LiveSession) {
	lookupMu.Lock()
	defer lookupMu.Unlock()
	if fn == nil {
		sessionLookup = func(id string) LiveSession {
			return terminal.DefaultManager.GetSession(id)
		}
		return
	}
	sessionLookup = fn
}

func lookupSession(id string) LiveSession {
	lookupMu.Lock()
	fn := sessionLookup
	lookupMu.Unlock()
	return fn(id)
}

// Subscription 一路访客订阅：尾流快照 + 实时通道 + 终结信号。
// 实时通道里是遮蔽后字节（同一 slice 广播给全部订阅者，只读约定——消费方
// 不得改写）；通道满 = 消费方过慢，直接关闭该路订阅（EventSource 自动重连
// 后重收尾流快照，天然对账），绝不阻塞 readLoop 热路径
type Subscription interface {
	// Tail 订阅点之前的遮蔽尾流快照（独立拷贝）
	Tail() []byte
	// Live 订阅点之后的实时遮蔽字节（馈线终结后通道保持开启，以 Done 为准）
	Live() <-chan []byte
	// Done 馈线终结信号（会话关闭/撤销/上限踢出）
	Done() <-chan struct{}
	// Ended 订阅瞬间馈线是否已终结（会话已不在——访客页据此直接呈现「已结束」）
	Ended() bool
	// Size 终端尺寸（馈线已终结时返回 0 值，访客页回落默认 80×24）
	Size() (cols, rows uint16)
	// Release 释放本路订阅（并发访客计数 -1）；SSE handler 退出必须调用
	Release()
}

// subscription Subscription 的馈线侧实现（字段在 Subscribe 时定格）
type subscription struct {
	tail  []byte
	live  <-chan []byte
	done  <-chan struct{}
	ended bool
	size  func() (uint16, uint16)
	rele  func()
}

func (s *subscription) Tail() []byte           { return s.tail }
func (s *subscription) Live() <-chan []byte    { return s.live }
func (s *subscription) Done() <-chan struct{}  { return s.done }
func (s *subscription) Ended() bool            { return s.ended }
func (s *subscription) Size() (uint16, uint16) { return s.size() }
func (s *subscription) Release()               { s.rele() }

// sub 内部订阅条目。done 的关闭三路并发（终结/踢出/释放），sync.Once 收口
// 防 double-close panic
type sub struct {
	ch       chan []byte
	done     chan struct{}
	closeSub sync.Once
}

func (s *sub) finish() { s.closeSub.Do(func() { close(s.done) }) }

// feed 单 token 的直播馈线：tap → Masker → 尾流 + 订阅扇出。
// 广播不做优化（每连接独立缓冲 MVP）：逐订阅者非阻塞投递
type feed struct {
	mu        sync.Mutex
	sessionID string
	mask      *mask.Masker
	tail      []byte
	subs      map[*sub]struct{}
	cancel    func() // tap 注销（终结路径调用）
	ended     bool
	cols      uint16
	rows      uint16
}

// end 馈线终结：放行遮蔽器滞留字节、断开全部订阅者、注销 tap。幂等
// （reconcile / Unwire / 会话退出多路竞争同一收尾，recording.stop 同款）
func (f *feed) end() {
	f.mu.Lock()
	if f.ended {
		f.mu.Unlock()
		return
	}
	f.ended = true
	tail := f.mask.Flush() // 值态滞留补出 ***，扫描态滞留原样放行
	f.appendTail(tail)
	subs := make([]*sub, 0, len(f.subs))
	for s := range f.subs {
		subs = append(subs, s)
	}
	f.subs = make(map[*sub]struct{})
	cancel := f.cancel
	f.cancel = nil
	f.mu.Unlock()

	if len(tail) > 0 {
		for _, s := range subs {
			f.deliver(s, tail)
		}
	}
	for _, s := range subs {
		s.finish() // 通道不关（避免发送方 panic），以 done 信号终结
	}
	if cancel != nil {
		cancel()
	}
}

// appendTail 有界尾流：超限截头保尾（拷贝收缩，防引用大数组驻留）
func (f *feed) appendTail(b []byte) {
	if len(b) == 0 {
		return
	}
	f.tail = append(f.tail, b...)
	if len(f.tail) > maxTailBytes {
		f.tail = append([]byte(nil), f.tail[len(f.tail)-maxTailBytes:]...)
	}
}

// deliver 非阻塞投递；满即踢（finish 关闭 done，SSE handler 退出释放计数）
func (f *feed) deliver(s *sub, data []byte) {
	select {
	case s.ch <- data:
	case <-s.done: // 已被踢/已断开
	default:
		s.finish() // 慢消费者：踢出（重连后尾流快照对账）
	}
}

// onOutput tap 热路径：遮蔽 → 尾流 → 扇出（readLoop 单 goroutine 调用，
// 与 recording.activeRec.onOutput 同款纪律）
func (f *feed) onOutput(data []byte) {
	masked := f.mask.Write(data)
	if len(masked) == 0 {
		return
	}
	f.mu.Lock()
	if f.ended {
		f.mu.Unlock()
		return
	}
	f.appendTail(masked)
	subs := make([]*sub, 0, len(f.subs))
	for s := range f.subs {
		subs = append(subs, s)
	}
	f.mu.Unlock()
	for _, s := range subs {
		f.deliver(s, masked)
	}
}

// Hub 按 token 管理直播馈线。零值不可用，经 NewHub 构造（构造时挂会话集合
// 对账回调，Stop 时摘除）
type Hub struct {
	mu        sync.Mutex
	feeds     map[string]*feed
	onChangeC func()
}

// NewHub 构造并挂上 terminal.AddOnChange 对账（会话被 Kill 时 onOutput
// handlers 已被清空，tap 静默失效——靠集合变更对账终结馈线，recording
// sessionChanged 同款兜底）
func NewHub() *Hub {
	h := &Hub{feeds: make(map[string]*feed)}
	h.onChangeC = terminal.AddOnChange(h.reconcile)
	return h
}

// reconcile 会话集合变更对账：会话已不在的馈线立即终结
func (h *Hub) reconcile() {
	h.mu.Lock()
	var orphans []*feed
	for _, f := range h.feeds {
		if lookupSession(f.sessionID) == nil {
			orphans = append(orphans, f)
		}
	}
	h.mu.Unlock()
	for _, f := range orphans {
		f.end()
	}
}

// Wire 为 token 接通直播馈线（分享创建路径调用；幂等——已存在即原样返回）。
// 会话已不存在时不报错：建一条立即终结的空馈线，访客订阅到「已结束」——
// 分享记录仍有效（可撤销/轮换），只是直播源没了
func (h *Hub) Wire(token, sessionID string) {
	sess := lookupSession(sessionID)
	// feed 全部字段在入 map（对其他 goroutine 可见）前定格：cols/rows 在
	// 构造期取定，tap 注册后的注销检查走 f.mu——构造后不再有锁外写
	var cols, rows uint16
	if sess != nil {
		cols, rows = sess.Size()
	}
	h.mu.Lock()
	if _, ok := h.feeds[token]; ok {
		h.mu.Unlock()
		return
	}
	f := &feed{
		sessionID: sessionID,
		mask:      mask.NewMasker(),
		subs:      make(map[*sub]struct{}),
		cols:      cols,
		rows:      rows,
	}
	h.feeds[token] = f
	h.mu.Unlock()

	if sess == nil {
		f.end()
		return
	}
	// tap 注册在播种之后：播种（遮蔽化的 scrollback 回看）先进尾流，实时
	// 字节自注册起接续——种子在前、直播在后，时序与终端真实输出一致。
	// 注册与播种之间的极窄窗口丢字节属可接受 MVP 误差（重连重播种自愈）
	if sb, err := sess.CaptureScrollback(seedScrollbackLines); err == nil && len(sb) > 0 {
		f.mu.Lock()
		f.appendTail(f.mask.Write(sb))
		f.mu.Unlock()
	}
	cancel := sess.OnOutput(f.onOutput)
	// 播种期间馈线可能已被终结（会话刚好退出的窄窗口）：tap 注销回收，
	// 不留永不触发的注册
	f.mu.Lock()
	if f.ended {
		f.mu.Unlock()
		cancel()
		return
	}
	f.cancel = cancel
	f.mu.Unlock()
}

// Unwire 撤销 token 的馈线并从表中摘除（管理面撤销/轮换旧 token 路径）
func (h *Hub) Unwire(token string) {
	h.mu.Lock()
	f := h.feeds[token]
	delete(h.feeds, token)
	h.mu.Unlock()
	if f != nil {
		f.end()
	}
}

// Subscribe 为访客开一路只读订阅：先记订阅点（快照覆盖此前、实时通道覆盖
// 此后，同一把锁内无重叠无缝隙），再发尾流快照。单 token 并发访客超上限
// 返回 ErrTooManyGuests。馈线不存在时惰性 Wire（轮换新 token 首访 / 服务
// 重启后的存量短链两路都落到这里）
func (h *Hub) Subscribe(token, sessionID string) (Subscription, error) {
	h.mu.Lock()
	f := h.feeds[token]
	if f == nil {
		h.mu.Unlock()
		h.Wire(token, sessionID)
		h.mu.Lock()
		f = h.feeds[token]
	}
	// 订阅点登记与并发计数同锁（f.mu 护 subs 表）：快照覆盖此前、实时通道
	// 覆盖此后，同一临界区内无重叠无缝隙
	f.mu.Lock()
	if !f.ended && len(f.subs) >= MaxGuestsPerToken {
		f.mu.Unlock()
		h.mu.Unlock()
		return nil, ErrTooManyGuests
	}
	s := &sub{ch: make(chan []byte, 256), done: make(chan struct{})}
	tail := append([]byte(nil), f.tail...)
	ended := f.ended
	cols, rows := f.cols, f.rows
	if !ended {
		f.subs[s] = struct{}{}
	}
	f.mu.Unlock()
	h.mu.Unlock()

	return &subscription{
		tail:  tail,
		live:  s.ch,
		done:  s.done,
		ended: ended,
		size:  func() (uint16, uint16) { return cols, rows },
		rele: func() {
			f.mu.Lock()
			delete(f.subs, s)
			f.mu.Unlock()
			s.finish()
		},
	}, nil
}

// Stop 收尾全部馈线并摘除对账回调（模块 Stop 调用）
func (h *Hub) Stop() {
	if h.onChangeC != nil {
		h.onChangeC()
		h.onChangeC = nil
	}
	h.mu.Lock()
	all := make([]*feed, 0, len(h.feeds))
	for tok, f := range h.feeds {
		all = append(all, f)
		delete(h.feeds, tok)
	}
	h.mu.Unlock()
	for _, f := range all {
		f.end()
	}
}
