package terminal

import (
	"bytes"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// OSC 7 cwd 实时追踪（P-20261004-59）：shell 集成标准伴生协议——shell 在每次
// 显示提示符前上报当前工作目录（ESC ] 7 ; file://host/path BEL/ST）。会话创建
// 只记静态 dir，agent/shell cd 进子目录后「链接相对路径解析 / 文件树定位 /
// 目录驻留徽标 / 复制会话」等 cwd 消费位全部拿旧值——本探测把会话 cwd 从
// 「创建时快照」变「运行时事实」。
//
// 与 dev 端口探测（portdetect.go）/ 输出哨兵（sentinel.go）同挂 readLoop 输出
// tap：无 WS 客户端 attached 也生效（后台 agent 会话 cd 后前台照样拿到新位置）。
// 纯内存运行态（不落盘）：重启后 tmux 历史里的 OSC7 不可考，消费方按
// known=false 回落创建 dir——与「无帧优雅回落」同语义，无持久化车道。
//
// 性能护栏（输出流是热路径，与 portdetect 同量级考量）：
//   - 无 `\x1b]` 前缀字节直接跳过（普通输出零正则零扫描，逐字节线性一次）；
//   - 跨 chunk 半帧 pending 缓冲上限 cwdPendingCap，超限丢弃（路径长度远小于
//     该值，超限只可能是异常流，弃帧回落创建 dir 即可）；
//   - tmux DCS passthrough 包装（\x1bPtmux;\x1b\x1b]7;...\x07\x1b\\）无需特判：
//     内层 `\x1b]7;` 形态完整，终止 BEL 照常可寻。

const (
	// cwdPendingCap 跨 chunk 半帧缓冲上限：file URL ≈ 2×路径字节（百分号编码
	// 上界），8KB 覆盖任何合法路径
	cwdPendingCap = 8 * 1024
	// cwdMaxLen 解析结果长度护栏：超出视为异常流弃帧
	cwdMaxLen = 4096
)

// osc7Payload 从字节流起点扫描一个 OSC 7 序列（\x1b]7;<payload>BEL 或 ST），
// 返回 payload 与终止后的下一偏移；buf 起点须已是 `\x1b]7;` 头（调用方保证）。
// 未找到终止符返回 ok=false（半帧，交 pending 拼接）
func osc7Payload(buf []byte) (payload string, next int, ok bool) {
	for i := 4; i < len(buf); i++ {
		switch buf[i] {
		case 0x07: // BEL 终止（本系统 shellint 与 tmux 包装形态）
			return string(buf[4:i]), i + 1, true
		case 0x1b: // ST 终止（ESC \ ——VS Code 等第三方集成惯例）
			if i+1 < len(buf) && buf[i+1] == '\\' {
				return string(buf[4:i]), i + 2, true
			}
			// 裸 ESC：payload 内不允许 ESC，视为异常流截断
			return "", 0, false
		}
	}
	return "", 0, false
}

// tolerantUnescape 百分号解码（容错）：合法 %XX 逐个解码，裸 % 保留原样——
// url.PathUnescape 对含非法转义的整串直接报错，会把同串里的合法 %20 一并丢掉
// （shell 路径含未编码 % 是现实输入，不能整串拒解码）
func tolerantUnescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// normalizeOSC7Dir file URL → 本机路径：剥 scheme 与 host（本机会话只看本机
// 路径形态）、百分号解码（解码失败保留原样——裸 % 路径合法）、Windows 盘符
// 形态 /C:/... 折算为原生分隔符（仅 windows 运行时——服务端与 shell 同机，
// 快照消费方拿到的口径与创建 dir 一致；linux/mac 保持 POSIX 原样）
func normalizeOSC7Dir(payload string) (string, bool) {
	const scheme = "file://"
	if !strings.HasPrefix(payload, scheme) {
		return "", false
	}
	rest := payload[len(scheme):]
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return "", false
	}
	p := rest[slash:]
	// file URL 语义上 ? # 是 query/fragment 分隔符，路径内出现即为越界内容
	if q := strings.IndexAny(p, "?#"); q >= 0 {
		p = p[:q]
	}
	p = tolerantUnescape(p)
	if p == "" || len(p) > cwdMaxLen {
		return "", false
	}
	if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '/' && p[2] == ':' &&
		((p[1] >= 'A' && p[1] <= 'Z') || (p[1] >= 'a' && p[1] <= 'z')) {
		p = filepath.FromSlash(p[1:])
	}
	return p, true
}

// cwdTracker 单会话 OSC 7 追踪器：跨 chunk 半帧拼接 + 最近一帧生效。
// 同一会话同刻只有一个 shell，cwd 单值足够；历史帧无需保留
type cwdTracker struct {
	mu      sync.Mutex
	pending []byte
	dir     string
	known   bool
}

func newCWDDetector() *cwdTracker {
	return &cwdTracker{}
}

// feed 喂入一段 PTY 输出（readLoop 每 4KB 块一次）。逐字节线性扫描，命中的
// 序列就地解析；尾部未终结半帧入 pending 待下一块拼接
func (c *cwdTracker) feed(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	buf := data
	if len(c.pending) > 0 {
		if len(c.pending)+len(data) > cwdPendingCap {
			// 异常流兜底：弃 pending，当前块按无缓冲语义处理
			c.pending = nil
		} else {
			buf = append(c.pending, data...)
		}
	}
	for {
		idx := indexOSC7Head(buf)
		if idx < 0 {
			// 无完整头：尾部可能是被截断的半帧头，暂存待拼接
			c.stashTail(buf)
			return
		}
		payload, next, ok := osc7Payload(buf[idx:])
		if !ok {
			// 半帧（payload 未终结）：从头部起暂存
			c.stashTail(buf[idx:])
			return
		}
		if dir, valid := normalizeOSC7Dir(payload); valid {
			c.dir = dir
			c.known = true
		}
		buf = buf[idx+next:]
	}
}

// osc7HeadBytes OSC 7 序列头（ESC ] 7 ;）：包级一次构造，热路径零分配
var osc7HeadBytes = []byte("\x1b]7;")

// indexOSC7Head 返回 buf 中首个 OSC 7 序列头的偏移（`\x1b]7;`）；无则 -1
func indexOSC7Head(buf []byte) int {
	return bytes.Index(buf, osc7HeadBytes)
}

// stashTail 暂存尾部可能的半帧：只保最后一个 ESC 起的尾巴（与前端
// splitPendingTail 同判定思路——完整序列内不会再有悬空头）。尾巴本身就是
// pending 的一部分，上限由 feed 入口把守
func (c *cwdTracker) stashTail(buf []byte) {
	esc := bytes.LastIndexByte(buf, 0x1b)
	if esc < 0 {
		c.pending = nil
		return
	}
	c.pending = append(c.pending[:0], buf[esc:]...)
}

// current 返回最近一次 OSC 7 解出的会话 cwd；known=false = 尚无帧（shell 未发
// OSC7 / 新会话无 prompt / 重启恢复历史不可考），消费方回落创建 dir
func (c *cwdTracker) current() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dir, c.known
}
