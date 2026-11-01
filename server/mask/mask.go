package mask

import (
	"encoding/base64"
	"regexp"
)

// 敏感值模式遮蔽（P-20261001-15 安全修正，硬性；P-20261002-108 扩充模式集）：
// tap 录制会把终端 echo 的敏感值（agent env 打印 CC_LOCK_TOKEN 明文等）永久
// 留在证据里——遮蔽必须在写盘前做。本文件是 tap 层的流式遮蔽器：
//
// 独立成包（P-20261003-197 自 server/recording 平移而来）：模式族是零业务依赖
// 的纯文本工具，除录制 tap 外还有检索遮蔽/会话接力/liveterm 流式/审批面脱敏
// （redact.go）等消费方——留在 recording 包会让 middleware/ai 层经
// recording→opschannel→middleware 产生 import 环。
//
//   - 模式集（权威定义在回放侧 web/src/utils/sensitiveMask.ts「模式集」注释，
//     Go 与 TS 无法跨语言共享代码，按彼处逐条对齐；改任一侧必须同步另一侧
//     与双侧单测 mask_test.go ↔ sensitiveMask.test.ts 同一语料互锁）：
//       ① sc[a-z]_[A-Za-z0-9]+   sc?_ 系标识整段（sca_ 智能体令牌 / scl_ 解锁
//                                令牌 / sc_ap_ 审批 ID 等）
//       ② password/passwd/pwd/token 赋值形态（不区分大小写）：键名+分隔符
//                                保留，值整段替换
//       ③ \b(AKIA|ASIA)[A-Z0-9]{16}\b  AWS 访问密钥 ID（AKIA 长期 / ASIA 临时）
//   - OSC 133 E 帧（shell integration 整行命令文本，base64 载荷）解码后按同一
//     模式集遮蔽再重新编码——agent 带 token 执行的命令行在 TUI 场景不经终端
//     echo，E 帧是唯一记录，明文遮蔽覆盖不到。
//
// PTY 输出以 4096 字节分片到达（readLoop 缓冲），模式命中可能跨分片：遮蔽器
// 有状态（跨 Write 携带未定界字节与半程状态）。每个录制会话独享一个实例、
// 仅被该会话 readLoop 单 goroutine 调用，无需加锁。
//
// 实现：hold 首字节驱动的状态机。scan 态 hold 恒为候选哨兵的真前缀（≤7 字节
// ——每步要么消费 ≥1 字节要么等待更多数据；赋值/云密钥候选另持 cand 缓存键+
// 分隔符，证伪按首字节回吐重扫）；值态字符只计数不落缓冲（值长无上界，跨
// Write 累计），流尾滞留由 Flush 补出；frameE 态载荷受 eFrameMaxLen 上限保护。
// 词边界（模式②③的 \b）按原始流逐字节判定：prev 恒为当前消费位置前一原始
// 字节（被吞值字符也计入）——与全量正则在原文上求边界同语义。单 chunk 代价
// O(n)，候选证伪回吐有界（≤键名+分隔符窗口）。

const (
	// tokenMask 遮蔽替换文本
	tokenMask = "***"
	// eFrameMaxLen E 帧载荷缓冲上限：shellint 侧原始命令 8KB 截断，base64 约
	// 10.9KB；超限说明帧已损坏，原样放行（防无界缓冲）
	eFrameMaxLen = 16 * 1024
	// cloudKeyBodyLen AWS 访问密钥 ID 前缀（AKIA/ASIA）后的定长值段位数
	cloudKeyBodyLen = 16
	// sepMaxWS 赋值形态分隔符两侧空白上限：流式候选缓存的病理防护（"password"
	// 与 "=" 间隔几十个空格不构成现实形态）；全量侧（MaskText / 回放渲染层）
	// 无此限，流式侧漏网由回放兜底遮蔽
	sepMaxWS = 32
)

