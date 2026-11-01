import { ref } from 'vue'
import type { OscEvent } from './useTerminalSession'

// 运行书序贯执行器（P-20261004-13 onFailure 语义）。
// P-24 的「发送」是插入不执行（回车由人按）；本执行器提供显式触发的「运行」：
// 各步骤命令 + \r 写入终端真正执行，序贯推进。
// - onFailure = 'continue'（默认）：连续发送（间隔 CONT_SEND_GAP_MS），不阻塞等退出码——
//   现状语义；退出码仍经 D 帧异动回填各步状态（失败标红，只是不拦截）
// - onFailure = 'stop'：单飞行逐条发送，等 OSC 133 D 帧（退出码，与 useTerminalOscBridge
//   同源事件流）——非 0 即停在失败项（UI 高亮 + 「从失败项继续」入口）
//   - 无 shell 集成环境（整轮未见任何 C/D 帧）：首条等待超时后降级为连续发送并置
//     degraded（诚实注记——无退出码判据，不再虚报逐条失败判定）
// - 命令超时上限：队头 CMD_TIMEOUT_MS 无 D 帧到达视为完成（防卡死；长任务不阻序列）
// 状态归属：sentQueue 按发送序记录待判定步骤，D 帧命令文本（E 帧解码）与队头不一致
// 的（前序超时命令的迟到帧 / 人工命令）不消费——避免错位标色。一次只允许一本运行书
// 在跑（单实例状态），重复 start 直接替换；执行器经宿主注入的 write 回调写终端
// （paneRefs.writeInput），会话不可写（tab 关闭/断连）如实停在该步

export type RunbookStepRunState = 'pending' | 'running' | 'done' | 'failed'

/** 运行态 phase：running 连续推进中 / awaitingExit 等退出码中（面板同视为运行中）/
 *  failed 停在失败项 / stopped 用户停止或会话不可写 / finished 全部跑完 */
export type RunbookRunPhase = 'running' | 'awaitingExit' | 'failed' | 'stopped' | 'finished'

export interface RunbookRunState {
  bookId: string
  sessionId: string
  onFailure: 'continue' | 'stop'
  // 已插值的待执行命令（面板负责 {参数} 展开）
  commands: string[]
  states: RunbookStepRunState[]
  cursor: number
  failedIndex: number // -1 = 无
  degraded: boolean
  phase: RunbookRunPhase
}

/** 面板 → 宿主的运行请求（命令插值是面板域，执行器只收现成命令串）。
 *  扩展点注记（P-20261004-17，本轮不做）：agent 走 API 执行运行书时，参数应以
 *  JSON 字段（如 params: Record<name,value>）随请求提供、服务端完成同一套插值——
 *  当前运行链是纯前端终端写入（无服务端执行端点），面板表单即其人工等价物 */
export interface RunbookRunRequest {
  bookId: string
  commands: string[]
  onFailure: 'continue' | 'stop'
  fromIndex: number
}

// 等待退出码超时上限（任务书风险注记：无帧到达视为完成，防卡死）
const CMD_TIMEOUT_MS = 30_000
// continue / 降级模式的连续发送间隔：给 shell 吞行留缝（同粘贴多行语义，缓冲按序执行）
const CONT_SEND_GAP_MS = 350
// 双挂接去重窗口：同会话双 WS 渲染时同一 D 事件各达一次（与 useTerminalOscBridge 同思路）
const D_DEDUP_MS = 1000

