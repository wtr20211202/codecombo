import type { IMarker } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'
import { locateQueryInBuffer } from './terminalOutputLocate'

// 命中时间锚记账（P-20261005-202）：跨会话输出检索（P-20261003-290）的命中行
// 只有内容没有时刻——本模块把 OSC 133 命令边界（C/D 帧）时刻落成「输出行区间 →
// 命令记账时刻」的账本，搜索命中行（文本锚反查）落进区间即标注该命令的时刻
//（HistoryEntry.At 的前端等价：命令历史本就由前端在 D 帧到达时上报、服务端盖章
// at，D 解析时刻与服务端 at 差一次 HTTP 往返内，对 1h/今天量级的过滤无差）。
// 区间外命中如实显示「—」——宁缺勿错，与命令块锚点（terminalCommandBlocks）
// 同一哲学。
//
// 行号参照系说明：区间账与命中定位同在「当前 xterm 渲染行」世界内（marker 随
// 裁剪/重排自动跟随；命中行经 locateQueryInBuffer 文本锚反查渲染行号）。服务端
// capture 窗口是逻辑行序（native 环形缓冲按原始换行，ConPTY/PSReadLine 重绘流
// 混杂 cursor 寻址；tmux capture-pane 按捕获时刻列宽），与前端行世界结构性对不上
// （terminalOutputLocate 同结论，实测 hitIndex 恒偏离渲染行号）——故不做行号换算，
// 文本锚是唯一跨后端稳定参照。文本已滚出缓冲/落不进任何区间的命中「—」如实降级；
// 不做就近吸附防误标时刻。

// 单会话区间账本上限：与命令块锚点（MAX_BLOCKS_PER_SESSION=100）同哲学——marker
// 在 xterm 重排时有线性代价；检索窗口（服务端 SearchScanLines=2000 行）内的命中
// 几乎都落在最近 100 条命令的区间里，更早的命中本来就在窗口外
export const MAX_TIMES_PER_SESSION = 100

// 单条命令的输出区间账：startMarker=回显行（输出首行 - 1，搜索命令文本也归入
// 本命令领地）、endMarker=输出末行（D 记账未落行号为 null = 运行中/滞后帧，
// 领地开放到下一条命令的回显行为止）；startedAt/endedAt 为本地 ms。
// marker 为 null/被 xterm 淘汰（onDispose）时整条摘除——区间行号已不可信，
// 命中落那里就该显示「—」
interface CommandTimeEntry {
  startMarker: IMarker
  endMarker: IMarker | null
  startedAt: number
  endedAt: number | null
}

// 会话 → 区间账本（push 序即时间序；onDispose 就地摘除保列表紧致）。pane 卸载/
// LRU 驱逐/接管时经 resetCommandTimes 清账，防残留指向已消亡的 xterm 实例
const sessionCommandTimes = new Map<string, CommandTimeEntry[]>()

/** 在指定渲染行注册 marker（同 recordCommandBlockAnchor 的换算：相对光标偏移）；
 *  行已滚出缓冲顶等注册失败返回 null */
function registerMarkerAt(inst: TermInstance, line: number): IMarker | null {
  const buf = inst.term.buffer.active
  const marker = inst.term.registerMarker(line - (buf.baseY + buf.cursorY))
  if (!marker || marker.line < 0) return null
  return marker
}

/** 摘账：任一「现任」marker 被 xterm 淘汰即整条摘除。旧 marker 因 D 时刻重锚被
 *  换下后其淘汰回调视为过期（引用比对），不再误摘新账 */
function watchMarkerDisposal(sessionId: string, entry: CommandTimeEntry, marker: IMarker): void {
  marker.onDispose(() => {
    const list = sessionCommandTimes.get(sessionId)
    if (!list) return
    const idx = list.indexOf(entry)
    if (idx < 0) return
    if (entry.startMarker !== marker && entry.endMarker !== marker) return
    list.splice(idx, 1)
  })
}