// 内置全量模式集的编译产物（遮蔽链与出域敏感扫描 scan.go 共用同一份正则
// ——两套消费面单源，改模式不会只生效一半）。逐条对齐
// web/src/utils/sensitiveMask.ts。
var (
	// ① sc?_ 系标识整段（sca_ 智能体令牌 / scl_ 解锁令牌 / sc_ap_ 审批 ID 等）
	scTokenRe = regexp.MustCompile(`sc[a-z]_[A-Za-z0-9]+`)
	// ② password/passwd/pwd/token 赋值形态（不区分大小写）。起始边界三态
	// （文本起点 / 非词字符 / ANSI SGR 序列）：终端着色回显把 SGR 紧贴键名
	// （PSReadLine `\x1b[37mPASSWORD=`），SGR 尾字节 'm' 是词字节，普通 \b 必漏
	assignSecretRe = regexp.MustCompile(`(^|[^A-Za-z0-9_]|\x1b\[[0-9;]*m)(?i:(password|passwd|pwd|token))(["']?[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^\s"']+)`)
	// ③ AWS 访问密钥 ID（AKIA 长期 / ASIA 临时；定长大写，同款三态起始边界，
	// 尾部词边界防吃进更长非密钥串）
	awsKeyRe = regexp.MustCompile(`(^|[^A-Za-z0-9_]|\x1b\[[0-9;]*m)(?:AKIA|ASIA)[A-Z0-9]{16}\b`)
)

// maskPattern 全量文本兜底遮蔽模式（非流式）
type maskPattern struct {
	re   *regexp.Regexp
	repl string
}

// maskPatterns 全量模式集（顺序即应用顺序）——与 web/src/utils/sensitiveMask.ts
// 逐条对齐，亦为流式状态机（scan/值态）的语义蓝本
var maskPatterns = []maskPattern{
	{scTokenRe, tokenMask},
	// $1 边界 $2 键名 $3 分隔符保留，值（双引号/单引号/裸词三形态）整段替换
	{assignSecretRe, `${1}${2}${3}` + tokenMask},
	{awsKeyRe, `${1}` + tokenMask},
}

// MaskText 对一段完整文本做兜底遮蔽（E 帧解码载荷 / 元数据展示 / 回放渲染层
// 同款模式集；非流式）。内置模式集之后并入自定义敏感模式（P-20261006-11，
// custom.go 注册表——设置写路径/启动期注入，空列表零变化）；顺序固定
// 「内置 → 自定义」，与 TS 侧 maskSensitive 同序（双端一致性语料锚定）
func MaskText(s string) string {
	for _, p := range maskPatterns {
		s = p.re.ReplaceAllString(s, p.repl)
	}
	return MaskCustom(s)
}

// maskerState 状态：scan 扫描哨兵 / token 收集 sc?_ 值 / frameE 收集 E 帧载荷 /
// assignSep 判定赋值分隔符 / assignVal·assignQuote 收集赋值值段 / akia 收集云密钥
type maskerState int

const (
	maskScan        maskerState = iota
	maskToken                   // sc?_ 前缀已确认，值字符只计数
	maskFrameE                  // OSC 133 E 帧头已消费，hold 全为载荷+后续流
	maskAssignSep               // 赋值键名已确认（仍在 hold），判定分隔符+值首字节
	maskAssignVal               // 赋值裸值态：键+分隔符在 cand，值字符只计数
	maskAssignQuote             // 赋值引号值态：吞至闭合引号
	maskAKIA                    // 云密钥前缀已确认（cand），值段只计数
)

// eFrameHead OSC 133 E 帧头：ESC ] 1 3 3 ; E ;
var eFrameHead = [...]byte{0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x45, 0x3b}

// assignKeys 赋值形态键名（模式②；大小写不敏感）
var assignKeys = [...]string{"password", "passwd", "pwd", "token"}

// cloudKeyPrefixes 云密钥前缀（模式③；大写敏感）
var cloudKeyPrefixes = [...]string{"AKIA", "ASIA"}

