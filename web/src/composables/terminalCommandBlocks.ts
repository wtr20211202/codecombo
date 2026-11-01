import type { IMarker } from '@xterm/xterm'
import { termInstances } from './useTerminalInstances'

// 命令块锚点与跳过导航（P-20261003-269）：OSC 133 C 帧（命令开始）时刻把「回显行」
// （提示符 + 命令，两种 shell 时序归一见 useTerminalSession.recordCommandStartLine）
// 记为命令块起点——块区间 = prompt 到下一 prompt，长输出命令块间的掠读导航即在这
// 些锚点间跳转。xterm registerMarker 随 scrollback 裁剪/行数抖动重排自动跟随行号，
// 与命令成败装饰（terminalCommandMarks）同一锚定机制；纯视口操作（scrollToLine），
// 不写 PTY 字节流，输出/复制/命令历史零污染。无 shell 集成的会话没有 C 帧，本模块
// 不被触达，快捷键零响应——降级现状（提案自身设计含降级）。

// 单会话锚点上限：与装饰（MAX_MARKS_PER_SESSION=50）同哲学——数组本身轻量，但
// 无上限的 marker 会在 xterm 重排（resize/折行变化）时线性放大代价；钳最近 100 块
// （导航面覆盖数十屏滚动缓冲，足够掠读用）。滚出 scrollback 上限的行，xterm 依
// marker 裁剪自动连带 dispose（onDispose 就地摘除引用保列表紧致）
export const MAX_BLOCKS_PER_SESSION = 100

// 会话 → 命令块锚点（push 序即块序；dispose 摘除后仍近似保序）。pane 卸载/接管
// 时经 resetCommandBlocks 清账，防跨重挂残留指向已消亡的 xterm 实例
const sessionBlocks = new Map<string, IMarker[]>()

/**
 * C 事件锚点记账：在回显行注册命令块起点 marker。由 useTerminalSession 的
 * recordCommandStartLine 在本段写入 xterm 前调用（此刻光标行即回显行或其下一行，
 * shell 时序已归一），echoLine = C 记账的输出首行 - 1。越界（缓冲顶无回显行）与
 * marker 注册失败静默跳过——少一个导航锚点无害，宁缺勿错
 */
export function recordCommandBlockAnchor(sessionId: string, echoLine: number): void {
  const inst = termInstances.get(sessionId)
  if (!inst || echoLine < 0) return
  const buf = inst.term.buffer.active
  if (echoLine > buf.length - 1) return
  const marker = inst.term.registerMarker(echoLine - (buf.baseY + buf.cursorY))
  if (!marker || marker.line < 0) return
  const blocks = sessionBlocks.get(sessionId) ?? []
  blocks.push(marker)
  marker.onDispose(() => {
    const list = sessionBlocks.get(sessionId)
    if (!list) return
    const idx = list.indexOf(marker)
    if (idx >= 0) list.splice(idx, 1)
  })
  while (blocks.length > MAX_BLOCKS_PER_SESSION) blocks.shift()?.dispose()
  sessionBlocks.set(sessionId, blocks)
}

/**
 * 跳过导航：跳到下一（dir=1）/上一（dir=-1）命令块起点并滚动定位。无锚点返回
 * false（无 shell 集成降级现状——快捷键不响应）；有锚点返回 true（滚动即反馈）。
 *
 * 参照系 = 当前视口顶行（viewportY）：掠读场景用户已滚到长输出中间，以视口顶为
 * 「当前位置」才能定义下一/上一。定位形态 = scrollToLine(锚点行 - 1)（命令行落在
 * 视口第二行，上一行留一点上文便于辨认）；命中判定据此错开一行——
 * - 下一块：首个锚点行 > 视口顶 + 1（视口顶本身压着的命令行视为已读，跳过）
 * - 上一块：最后一个锚点行 < 视口顶
 * 两条规则与 -1 定位互为补偿：连按 next/prev 严格逐块推进、往返回到原块，不会
 * 停在同一锚点上打转。越界兜底：下一块耗尽 → 回到活跃提示符（scrollToBottom，
 * 「下一个 prompt」即当前空闲提示符）；上一块耗尽 → 回到会话顶（scrollToTop）
 */
export function scrollCommandBlock(sessionId: string, dir: 1 | -1): boolean {
  const inst = termInstances.get(sessionId)
  if (!inst) return false
  const lines = (sessionBlocks.get(sessionId) ?? [])
    .map(m => m.line)
    .filter(l => l >= 0)
    .sort((a, b) => a - b)
  if (lines.length === 0) return false
  const term = inst.term
  const viewport = term.buffer.active.viewportY
  if (dir > 0) {
    const target = lines.find(l => l > viewport + 1)
    if (target === undefined) {
      term.scrollToBottom()
      return true
    }
    term.scrollToLine(Math.max(0, target - 1))
    return true
  }
  let target = -1
  for (const l of lines) {
    if (l >= viewport) break
    target = l
  }
  if (target < 0) {
    term.scrollToTop()
    return true
  }
  term.scrollToLine(Math.max(0, target - 1))
  return true
}

/** 会话锚点数（诊断/单测用；重连重放段不记账，重连后仅新命令重建锚点） */
export function commandBlockCount(sessionId: string): number {
  return (sessionBlocks.get(sessionId) ?? []).filter(m => m.line >= 0).length
}

/** 会话释放对账（pane 卸载）：先摘表再 dispose marker——onDispose 回调查表
 *  早退，无重复摘除；重挂接管场景旧锚点指向旧实例，清除后由新会话重建 */
export function resetCommandBlocks(sessionId: string): void {
  const blocks = sessionBlocks.get(sessionId)
  if (!blocks) return
  sessionBlocks.delete(sessionId)
  for (const m of blocks) {
    try {
      m.dispose()
    } catch {
      /* 已随实例 dispose 的 marker 忽略 */
    }
  }
}