/**
 * C 事件时刻记账：在本段写入 xterm 前调用（紧跟 recordCommandStartLine）。
 * echoLine = 输出首行 - 1（回显行，与命令块锚点同一换算）；调用方须先判定
 * C 行号记账确实建了新账（rec 存在且 endLine 为 null）——起点不可信的账宁可
 * 没有。at 缺省取当下：隐藏 pane 的段在重见重放时才落 buffer，调用方须传
 * 解析时刻（见 useTerminalSession 的 segAt），否则后台 tab 的长命令会盖上
 * 「重见时刻」的错表。
 */
export function noteCommandTimeStart(sessionId: string, echoLine: number, at: number = Date.now()): void {
  if (echoLine < 0) return
  const inst = termInstances.get(sessionId)
  if (!inst) return
  const startMarker = registerMarkerAt(inst, echoLine)
  if (!startMarker) return
  const entry: CommandTimeEntry = { startMarker, endMarker: null, startedAt: at, endedAt: null }
  watchMarkerDisposal(sessionId, entry, startMarker)
  const list = sessionCommandTimes.get(sessionId) ?? []
  list.push(entry)
  while (list.length > MAX_TIMES_PER_SESSION) {
    const stale = list.shift()
    if (stale) {
      try {
        stale.startMarker.dispose()
        stale.endMarker?.dispose()
      } catch {
        /* 已随实例 dispose 的 marker 忽略 */
      }
    }
  }
  sessionCommandTimes.set(sessionId, list)
}

/**
 * D 事件时刻记账：在本段写入 xterm 后调用（紧跟 recordCommandEndLine——tmux
 * 滞后帧下 startLine 的内容重锚已在其内完成，传入的 echoLine/endLine 即终值）。
 * 仅闭合「运行中」账（无运行中账 = 首 prompt 的 D / 重复 D，天然 no-op）；
 * 账内 startMarker 偏离重锚后的回显行则换新 marker（领地收紧到真实回显行），
 * endLine 非空（D 行号落账）时补 endMarker，滞后帧 null 则保持开放领地
 * （到下一条命令的回显行为止）。
 */
export function noteCommandTimeEnd(
  sessionId: string,
  echoLine: number,
  endLine: number | null,
  at: number = Date.now(),
): void {
  const list = sessionCommandTimes.get(sessionId)
  const entry = list?.[list.length - 1]
  if (!entry || entry.endedAt !== null) return
  entry.endedAt = at
  const inst = termInstances.get(sessionId)
  if (!inst) return
  if (echoLine >= 0 && entry.startMarker.line !== echoLine) {
    const reanchored = registerMarkerAt(inst, echoLine)
    if (reanchored) {
      const stale = entry.startMarker
      entry.startMarker = reanchored
      watchMarkerDisposal(sessionId, entry, reanchored)
      try {
        stale.dispose()
      } catch {
        /* 已 dispose 的 marker 忽略（其过期回调不会再摘账） */
      }
    }
  }
  if (endLine !== null) {
    const endMarker = registerMarkerAt(inst, endLine)
    if (endMarker) {
      entry.endMarker = endMarker
      watchMarkerDisposal(sessionId, entry, endMarker)
    }
  }
}

// 命中行文本锚定的最短片段（rune 计）：过短的行文本（"ok"等）在缓冲里到处
// 命中，就近误锚率高——宁缺勿错显示「—」
const ANCHOR_FRAGMENT_MIN = 4

/**
 * 命中行 → 命令记账时刻。命中定位用「行文本锚」而非服务端 hitIndex 行号：
 * capture 窗口逻辑行序（native 环形缓冲按原始换行、ConPTY/PSReadLine 重绘流
 * 混杂 cursor 寻址）与前端按当前列宽软换行的 xterm 行世界结构性对不上
 * （terminalOutputLocate 同结论，实测 hitIndex 恒偏离渲染行号），命中行文本是
 * 跨世界稳定锚——locateQueryInBuffer（P-9 同一实现，相邻行拼接已容忍命中词被
 * 软换行劈开）在 xterm 缓冲中反查命中行，再在渲染行世界里做区间归属。多命中
 * 取自底向上最近一处（P-9 同语义：检索窗口是最近输出，最近一处最接近点选行）。
 * 区间归属：倒序找「回显行 ≤ 命中行 ≤ 输出末行」的命令账（运行中/滞后帧的
 * 开放领地到下一条 start 为止，倒序首条即唯一候选），返回 endedAt ?? startedAt。
 * 无实例（未挂载/LRU 驱逐）、无账本（无 shell 集成/全为重放段）、文本已滚出
 * 缓冲、落不进任何区间（间隙/已被淘汰）返回 null——调用方显示「—」。
 */