// Masker 流式遮蔽器（每录制会话一个，readLoop 单 goroutine 调用）
type Masker struct {
	state  maskerState
	hold   []byte // 未定界字节，跨 Write 携带
	masked int    // 值态：已吞值字符数（不落缓冲）
	prev   byte   // 原始流中当前消费位置的前一字节（\b 词边界判定；流首为 0）
	cand   []byte // 赋值/云密钥候选缓存（键+分隔符或前缀+值段；成功随替换输出，证伪回吐）
	quote  byte   // assignQuote 态：闭合引号
	keyLen int    // assignSep 态：键名长度（hold 内偏移）
	esc    int    // CSI 跟踪（scan 态放行路径）：0 无 / 1 见 ESC / 2 见 ESC[（参数字节中）
}

// NewMasker 创建流式遮蔽器
func NewMasker() *Masker { return &Masker{} }

// Write 吞吐一段 PTY 输出，返回遮蔽后的字节（返回值为独立拷贝，可长期持有）
func (m *Masker) Write(data []byte) []byte {
	m.hold = append(m.hold, data...)
	out := make([]byte, 0, len(data)+len(data)/8)
	for m.advance(&out) {
	}
	return out
}

// Flush 流结束时放行滞留的未定界字节（录制收尾调用）。值态滞留（值恰在流尾）
// 在此补出 ***——否则整段值被静默丢弃而非遮蔽（全量语义：值在流尾即完整命中）；
// assignQuote 空值（仅开引号被吞、无值字符）按原样还原——该形态在全量侧不构成
// 命中；未终结 E 帧经 emitEFrame 收尾（帧结构保持）
func (m *Masker) Flush() []byte {
	var out []byte
	switch m.state {
	case maskToken:
		if m.masked > 0 {
			out = append(out, tokenMask...)
		}
	case maskAssignVal:
		if m.masked > 0 {
			out = append(out, m.cand...)
			out = append(out, tokenMask...)
		}
	case maskAssignQuote:
		out = append(out, m.cand...)
		if m.masked > 0 {
			out = append(out, tokenMask...)
		} else {
			out = append(out, m.quote)
		}
	case maskAKIA:
		if m.masked == cloudKeyBodyLen {
			out = append(out, tokenMask...)
		} else {
			out = append(out, m.cand...) // 值段不足：非密钥，原样放行
		}
	case maskFrameE:
		out = append(out, m.emitEFrame(m.hold)...) // 载荷滞留于 hold（帧头已消费）
	default:
		out = append(out, m.hold...)
	}
	m.hold = nil
	m.cand = m.cand[:0]
	m.state = maskScan
	m.masked = 0
	m.prev = 0
	m.quote = 0
	m.keyLen = 0
	m.esc = 0
	return out
}

// advance 消费 hold 推进一步，把安全字节写入 out；返回是否消费了字节
// （false = 等待更多数据，hold 保留）
func (m *Masker) advance(out *[]byte) bool {
	switch m.state {
	case maskFrameE:
		return m.advanceFrameE(out)
	case maskToken:
		return m.advanceToken(out)
	case maskAssignSep:
		return m.advanceAssignSep(out, m.keyLen)
	case maskAssignVal:
		return m.advanceAssignVal(out)
	case maskAssignQuote:
		return m.advanceAssignQuote(out)
	case maskAKIA:
		return m.advanceAKIA(out)
	default:
		return m.advanceScan(out)
	}
}

