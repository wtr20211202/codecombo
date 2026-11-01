import type { Terminal } from '@xterm/xterm'
import { termInstances } from './useTerminalInstances'

// 跨会话输出检索的会话内定位（P-20261005-9）：P-290 点选命中只切会话不定位
// （MVP 自认边界）——本模块补「落点+高亮」最后一公里。定位锚是查询词文本而非
// 行号：服务端命中行号是 capture 窗口内的逻辑行序（native 环形缓冲按原始行 /
// tmux capture-pane 按捕获时刻列宽折行），前端 xterm 按当前列宽软换行，两侧
// 行世界结构性对不上；查询词子串在各侧行内恒存在，是唯一跨后端稳定的锚。
// 纯视口层（scrollToLine + 选区高亮），不写 PTY 字节流——与 terminalBookmarks
// 同族纪律，输出/复制/命令历史零污染。

/** 在 xterm 缓冲中定位查询词（大小写不敏感子串，与 /api/terminals/search 的
 * strings.Contains(lower,needle) 同语义），返回所在缓冲行号；未命中返回 null。
 * 取「自缓冲底部向上最近一次命中」= 最近输出优先：服务端扫描窗口（最近 2000 行）
 * 内的命中几乎总落在最近输出一侧，多命中（重复报错刷屏）时最近一处最接近
 * 用户点选的那条。相邻行拼接后整段扫描：长行软换行把命中词拆在两行的情况
 * （服务端一行 → 前端两视行）也能定位，命中起点反查所在行。 */
export function locateQueryInBuffer(term: Terminal, query: string): number | null {
  const needle = query.toLowerCase()
  if (!needle) return null
  const buf = term.buffer.active
  const rows: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    rows.push(line ? line.translateToString(true) : '')
  }
  // 行起点偏移表 + 无分隔符拼接：一次 lastIndexOf 定位最近命中，再线性回扫
  // 偏移表反查所在行（缓冲 ≤ 数千行，一次性定位非热路径，单遍扫掠即可）
  const offsets: number[] = []
  let joined = ''
  for (const text of rows) {
    offsets.push(joined.length)
    joined += text
  }
  const at = joined.toLowerCase().lastIndexOf(needle)
  if (at < 0) return null
  for (let i = offsets.length - 1; i >= 0; i--) {
    if ((offsets[i] ?? 0) <= at) return i
  }
  return null
}

/** 命中行落点：滚动定位 + 整行选区高亮。选区起点 (0,row)、长度取该行 cell 数
 * ——xterm 选区按 cell 几何取值，宽字符/制表符下行内偏移与 JS 串下标不互等，
 * 整行选择是天然免换算的高亮面（查询词必在该行内）。越界钳制同 scrollToBookmark。 */
export function landTerminalOutputLocate(term: Terminal, row: number): void {
  const buf = term.buffer.active
  const clamped = Math.min(Math.max(0, row), Math.max(0, buf.length - 1))
  term.scrollToLine(clamped)
  const line = buf.getLine(clamped)
  if (line) term.select(0, clamped, line.length)
}

// ── 待定位请求的消费调度 ──
// 跳转链（切项目/开面板/激活 tab/pane 连接）与 scrollback 重放全异步，定位请求
// 发出时目标实例往往尚未就绪。轮询消费吸收全部时序：tab v-show 保活已连接的
// 场景首轮即落点；跨项目冷挂载场景等实例登记 + 重放落定。落定判定 = 实例在场
// 且缓冲非空、写链空闲、长度连续 SETTLE_TICKS 轮不变——重放分帧流式到达期间
// 每帧都过写链（pendingWrites>0），写链清空且缓冲停涨才敢下「未命中」结论，
// 否则半截重放会被误判成「已滚出缓冲」。终态超时是慢网大缓冲的兜底，同走
// 缺席口径（「已不在滚回缓冲内」对两种成因都成立，不说破成因即诚实）。
const POLL_MS = 150
const SETTLE_TIMEOUT_MS = 8000
const SETTLE_TICKS = 2

export interface TerminalOutputLocateHooks {
  /** 落点完成（已滚动 + 选区高亮） */
  onLand?: (row: number) => void
  /** 缓冲落定后仍无命中行（滚出上限被裁 / 被清屏）或等落定超时 */
  onMissing?: () => void
}

export interface TerminalOutputLocateOptions {
  pollMs?: number
  timeoutMs?: number
}

// 单槽在途请求：连点两条命中时后到者胜（同会话重复定位无意义，异会话以最后
// 点选为准）——前序轮询即刻作废，不会落到后台 pane 上做出滑稽的高亮
let activeToken = 0

/** 发起定位：返回取消函数（宿主卸载/新请求时调用；单槽机制下通常无需手调） */
export function requestTerminalOutputLocate(
  sessionId: string,
  query: string,
  hooks: TerminalOutputLocateHooks = {},
  opts: TerminalOutputLocateOptions = {},
): () => void {
  const pollMs = opts.pollMs ?? POLL_MS
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS
  const token = ++activeToken
  const startedAt = Date.now()
  let lastLen = -1
  let stableTicks = 0
  let sawInstance = false

  const timer = setInterval(() => {
    if (token !== activeToken) {
      clearInterval(timer)
      return
    }
    const inst = termInstances.get(sessionId)
    if (!inst) {
      // 实例曾在场又消失（pane 关闭/被接管重挂）：目标面已不在，静默作废
      // ——会话终了场景跳转链自有 toast，这里不叠第二层提示
      if (sawInstance) {
        activeToken++
        clearInterval(timer)
      }
      return
    }
    sawInstance = true
    const row = locateQueryInBuffer(inst.term, query)
    if (row !== null) {
      activeToken++
      clearInterval(timer)
      landTerminalOutputLocate(inst.term, row)
      hooks.onLand?.(row)
      return
    }
    const len = inst.term.buffer.active.length
    const idle = (inst.pendingWrites ?? 0) === 0
    stableTicks = len > 0 && idle && len === lastLen ? stableTicks + 1 : 0
    lastLen = len
    if (stableTicks >= SETTLE_TICKS || Date.now() - startedAt >= timeoutMs) {
      activeToken++
      clearInterval(timer)
      hooks.onMissing?.()
    }
  }, pollMs)

  return () => {
    if (token === activeToken) activeToken++
    clearInterval(timer)
  }
}
