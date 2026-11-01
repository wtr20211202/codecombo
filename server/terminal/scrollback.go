package terminal

import (
	"io"
	"sync"
	"time"
	"unicode/utf8"
)

// DefaultScrollbackLines 终端 scrollback 默认行数
// 取值平衡：覆盖大多数使用场景的历史输出，又不至于让浏览器 xterm 内存过大
const DefaultScrollbackLines = 20000

// scrollbackLineBytes 估算每行平均字节数（含 ANSI 颜色/光标转义）
// 用于把用户配置的行数换算为服务端字节缓冲容量
const scrollbackLineBytes = 80

// defaultScrollbackBytes 默认容量 = DefaultScrollbackLines * scrollbackLineBytes
var defaultScrollbackBytes = DefaultScrollbackLines * scrollbackLineBytes

// GetScrollbackLines 读取配置的 scrollback 行数，未配置或非法时返回默认值
// 供 admin settings handler 与 terminal manager 共用，保证两边判定一致
func GetScrollbackLines(cfg int) int {
	if cfg < 1000 || cfg > 200000 {
		return DefaultScrollbackLines
	}
	return cfg
}

// scrollbackBytesFromLines 把行数换算为字节缓冲容量
func scrollbackBytesFromLines(lines int) int {
	return lines * scrollbackLineBytes
}

// anchorOffInterval 时间锚点采样间隔（写入偏移粒度，P-20261005-233）：每推进
// 64KB 采样一枚「写到这里时是几点」。偏移粒度（而非时间节流）保证现存字节窗
// [written-length, written) 内的锚点密度有上界——窗口内至多
// capacity/anchorOffInterval+1 枚，锚点环容量取两倍再加余量后，EarliestTime
// 恒可解析（窗口起点之前必有存留锚点），无时间节流、无定时器
const anchorOffInterval = 64 * 1024

// scrollbackTimeAnchor 时间锚点：at 时刻已落笔 off 字节（写前坐标——[off,)
// 是本枚锚点之后才写入的字节）。对偏移 X 的字节，其写入时刻 ∈ [最后一枚
// off≤X 的锚点时刻, 下一枚锚点时刻)
type scrollbackTimeAnchor struct {
	off uint64
	at  time.Time
}

// ScrollbackBuffer 定长环形字节缓冲，缓存 PTY 最近输出
// native backend 无 capture-pane 能力，用此缓存支持 WS 重连时的 scrollback 重放
// tmux backend 不使用此缓存（capture-pane 能拿到光标位置等完整状态）
// remoteterminal 包（SSH PTY 会话）同样复用此缓冲缓存远端输出
type ScrollbackBuffer struct {
	mu      sync.Mutex
	ring    []byte // 固定容量 maxBytes
	start   int    // 最旧字节的索引
	length  int    // 当前有效字节数（<= len(ring)）
	written uint64 // 累计写入字节，单调递增——绝对偏移锚点，供 SnapshotReader 把
	// 捕获窗口换算为 [written-length, written) 并检测后续写入对最旧字节的覆盖
	anchors    []scrollbackTimeAnchor // 时间锚点环（写入序，满环时 anchorHead 指最旧）
	anchorHead int                    // 满环时的最旧锚点下标（未满时恒 0）
	lastAnchor uint64                 // 上一枚锚点的写入偏移（采样间隔判定）
}

// NewScrollback 按默认容量构造缓冲
func NewScrollback() *ScrollbackBuffer {
	return NewScrollbackWithCapacity(defaultScrollbackBytes)
}

// NewScrollbackWithCapacity 按指定字节数构造缓冲（来自用户配置）
func NewScrollbackWithCapacity(bytes int) *ScrollbackBuffer {
	if bytes < 64*1024 {
		bytes = 64 * 1024
	}
	return &ScrollbackBuffer{
		ring: make([]byte, bytes),
		// 锚点环容量 = 现存字节窗内最大采样数的两倍余量：无论写入节奏如何，
		// 窗口起点之前恒有存留锚点，EarliestTime 不出现「窗口早于锚点记忆」
		// 的不可解析态（该态只能诚实返回 false，缺口判定宁缺勿误）
		anchors: make([]scrollbackTimeAnchor, 0, bytes/anchorOffInterval*2+8),
	}
}