// advanceScan 扫描态：hold[0] 驱动——完整哨兵则转态，真前缀则等待，
// 非候选或已证伪则放行首字节（后续 advance 重扫余量）
func (m *Masker) advanceScan(out *[]byte) bool {
	if len(m.hold) == 0 {
		return false
	}
	switch {
	case m.hold[0] == 's':
		// token 候选：sc[a-z]_ 四字节前缀 + 至少 1 个值字符（无词边界——令牌
		// 在任意上下文出现都整段遮蔽，与模式①一致）
		if len(m.hold) < 4 {
			if isTokenPrefix(m.hold) {
				return false // "s" / "sc" / "sc?" 真前缀：等待
			}
			m.releaseByte(out)
			return true
		}
		if m.hold[1] == 'c' && isLower(m.hold[2]) && m.hold[3] == '_' {
			if len(m.hold) == 4 {
				return false // 前缀完整但值字符未到：等待（值开头 / 非值终结符定界）
			}
			if isTokenValueByte(m.hold[4]) {
				m.state = maskToken
				m.masked = 0
				m.prev = m.hold[3]
				m.drop(4) // 前缀字节不外发
				return true
			}
			// 前缀后紧跟非值字符：不构成 sc[a-z]_[A-Za-z0-9]+（值段至少 1 字符），
			// 放行 's' 重扫余量，避免把 "scx_;" 这类普通文本误遮
			m.releaseByte(out)
			return true
		}
		m.releaseByte(out)
		return true
	case m.hold[0] == 0x1b:
		// E 帧头候选：8 字节定长
		if len(m.hold) < len(eFrameHead) {
			if hasBytePrefix(m.hold, eFrameHead[:]) {
				return false // 真前缀：等待
			}
			m.releaseByte(out)
			return true
		}
		if hasBytePrefix(m.hold, eFrameHead[:]) {
			m.state = maskFrameE
			m.prev = eFrameHead[len(eFrameHead)-1]
			m.drop(len(eFrameHead)) // 帧头不外发（emitEFrame 重建）
			return true
		}
		m.releaseByte(out)
		return true
	case (m.hold[0] == 'p' || m.hold[0] == 'P' || m.hold[0] == 't' || m.hold[0] == 'T') && !isWordByte(m.prev):
		// 赋值形态候选（模式②，大小写不敏感键名；词边界与全量 \b 同语义）
		return m.advanceAssignKey(out)
	case m.hold[0] == 'A' && !isWordByte(m.prev):
		// 云密钥候选（模式③，大写敏感；词边界同上）
		return m.advanceAKIAPrefix(out)
	default:
		m.releaseByte(out)
		return true
	}
}

// releaseByte 放行 hold 首字节（非候选 / 证伪路径；后续 advance 重扫余量）。
// CSI 序列透明：SGR 等控制序列紧贴单词时（PSReadLine 着色回显
// `\x1b[37mPASSWORD=`），序列尾字节本身是词字节（'m'/'A'/'l'…）会让下一候选
// 的词边界判定伪失败——序列完成即把 prev 归零（视作边界，与全量模式②③的
// 「SGR 边界」同语义）。跟踪跨 Write 持续（序列可跨分片）
func (m *Masker) releaseByte(out *[]byte) {
	b := m.hold[0]
	switch m.esc {
	case 1: // 上字节为 ESC
		if b == '[' {
			m.esc = 2
		} else {
			m.esc = 0
		}
	case 2: // CSI 参数字节中
		if b >= 0x40 && b <= 0x7e {
			m.esc = 0
			m.prev = 0 // 序列完成 = 边界
			*out = append(*out, b)
			m.drop(1)
			return
		}
		if b > 0x3f { // 非参数字节且非终结字节：畸形序列，放弃跟踪
			m.esc = 0
		}
	default:
		if b == 0x1b {
			m.esc = 1
		}
	}
	m.prev = b
	*out = append(*out, b)
	m.drop(1)
}

// advanceAssignKey 赋值键名判定：全键命中转 assignSep（分隔符+值形态在彼处
// 判定，键名字节留在 hold 原位——证伪须原样放行）；真前缀等待；证伪放行首字节
func (m *Masker) advanceAssignKey(out *[]byte) bool {
	n, full, more := matchAssignKey(m.hold)
	switch {
	case full:
		m.keyLen = n
		m.state = maskAssignSep
		return true // 分隔符/值形态判定由下一轮 advance 的 assignSep 态接管
	case more:
		return false // 真前缀：等待
	default:
		m.releaseByte(out)
		return true
	}
}