export function resolveHitCommandAt(sessionId: string, lineText: string): number | null {
  const list = sessionCommandTimes.get(sessionId)
  // 无账本先短路：文本反查是 O(缓冲) 的字符串拼扫，绝大多数会话没有命令账
  //（无 shell 集成/未挂载），不给他们花锚定开销
  if (!list || list.length === 0) return null
  const inst = termInstances.get(sessionId)
  if (!inst) return null
  // 服务端超长行截窗（SearchLineMax=200）带省略号——剥掉取最长连续片段做锚
  const trimmed = lineText.trim()
  if (trimmed.length < ANCHOR_FRAGMENT_MIN) return null
  let fragment = ''
  for (const part of trimmed.split('…')) {
    if (part.length > fragment.length) fragment = part
  }
  if (fragment.length < ANCHOR_FRAGMENT_MIN) return null
  const hitAbs = locateQueryInBuffer(inst.term, fragment)
  if (hitAbs === null) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]!
    if (entry.startMarker.line > hitAbs) continue
    // 领地上界：endMarker 未落（运行中）= 开放到下一条命令；已落 = 输出末行
    if (entry.endMarker !== null && hitAbs > entry.endMarker.line) break
    return entry.endedAt ?? entry.startedAt
  }
  return null
}

/** 会话账本条数（诊断/单测用） */
export function commandTimeCount(sessionId: string): number {
  return sessionCommandTimes.get(sessionId)?.length ?? 0
}

/** 会话释放对账（pane 卸载/驱逐/接管）：先摘表再 dispose marker——onDispose
 *  回调查表早退，无重复摘除（resetCommandBlocks 同口径） */
export function resetCommandTimes(sessionId: string): void {
  const list = sessionCommandTimes.get(sessionId)
  if (!list) return
  sessionCommandTimes.delete(sessionId)
  for (const entry of list) {
    try {
      entry.startMarker.dispose()
      entry.endMarker?.dispose()
    } catch {
      /* 已随实例 dispose 的 marker 忽略 */
    }
  }
}

// ── 时间档过滤纯函数（浮层「全部/最近 1h/今天/自定义起止」共用语义）──

export type OutputTimeFilter = 'all' | '1h' | 'today' | 'custom'

/** 自定义起止（datetime-local 原文，空串 = 该侧开放） */
export interface OutputTimeCustom {
  start: string
  end: string
}

/** 时间档 → [fromMs, toMs]（null 边界 = 该侧开放）；'all' 返回 null 表示不过滤。
 *  「今天」取本地时区当日零点起（三平台一致走本地钟，与历史面板 toLocaleTimeString
 *  同一钟系）；自定义侧非法/空值按该侧开放处理，不因半填区间整体失效 */
export function outputTimeRange(
  filter: OutputTimeFilter,
  now: number,
  custom: OutputTimeCustom,
): { fromMs: number | null; toMs: number | null } | null {
  if (filter === 'all') return null
  if (filter === '1h') return { fromMs: now - 60 * 60 * 1000, toMs: null }
  if (filter === 'today') return { fromMs: new Date(now).setHours(0, 0, 0, 0), toMs: null }
  const parse = (v: string): number | null => {
    if (!v) return null
    const t = new Date(v).getTime()
    return Number.isFinite(t) ? t : null
  }
  return { fromMs: parse(custom.start), toMs: parse(custom.end) }
}

/** 时刻是否落在档位内（range 为 null = 不过滤恒真；无锚时刻由调用方先行折叠） */
export function inOutputTimeRange(
  at: number,
  range: { fromMs: number | null; toMs: number | null } | null,
): boolean {
  if (!range) return true
  if (range.fromMs !== null && at < range.fromMs) return false
  if (range.toMs !== null && at > range.toMs) return false
  return true
}