// Write 追加数据，超出容量时按字节覆盖最旧数据
// 写入完成后扫描 start 跳过 UTF-8 continuation bytes，保证 Snapshot 起点
// 位于完整字符边界，避免重连重放时显示替换字符
// （OSC/SGR 等控制序列本身为 ASCII，不存在中间截断问题）
//
// 注意：\x1b[2J（ED 2 清屏）在真实终端中只清空可见屏幕，不清 scrollback。
// buffer 完整保留所有 PTY 输出（含 \x1b[2J），刷新重放时 xterm 自行按终端语义
// 处理（清屏但保留 scrollback），用户向上滚动能看到完整历史。
func (b *ScrollbackBuffer) Write(data []byte) {
	if len(data) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	// 时间锚点采样（P-20261005-233）：记录「写前偏移 → 此刻」。空缓冲首写必采
	//（少量输出时 EarliestTime 也要可解析），此后每推进 anchorOffInterval 采一枚。
	// 须在任何缓冲变更之前取值：锚点坐标是本批写入之前的 written
	if b.length == 0 || b.written-b.lastAnchor >= anchorOffInterval {
		b.recordTimeAnchor(b.written, time.Now())
	}

	cap := len(b.ring)
	// 单次写入超过环容量：只保留最末 cap 字节，并回退到 UTF-8 字符边界
	if len(data) > cap {
		cut := len(data) - cap
		data = data[rewindToRuneStart(data, cut):]
	}

	// 写入会让总长超过容量：先推进 start 跳过将被覆盖的最旧字节
	if b.length+len(data) > cap {
		overflow := b.length + len(data) - cap
		b.start = (b.start + overflow) % cap
		b.length = cap - len(data)
	}

	// 从 start+length 位置开始写入，绕回时拆成两段 copy
	for i := 0; i < len(data); {
		pos := (b.start + b.length) % cap
		n := copy(b.ring[pos:], data[i:])
		b.length += n
		i += n
	}

	// UTF-8 边界修复：start 处若是 continuation byte（被截断的字符前缀），
	// 向前推进 start 直到 RuneStart，丢弃不完整的字符前缀
	// 最多跳过 3 字节（UTF-8 最长 4 字节，1 字节已是 RuneStart 不进入循环）
	if b.length > 0 {
		for i := 0; i < 3 && b.length > 0; i++ {
			if utf8.RuneStart(b.ring[b.start]) {
				break
			}
			b.start = (b.start + 1) % cap
			b.length--
		}
	}

	b.written += uint64(len(data))
}

// recordTimeAnchor 追加一枚时间锚点（须持锁调用）：未满顺序追加；满环覆盖
// 最旧槽位并推进 head，使 anchors 沿「head 起 ring 序」保持写入序
func (b *ScrollbackBuffer) recordTimeAnchor(off uint64, at time.Time) {
	if b.anchors == nil {
		return // 零值构造（测试直改字段）的缓冲：无锚点容量，诚实缺失不 panic
	}
	a := scrollbackTimeAnchor{off: off, at: at}
	if len(b.anchors) < cap(b.anchors) {
		b.anchors = append(b.anchors, a)
	} else {
		b.anchors[b.anchorHead] = a
		b.anchorHead = (b.anchorHead + 1) % len(b.anchors)
	}
	b.lastAnchor = off
}

// EarliestTime 估计现存最旧字节的写入时刻（P-20261005-233 断档检测的检测原语）：
// 取「≤ 最旧存活偏移（written-length）的最后一枚锚点」的时刻。锚点先于其后字节
// 落笔，估计值不晚于真实写入时刻（低估 earliest）——缺口判定「earliest 晚于
// 断开前最后输出」只会因低估而漏标、不会误标。空缓冲或锚点环未分配返回
// false，消费方按「完整性未知」处理（不发 G 帧/不带响应头——诚实缺失优于猜测）
func (b *ScrollbackBuffer) EarliestTime() (time.Time, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.length == 0 || len(b.anchors) == 0 {
		return time.Time{}, false
	}
	floor := b.written - uint64(b.length)
	n := len(b.anchors)
	for i := n - 1; i > 0; i-- {
		a := &b.anchors[(b.anchorHead+i)%n]
		if a.off <= floor {
			return a.at, true
		}
	}
	// i=0（最旧锚点）单独判：首写必采 off=0，通常即答案；环已翻转为防御性兜底
	a := &b.anchors[b.anchorHead]
	if a.off <= floor {
		return a.at, true
	}
	return time.Time{}, false
}

// rewindToRuneStart 从 idx 向前回退到 data[idx] 是 UTF-8 字符起始字节的位置
// 用于单次写入超容量时按完整字符截断
func rewindToRuneStart(data []byte, idx int) int {
	if idx <= 0 {
		return 0
	}
	if idx >= len(data) {
		return len(data)
	}
	// 最多回退 3 字节（UTF-8 最长 4 字节），避免被损坏的字节流卡住
	for i := 0; i < 3 && idx > 0; i++ {
		if utf8.RuneStart(data[idx]) {
			return idx
		}
		idx--
	}
	return idx
}

// Snapshot 返回最近 maxLines 行的字节快照（nil 表示缓冲区为空）
// maxLines <= 0 返回全部缓冲内容
// 算法：从末尾向前找 maxLines+1 个 '\n'，最后一个 '\n' 之后即 maxLines 行起点
// （行末的 '\n' 算作该行的结束符，不算入下一行起点）
func (b *ScrollbackBuffer) Snapshot(maxLines int) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.length == 0 {
		return nil
	}

	// 先线性化环形数据（start..start+length 可能绕回 ring 末尾）
	flat := make([]byte, b.length)
	cap := len(b.ring)
	if b.start+b.length <= cap {
		copy(flat, b.ring[b.start:b.start+b.length])
	} else {
		n1 := copy(flat, b.ring[b.start:])
		copy(flat[n1:], b.ring[:b.length-n1])
	}

	if maxLines <= 0 {
		return flat
	}

	newlines := 0
	idx := len(flat)
	for idx > 0 && newlines < maxLines+1 {
		idx--
		if flat[idx] == '\n' {
			newlines++
		}
	}
	// 找到 maxLines+1 个 '\n' 时 idx 指向最后一个 '\n'，需 +1 跳到下一行起点
	// 不足时返回整个缓冲（不足 maxLines 行的边界场景）
	if newlines == maxLines+1 {
		idx++
	} else {
		idx = 0
	}
	return flat[idx:]
}