// matchAssignKey hold 对键名集的命中判定：返回最长全键长度（full=true）/
// 真前缀（more=true，等待更多数据）/ 证伪
func matchAssignKey(hold []byte) (n int, full, more bool) {
	for _, k := range assignKeys {
		if len(hold) < len(k) {
			if equalFoldASCII(hold, []byte(k[:len(hold)])) {
				more = true
			}
			continue
		}
		if equalFoldASCII(hold[:len(k)], []byte(k)) && len(k) > n {
			n, full = len(k), true
		}
	}
	return n, full, more
}

// advanceAssignSep 分隔符判定（hold 从键名首字节起，键名字节原位保留）：
// 按 ["']?[ \t]*[=:][ \t]* 消费（模式②分隔符；空白受 sepMaxWS 病理上限约束），
// 值首字节定形态——引号 → assignQuote（键+分隔符入 cand、开引号消费）、其余
// 非空白 → assignVal（裸值）。未定界等待；证伪放行首字节重扫
func (m *Masker) advanceAssignSep(out *[]byte, keyLen int) bool {
	pos := keyLen
	if pos < len(m.hold) && (m.hold[pos] == '"' || m.hold[pos] == '\'') {
		pos++
	}
	ws := 0
	for pos < len(m.hold) && isAssignSpace(m.hold[pos]) {
		pos++
		ws++
	}
	if ws > sepMaxWS {
		m.releaseByte(out)
		m.state = maskScan
		return true
	}
	if pos >= len(m.hold) {
		return false // 分隔符未定界：等待
	}
	if m.hold[pos] != '=' && m.hold[pos] != ':' {
		m.releaseByte(out)
		m.state = maskScan
		return true
	}
	pos++
	ws = 0
	for pos < len(m.hold) && isAssignSpace(m.hold[pos]) {
		pos++
		ws++
	}
	if ws > sepMaxWS {
		m.releaseByte(out)
		m.state = maskScan
		return true
	}
	if pos >= len(m.hold) {
		return false // 值首字节未到：等待
	}
	switch b := m.hold[pos]; {
	case b == '"' || b == '\'':
		// 引号值：键+分隔符入候选缓存（成功随 *** 输出 / Flush 还原），开引号消费
		m.cand = append(m.cand[:0], m.hold[:pos]...)
		m.quote = b
		m.masked = 0
		m.prev = b
		m.state = maskAssignQuote
		m.drop(pos + 1)
		return true
	default:
		// 裸值：键+分隔符入候选缓存，首值字符即命中（值段至少 1 字符已满足）
		m.cand = append(m.cand[:0], m.hold[:pos]...)
		m.masked = 1
		m.prev = b
		m.state = maskAssignVal
		m.drop(pos + 1)
		return true
	}
}

// advanceAssignVal 裸值态：吞 [^\s"']+ 值字符（只计数不落缓冲，跨 Write 累计）；
// 终结符（空白/引号）触发一次性输出 键+分隔符+***，终结符留在 hold 供 scan
// 重扫（可能是下一哨兵起点）。流尾滞留由 Flush 补出
func (m *Masker) advanceAssignVal(out *[]byte) bool {
	i := 0
	for i < len(m.hold) && isAssignValueByte(m.hold[i]) {
		m.prev = m.hold[i]
		i++
		m.masked++
	}
	if i < len(m.hold) {
		m.emitCandidate(out)
		m.drop(i)
		return true
	}
	m.drop(i)
	return i > 0
}

// advanceAssignQuote 引号值态：吞至闭合引号（只计数不落缓冲）；闭合引号消费并
// 输出 键+分隔符+***——与全量替换一致，两侧引号不进证据。流尾未闭合由 Flush
// 处置（有值字符补 ***，空值还原开引号）
func (m *Masker) advanceAssignQuote(out *[]byte) bool {
	i := 0
	for i < len(m.hold) && m.hold[i] != m.quote {
		m.prev = m.hold[i]
		i++
		m.masked++
	}
	if i < len(m.hold) {
		m.emitCandidate(out)
		m.prev = m.quote
		m.drop(i + 1) // 含闭合引号
		return true
	}
	m.drop(i)
	return i > 0
}