export function useRunbookRunner(write: (sessionId: string, data: string) => boolean) {
  const run = ref<RunbookRunState | null>(null)

  // 发送节流计时（continue/降级模式推进 cursor 用）
  let advanceTimer: ReturnType<typeof setTimeout> | null = null
  // 队头退出码等待计时（两种模式都挂：stop 阻塞推进，continue 只回填状态）
  let resolveTimer: ReturnType<typeof setTimeout> | null = null
  // 待判定步骤栈（发送序 FIFO）：D 帧逐个消头的归属依据
  let sentQueue: number[] = []
  // 本轮是否见过任何 C/D 帧（shell 集成在位判据，降级判定用）
  let sawFrame = false
  let lastDKey = ''
  let lastDTs = 0

  function clearTimers(): void {
    if (advanceTimer) {
      clearTimeout(advanceTimer)
      advanceTimer = null
    }
    if (resolveTimer) {
      clearTimeout(resolveTimer)
      resolveTimer = null
    }
  }

  /** stop 模式且未降级：单飞行，等队头退出码才推进 */
  function useAwait(): boolean {
    const r = run.value
    return !!r && r.onFailure === 'stop' && !r.degraded
  }

  function armResolveTimer(): void {
    if (resolveTimer) clearTimeout(resolveTimer)
    resolveTimer = setTimeout(onResolveTimeout, CMD_TIMEOUT_MS)
  }

  function start(req: RunbookRunRequest, sessionId: string): void {
    clearTimers()
    sawFrame = false
    sentQueue = []
    const from = Math.max(0, Math.min(req.fromIndex, req.commands.length - 1))
    run.value = {
      bookId: req.bookId,
      sessionId,
      onFailure: req.onFailure,
      commands: [...req.commands],
      states: req.commands.map(() => 'pending' as const),
      cursor: from,
      failedIndex: -1,
      degraded: false,
      phase: 'running',
    }
    sendCurrent()
  }

  /** 发送 cursor 指向的步骤；stop+未降级走单飞行等待分支，否则按节流推进 */
  function sendCurrent(): void {
    const r = run.value
    if (!r) return
    r.phase = 'running'
    if (r.cursor >= r.commands.length) {
      r.phase = 'finished'
      return
    }
    if (!write(r.sessionId, r.commands[r.cursor]! + '\r')) {
      // 会话不可写（tab 已关闭 / WS 断开）：如实停在当前步，交面板提示重试
      r.states[r.cursor] = 'failed'
      r.failedIndex = r.cursor
      r.phase = 'failed'
      return
    }
    r.states[r.cursor] = 'running'
    sentQueue.push(r.cursor)
    armResolveTimer()
    if (useAwait()) {
      r.phase = 'awaitingExit'
    } else {
      advanceTimer = setTimeout(() => {
        advanceTimer = null
        r.cursor++
        sendCurrent()
      }, CONT_SEND_GAP_MS)
    }
  }

  /** 队头退出码等待超时：降级判定（仅 stop 模式首条）或视为完成（防卡死） */
  function onResolveTimeout(): void {
    resolveTimer = null
    const r = run.value
    const head = sentQueue[0]
    if (!r || head === undefined) return
    if (!sawFrame && r.onFailure === 'stop' && !r.degraded) {
      // 整轮无任何 C/D 帧 = shell 无集成提示符：降级为连续发送 + degraded 提示。
      // 当前步已发出但无判据，按任务书注记视为完成，余下步骤节流连发
      r.degraded = true
      r.states[head] = 'done'
      sentQueue = []
      r.cursor = head + 1
      sendCurrent()
      return
    }
    // 有集成但超时无 D：命令仍在跑，视为完成继续（迟到 D 经命令文本对账不消费）
    r.states[head] = 'done'
    sentQueue.shift()
    if (sentQueue.length > 0) armResolveTimer()
    if (useAwait() && head === r.cursor) {
      r.cursor = head + 1
      sendCurrent()
    }
  }

  /** D 帧判定队头：回填该步状态；stop 模式据此推进/停失败项 */
  function resolveHead(ev: OscEvent): void {
    const r = run.value
    const head = sentQueue[0]
    if (!r || head === undefined) return
    // 命令文本对不上 = 前序超时命令的迟到 D / 人工命令：不消费，继续等本步
    // （E 帧缺失时 command 为 undefined，退回 FIFO 归属）
    if (ev.command !== undefined && ev.command !== r.commands[head]) return
    if (resolveTimer) {
      clearTimeout(resolveTimer)
      resolveTimer = null
    }
    const exitCode = ev.exitCode ?? 0
    r.states[head] = exitCode === 0 ? 'done' : 'failed'
    sentQueue.shift()
    if (sentQueue.length > 0) armResolveTimer()
    if (exitCode !== 0 && r.failedIndex < head) r.failedIndex = head // continue 也如实标红
    if (useAwait() && head === r.cursor) {
      if (exitCode !== 0) {
        // 停在失败项：cursor 不前进，「从失败项继续」从这步重跑
        if (advanceTimer) {
          clearTimeout(advanceTimer)
          advanceTimer = null
        }
        r.phase = 'failed'
        return
      }
      r.cursor = head + 1
      sendCurrent()
    }
  }

  /** OSC 133 事件入流（宿主 onOscEventSync 转发）：只消费运行会话的非重放 D */
  function onOscEvent(ev: OscEvent, sessionId: string): void {
    const r = run.value
    if (!r || r.sessionId !== sessionId || ev.replayed) return
    if (ev.type === 'C') {
      sawFrame = true
      return
    }
    if (ev.type !== 'D') return
    sawFrame = true
    // 双挂接去重（实例级单槽，同 useTerminalOscBridge 指纹思路）
    const key = `${ev.command ?? ''}|${ev.exitCode ?? 0}|${ev.durationMs ?? 0}`
    const now = Date.now()
    if (key === lastDKey && now - lastDTs < D_DEDUP_MS) return
    lastDKey = key
    lastDTs = now
    resolveHead(ev)
  }

  /** 用户停止：废弃计时器与待判定栈，未决步骤回 pending（「继续运行」从 cursor 重跑） */
  function stop(): void {
    const r = run.value
    if (!r) return
    clearTimers()
    for (const i of sentQueue) {
      if (r.states[i] === 'running') r.states[i] = 'pending'
    }
    sentQueue = []
    r.phase = 'stopped'
  }

  return { run, start, stop, onOscEvent }
}