// ScrollbackReader 环形缓冲快照的分段迭代读取器（SnapshotReader 返回）：
// 以绝对偏移锚定捕获时点的字节窗口，Next 按调用方缓冲分段拷贝。与 Snapshot
// 的 ring→flat 整体复制相比，免去大缓冲（scrollback 可配 20 万行≈16MB）的
// 整段分配，且单次持锁只覆盖一块拷贝——Write 不被整个重放期阻塞。
// 并发写入覆盖窗口最旧字节时跳过失效前缀（重放从不交付已被覆盖的坐标），
// 其余字节原序交付。
type ScrollbackReader struct {
	b     *ScrollbackBuffer
	start uint64 // 窗口起点（绝对偏移，捕获时点）
	end   uint64 // 窗口终点（绝对偏移，捕获时点）
	pos   uint64 // 下一段读取位置（绝对偏移）
}

// SnapshotReader 返回最近 maxLines 行内容的分段读取器（maxLines<=0 全部）。
// 行裁剪语义与 Snapshot 一致（从末尾向前找 maxLines+1 个 '\n'，最后一个之后
// 为起点，行末 '\n' 归属当前行）。空缓冲返回立即 EOF 的读取器。
// 注意：捕获不冻结数据——窗口字节随后可能被滚动覆盖，由 Next 跳过失效前缀
func (b *ScrollbackBuffer) SnapshotReader(maxLines int) *ScrollbackReader {
	b.mu.Lock()
	defer b.mu.Unlock()

	end := b.written
	// written >= length 恒成立（每字节先计入 written 才计入 length）；
	// 钳制只为防御测试直改字段的失衡态，防 start 下溢出负 Len
	if b.written < uint64(b.length) {
		end = uint64(b.length)
	}
	start := end - uint64(b.length)
	if maxLines > 0 && b.length > 0 {
		start = b.lineWindowStart(start, end, maxLines)
	}
	return &ScrollbackReader{b: b, start: start, end: end, pos: start}
}

// lineWindowStart 在锁内从绝对偏移 end 向前扫描，返回最近 maxLines 行的窗口
// 起点；不足 maxLines 行时返回整个缓冲起点。与 Snapshot 的 flat 扫描同语义，
// 只是直接在 ring 坐标上找（免整体复制）——两处行裁剪逻辑须同步修改
func (b *ScrollbackBuffer) lineWindowStart(start, end uint64, maxLines int) uint64 {
	cap := uint64(len(b.ring))
	newlines := 0
	off := end
	for off > start && newlines < maxLines+1 {
		off--
		if b.ring[off%cap] == '\n' {
			newlines++
		}
	}
	if newlines == maxLines+1 {
		return off + 1
	}
	return start
}

// Len 窗口总字节数（捕获时点，不随后续写入变化；窗口前缀被并发覆盖时实际
// 可读会小于此值，Next 会提前 EOF）
func (r *ScrollbackReader) Len() int {
	return int(r.end - r.start)
}

// Next 拷贝下一段到 p（≤len(p) 字节），返回实际字节数；窗口耗尽返回
// (0, io.EOF)。持锁只覆盖单段拷贝，块间 Write 可正常推进
func (r *ScrollbackReader) Next(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	r.b.mu.Lock()
	defer r.b.mu.Unlock()

	if r.pos >= r.end {
		return 0, io.EOF
	}
	// 并发写入推进了覆盖前沿（floor=当前最旧有效偏移）：窗口最旧部分已被
	// 覆盖则跳过，从幸存处继续。written < length 只可能来自测试直接改字段，
	// 钳到 0 防无符号下溢
	floor := uint64(0)
	if r.b.written >= uint64(r.b.length) {
		floor = r.b.written - uint64(r.b.length)
	}
	if r.pos < floor {
		r.pos = floor
	}
	if r.pos >= r.end {
		return 0, io.EOF
	}

	n := len(p)
	if rem := r.end - r.pos; uint64(n) > rem {
		n = int(rem)
	}
	cap := len(r.b.ring)
	off := int(r.pos % uint64(cap))
	// 窗口可能绕 ring 末尾，拆两段拷贝；只拷 n 字节（窗口终点前可能还有
	// ring 数据，不属于本窗口）
	n1 := copy(p[:n], r.b.ring[off:])
	if n1 < n {
		copy(p[n1:], r.b.ring[:n-n1])
	}
	r.pos += uint64(n)
	return n, nil
}