// advanceAKIAPrefix 云密钥前缀判定（模式③，大写敏感）：全前缀命中转 akia
// （前缀入 cand）；真前缀等待；证伪放行首字节
func (m *Masker) advanceAKIAPrefix(out *[]byte) bool {
	full := 0
	more := false
	for _, p := range cloudKeyPrefixes {
		if len(m.hold) >= len(p) {
			if string(m.hold[:len(p)]) == p && len(p) > full {
				full = len(p)
			}
		} else if string(p[:len(m.hold)]) == string(m.hold) {
			more = true
		}
	}
	switch {
	case full > 0:
		m.cand = append(m.cand[:0], m.hold[:full]...)
		m.masked = 0
		m.prev = m.hold[full-1]
		m.state = maskAKIA
		m.drop(full)
		return true
	case more:
		return false // 真前缀：等待
	default:
		m.releaseByte(out)
		return true
	}
}

// advanceAKIA 云密钥值态：吞 [A-Z0-9]{16}（值字符进 cand 缓存——证伪须原样
// 回吐）；计满后看词边界——尾随词字节（21+ 位超长串）证伪回吐，非词字节确认
// 命中出 ***（整段含前缀替换，cand 丢弃；边界字节留在 hold 重扫）
func (m *Masker) advanceAKIA(out *[]byte) bool {
	for m.masked < cloudKeyBodyLen && len(m.hold) > 0 {
		b := m.hold[0]
		if !isCloudKeyByte(b) {
			return m.releaseCandidate(out)
		}
		m.prev = b
		m.masked++
		m.cand = append(m.cand, b)
		m.drop(1)
	}
	if m.masked < cloudKeyBodyLen {
		return false // 值段未满：等待（流尾由 Flush 处置）
	}
	if len(m.hold) == 0 {
		return false // 边界字节未到：等待（流尾即边界，Flush 补出）
	}
	if isWordByte(m.hold[0]) {
		return m.releaseCandidate(out)
	}
	*out = append(*out, tokenMask...)
	m.cand = m.cand[:0]
	m.masked = 0
	m.state = maskScan
	return true
}

// emitCandidate 候选命中：输出缓存的键+分隔符（或前缀已吞）与一次性 ***，
// 复位值态
func (m *Masker) emitCandidate(out *[]byte) {
	*out = append(*out, m.cand...)
	*out = append(*out, tokenMask...)
	m.cand = m.cand[:0]
	m.masked = 0
	m.state = maskScan
}

// releaseCandidate 候选证伪：缓存首字节放行，其余字节顶回 hold 队首——候选
// 内部可能嵌套其他哨兵起点（如 token 值里的 sca_），逐字节重扫不漏
func (m *Masker) releaseCandidate(out *[]byte) bool {
	m.prev = m.cand[0]
	*out = append(*out, m.cand[0])
	rest := append([]byte(nil), m.cand[1:]...)
	m.hold = append(rest, m.hold...)
	m.cand = m.cand[:0]
	m.masked = 0
	m.state = maskScan
	return true
}

// advanceToken token 态：吞 [A-Za-z0-9]+ 值字符（只计数不落缓冲，跨 Write
// 累计）；终结符触发一次性出 ***，终结符留在 hold 供 scan 重扫（可能是下一
// 哨兵起点）。流尾的滞留值由 Flush 补出——每个 token 恰出一次 ***
func (m *Masker) advanceToken(out *[]byte) bool {
	i := 0
	for i < len(m.hold) && isTokenValueByte(m.hold[i]) {
		m.prev = m.hold[i]
		i++
		m.masked++
	}
	if i < len(m.hold) {
		*out = append(*out, tokenMask...)
		m.state = maskScan
		m.masked = 0
		m.drop(i)
		return true
	}
	m.drop(i)
	return i > 0
}

// advanceFrameE E 帧态：hold 从载荷起。找终结符 BEL（消费）/ ESC（保留重扫）；
// 超限原样放行（帧已损坏）
func (m *Masker) advanceFrameE(out *[]byte) bool {
	for i := 0; i < len(m.hold); i++ {
		b := m.hold[i]
		if b != 0x07 && b != 0x1b {
			m.prev = b
			continue
		}
		*out = append(*out, m.emitEFrame(m.hold[:i])...)
		if b == 0x07 {
			*out = append(*out, b)
			m.prev = b
			m.drop(i + 1)
		} else {
			m.drop(i) // ESC 终结：留给 scan 重扫（可能是下一帧头）
		}
		m.state = maskScan
		return true
	}
	if len(m.hold) > eFrameMaxLen {
		*out = append(*out, m.hold...)
		m.prev = m.hold[len(m.hold)-1]
		m.hold = m.hold[:0]
		m.state = maskScan
		return true
	}
	return false // 等待更多载荷
}

// drop 消费 hold 前 n 字节（剩余前移，容量有界）
func (m *Masker) drop(n int) {
	m.hold = append(m.hold[:0], m.hold[n:]...)
}

// emitEFrame 遮蔽一个完整 E 帧载荷：解码 → MaskText → 重编码；解码失败原样
// 返回（遮蔽器不得损坏非敏感证据；E 帧头由本函数重建）
func (m *Masker) emitEFrame(payload []byte) []byte {
	raw, err := base64.StdEncoding.DecodeString(string(payload))
	if err != nil {
		out := make([]byte, 0, len(eFrameHead)+len(payload))
		out = append(out, eFrameHead[:]...)
		return append(out, payload...)
	}
	enc := base64.StdEncoding.EncodeToString([]byte(MaskText(string(raw))))
	out := make([]byte, 0, len(eFrameHead)+len(enc))
	out = append(out, eFrameHead[:]...)
	return append(out, enc...)
}

// tokenPrefix token 前缀模板 sc[a-z]_：第 3 位小写字母通配
var tokenPrefix = [...]byte{'s', 'c', 0, '_'}

// isTokenPrefix 判断 data（长度 <4）是否为 sc[a-z]_ 前缀的真前缀
// （跨 Write 分片等待判定用：'s' / 'sc' / 'sc?' 均真）
func isTokenPrefix(data []byte) bool {
	for i := range data {
		if i == 2 {
			if !isLower(data[i]) {
				return false
			}
			continue
		}
		if data[i] != tokenPrefix[i] {
			return false
		}
	}
	return true
}

// hasBytePrefix 判断 data 是否以 pattern 开头；data 短于 pattern 时判断其为
// pattern 的真前缀与否（跨分片等待判定用）
func hasBytePrefix(data, pattern []byte) bool {
	n := len(pattern)
	if len(data) < n {
		n = len(data)
	}
	for i := 0; i < n; i++ {
		if data[i] != pattern[i] {
			return false
		}
	}
	return true
}

func isLower(b byte) bool { return b >= 'a' && b <= 'z' }

func isTokenValueByte(b byte) bool {
	return isLower(b) || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// isWordByte 词字节（\b 词边界判定；ASCII 定义与全量正则一致）
func isWordByte(b byte) bool { return isTokenValueByte(b) || b == '_' }

// isAssignSpace 赋值分隔符空白（模式② [ \t]*；RE2 \s 同款 ASCII 集）
func isAssignSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\f' || b == '\r'
}

// isAssignValueByte 赋值裸值字符（模式② [^\s"']+：空白与引号外任意字节，
// 含 '=' 与控制字节——与全量正则同语义）
func isAssignValueByte(b byte) bool { return !isAssignSpace(b) && b != '"' && b != '\'' }

// isCloudKeyByte 云密钥值段字符（模式③ [A-Z0-9]，大写敏感）
func isCloudKeyByte(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// equalFoldASCII ASCII 大小写不敏感比较（键名匹配用；键名集纯 ASCII）
func equalFoldASCII(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x >= 'A' && x <= 'Z' {
			x += 'a' - 'A'
		}
		if y >= 'A' && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}
