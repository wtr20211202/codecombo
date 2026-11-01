import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { useTerminalThemeStore } from '../stores/terminal-theme'
import { useFontStore } from '../stores/font'
import { useLockStore, getUnlockToken, applyLockRejection, LOCK_REJECTED_CLOSE_CODE } from '../stores/lock'
import { WS_CLOSE_MESSAGE_TOO_BIG, WS_CLOSE_INTERNAL_ERROR, WS_LONG_BACKOFF_DELAY_MS } from './useWebSocketBase'
import { useI18n } from './useI18n'
import { forceTerminalScrollResync } from '../utils/terminalScrollResync'
import { termInstances, safeFit, disposeInstance } from './useTerminalInstances'
import { terminalLru } from './terminalLru'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { createOscFrameReassembler, createOscEventSink, concatBytes, parseOsc7Cwd, type OscEvent, type OscWriteSegment } from './terminalOscFrames'
import { createDeferredWriteQueue } from './terminalDeferredWrites'
import { createTerminalWithAddons } from './useTerminalAddons'
import { attachTerminalKeyHandlers, type TerminalKeyAction } from './useTerminalKeys'
import { GIT_PANEL_AUTO_REFRESH, isGitWriteCommand } from './useGitPanelAutoRefresh'
import { markCommandOutcome, resetCommandMarks } from './terminalCommandMarks'
import { recordCommandBlockAnchor, resetCommandBlocks, scrollCommandBlock } from './terminalCommandBlocks'
import { noteCommandTimeStart, noteCommandTimeEnd, resetCommandTimes } from './terminalCommandTimes'
import { bufferLineFromPointer, resetBookmarks } from './terminalBookmarks'
import {
  TERMINAL_PENDING_WRITE_LIMIT,
  createWriteStormTracker,
} from './terminalWriteBackpressure'

// OSC 133 帧处理纯函数、addon 装配与快捷键接线已按区块拆出
// （P-20261002-27 巨型组件拆分第二批：terminalOscFrames / useTerminalAddons /
// useTerminalKeys），此处 re-export 保持既有导入面（测试与消费方零改动）：
export {
  stripOSC133,
  parseOscEvents,
  splitPendingTail,
  findDFrameBoundaries,
  createOscFrameReassembler,
  createOscEventSink,
  normalizeOsc7Path,
  parseOsc7Cwd,
} from './terminalOscFrames'
export type { OscEvent, OscWriteSegment, OscFrameReassembler } from './terminalOscFrames'
export { createDeferredWriteQueue, MAX_DEFERRED_WRITE_BYTES, MAX_DEFERRED_WRITE_SEGS } from './terminalDeferredWrites'
export { createWebglContextLossHandler } from './useTerminalAddons'
export type { WebglContextLossActions } from './useTerminalAddons'

// 重连配置（与旧 useTerminalWs 保持一致）
export const MAX_RECONNECT_ATTEMPTS = 5
export const RECONNECT_BASE_DELAY = 2000

// 未读点亮闸的附着稳定窗（P-20261003-310）：R 哨兵后等待此时长才开始点亮——
// 盖过 attach 序列的自发字节（tmux refresh-client 整屏重绘 / conpty resize 重绘）
export const TERMINAL_UNREAD_SETTLE_MS = 1200
const ATTACH_SETTLE_MS = TERMINAL_UNREAD_SETTLE_MS

// 模块级编码器复用——避免每条 WS message 都 new TextEncoder
// （解码器随 OSC 帧解析移至 terminalOscFrames）
const sharedEncoder = new TextEncoder()

// 服务端只读闸拒绝码（P-20261008-17）：终端 WS 的 PTY 输出恒为 BinaryMessage，
// TextMessage 整类是服务端控制帧（JSON）；本码是 {type:"input_rejected"} 帧的
// code 字段稳定契约（服务端 api/terminal wsInputRejectFrame 同名对账，定向
// e2e 断言钉死）。接管会话（origin=external）默认只读的服务端闸拒绝绕过前端
// 锁的程序化写入——前端 pane 锁定时不发输入，正常使用不会见到本帧
export const TERMINAL_WS_REJECT_READONLY_EXTERNAL = 'readonly_external'

/** 终端 WS 文本控制帧解析：TextMessage = 控制帧（JSON），非 JSON 文本按旧
 * 字节链路处理（前向兼容，不消费）。返回 null = 非控制帧 */
function parseTerminalControlFrame(data: unknown): { type: string; code?: string } | null {
  if (typeof data !== 'string' || !data.startsWith('{')) return null
  try {
    const parsed = JSON.parse(data) as { type?: unknown; code?: unknown }
    if (parsed && typeof parsed.type === 'string') {
      return { type: parsed.type, code: typeof parsed.code === 'string' ? parsed.code : undefined }
    }
  } catch { /* 非 JSON 文本帧：不当控制帧 */ }
  return null
}

// 只读闸拒绝 toast 去重（按会话 4s 一条——服务端已 1s 防抖，多 pane 同会话
// 与 agent 灌输入场景再压一档，不刷屏）。message/t 由调用方传入：useMessage/
// useI18n 必须在组件 setup 上下文调用，WS onmessage 回调里注入会失败
const lastReadonlyRejectToastAt = new Map<string, number>()
function maybeToastReadonlyReject(
  sessionId: string,
  message: ReturnType<typeof useMessage>,
  t: (key: string) => string,
): void {
  const now = Date.now()
  if (now - (lastReadonlyRejectToastAt.get(sessionId) ?? 0) < 4000) return
  lastReadonlyRejectToastAt.set(sessionId, now)
  // 何时展示：接管会话服务端只读闸拒绝了本连接的输入帧（agent 直调写链被拒
  // 时人正好盯着的 pane），提示解锁路径
  message.warning(t('terminal.inputLock.rejectedServer'))
}

// 已收到过服务端输出的会话集合：writeTermDataDirect 是全部 WS 字节的唯一汇入点，
// 在此记账。供「纯 SFTP 主机无 shell → 终端长时间无输出」的延迟提示判定
// （远程控制台开终端后 N 秒仍零输出才提示，shell 正常时不再弹出无效安抚），
// 会话 dispose 时移除防跨重挂误判
const sessionsWithOutput = new Set<string>()

/** 该会话自创建起是否收到过任何服务端字节（终端输出） */
export function terminalHasReceivedOutput(sessionId: string): boolean {
  return sessionsWithOutput.has(sessionId)
}

// 上一条命令输出区间的行号记账（按会话隔离）：C（命令开始）时刻的内容尾行 +
// D（命令结束）时刻的内容尾行，供「复制上一条命令输出」右键项做区间提取
// （useTerminalClipboard.extractLastCommandOutput）与成败装饰锚定
// （terminalCommandMarks.markCommandOutcome 同源消费）。endLine=null 表示命令
// 运行中（C 已达、D 未达），提取终点取复制时的实时内容尾。dispose 时移除防
// 跨重挂残留。
// 内容尾 = baseY + cursorY（滚动偏移 + 视口内光标行）：buffer.length 含预分配的
// 尾部空白行，短缓冲下 length-1 远大于实际内容尾（实测踩坑）
interface CommandOutputLines {
  startLine: number
  endLine: number | null
  // C 记账时刻的提示符代数（见 commandPromptGen）：提取时代数已增长说明本条命令
  // 之后提示符已重渲染，提取区间须钳制到提示符行之前（D 记账的 endLine 所指的
  // 「输出后空行」会被下一条提示符占用，见 getCommandOutputPromptClamp）
  startPromptGen: number
  // 命令文本（E 帧盖章回 D 事件）：tmux 滞后帧下 D 时刻 buffer 可能未含全部
  // 回显 cell，startLine 的内容重锚在提取时刻（buffer 已稳定）以本文本重做
  command: string
}
const commandOutputLines = new Map<string, CommandOutputLines>()

// 提示符代数记账（按会话隔离）：每见一枚非重放的 A 帧（prompt 开始）或 R 哨兵
// （重放边界=重放内容尾即当前提示符行）自增一次。D 帧丢失（写入背压丢帧）或
// 重放段的 D 被门禁跳过（重放段不记账）时 endLine 不落账——活动尾兜底会把
// 命令之后渲染的下一条提示符整行扫进复制区间（fulle2e run6/run7 实测形态：
// 剪贴板 = 输出行 + "PS ...> "）。A/R 记账只增计数不读光标，端点在提取时以
// 当时光标行-1 解析（shell 空闲时光标恒停在提示符行上）
const commandPromptGen = new Map<string, number>()

/** 光标所在的内容绝对行号（滚动偏移 + 视口内行） */
function cursorContentLine(sessionId: string): number | null {
  const inst = termInstances.get(sessionId)
  if (!inst) return null
  const buf = inst.term.buffer.active
  return buf.baseY + buf.cursorY
}

/** C 事件记账：输出首行。必须在本段写入 xterm 之前调用。两种 shell 时序归一：
 *  - PowerShell 在 Enter 处理器里先发 C 再渲染回车换行——光标仍停在「提示符+命令」
 *    行（非空行），输出从下一行起；
 *  - bash 的 DEBUG trap 在 readline 回显换行之后触发——光标已落在新空行上，
 *    输出从光标行起。
 *  以光标行是否为空行区分两者。同时清 endLine 开新命令周期：旧 D 行号失效，
 *  运行中命令以实时内容尾为提取终点 */
export function recordCommandStartLine(sessionId: string): void {
  const cursorLine = cursorContentLine(sessionId)
  if (cursorLine === null) return
  const inst = termInstances.get(sessionId)
  if (!inst) return
  const line = inst.term.buffer.active.getLine(cursorLine)
  const onEchoLine = !!line && line.translateToString(true).trim() !== ''
  const startLine = onEchoLine ? cursorLine + 1 : cursorLine
  commandOutputLines.set(sessionId, {
    startLine,
    endLine: null,
    startPromptGen: commandPromptGen.get(sessionId) ?? 0,
    command: '',
  })
}

/** D 事件记账：内容尾行 = 光标行（输出先于 D 帧到达；输出常以换行收尾，光标停在
 *  输出后的空行——区间提取的尾空行裁剪兜底）。必须在本段写入 xterm 之后调用。
 *  仅补齐 endLine（startLine 未记账——会话首个 prompt 的 D、重放段首条等无 C
 *  边界场景——不建账：起点未知，宁可不复制也不误复制整屏）；endLine 已有值
 *  （C 之后 prompt 渲染的 D 已落账、用户 Ctrl+C 取消输入未发 C）不覆盖，
 *  保持最近一条真实命令的区间。
 *  tmux 后端例外（P-20261004-82）：passthrough OSC 帧滞后于 cell 更新转发
 *  （WSL tmux 3.4 实测 5ms 级，帧到时光标被同批重绘的定位序列锚在中间态），
 *  C/D 时刻的光标读数都不可信——endLine 落在回显侧中间态时（< startLine）不
 *  硬记，交提取侧实时内容尾 + 提示符钳制兜底；startLine 一律以「回显头行 +
 *  折行数」重锚：自 D 时刻光标行向上找命令首片段（输出一般不含命令头，回显
 *  行必含），回显占用行数 = 提示符列 + 命令长度对列宽的折行，输出首行 =
 *  回显末行 + 1。native 后端（Windows ConPTY / unix 直连 PTY）字节序与帧序
 *  一致，未回绕场景重锚结果与 C 锚点一致，行为零变化 */
export function recordCommandEndLine(sessionId: string, command?: string): void {
  const rec = commandOutputLines.get(sessionId)
  if (!rec || rec.endLine !== null) return
  rec.command = (command ?? '').trim()
  // startLine 内容重锚须在 endLine 记账前完成（reanchorCommandStart 只上不移）
  reanchorCommandStart(sessionId, rec)
  const cursorLine = cursorContentLine(sessionId)
  if (cursorLine === null) return
  if (cursorLine >= rec.startLine) {
    rec.endLine = cursorLine
  }
  // endLine 未落账 = tmux 滞后帧（D 时刻光标停在回显侧中间态）——不硬记，
  // 提取侧实时内容尾 + 提示符钳制兜底
}

/** 读取上一条命令输出的行号记账（无记账返回 undefined）——区间提取用 */
export function getLastCommandOutputRecord(sessionId: string): CommandOutputLines | undefined {
  return commandOutputLines.get(sessionId)
}

// 命令回显头扫描（纯函数）：自 fromLine 向上 maxRows 行窗内找含命令头片段的
// 回显行。命中判定分两档——严格命中 = 片段出现列 idx>0 且前一字符是提示符字符
// （/#$%>，即「提示符+命令」形态，防输出正文里的同文误锚），即刻返回；宽松命中
// = 行内任意位置（首次即记，跨头长只记首个），全部头长无严格命中时兜底返回。
// 头片段自长到短尝试（长提示符下命令回绕会把片段劈在两行，短片段更易整行命中）。
// 供 reanchorCommandStart（tmux 滞后帧重锚）与重放失败恢复（P-20261006-37 的
// tryRestoreReplayFailedMark）共用——两者同构：在「光标读数不可信」的 buffer 上
// 按命令文本重找回显行
export function scanCommandHead(
  getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined,
  command: string,
  fromLine: number,
  maxRows: number,
): { row: number; col: number } | null {
  let fallbackRow = -1
  let fallbackCol = -1
  // 回显头不可能在锚点上方超过一条命令的回显高度（60 行窗足够）；再往上即
  // 上一条命令的领地，误中会吞输出
  const scanTop = Math.max(0, fromLine - maxRows)
  for (const headLen of [24, 16, 10, 6, 4]) {
    const head = command.slice(0, headLen)
    if (head.length < 3) continue
    for (let i = fromLine; i >= scanTop; i--) {
      const line = getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      const idx = text.indexOf(head)
      if (idx < 0) continue
      if (idx > 0 && /[#$%>]/.test(text.charAt(idx - 1))) {
        return { row: i, col: idx }
      }
      if (fallbackRow < 0) {
        fallbackRow = i
        fallbackCol = idx
      }
    }
  }
  if (fallbackRow < 0 || fallbackCol < 0) return null
  return { row: fallbackRow, col: fallbackCol }
}

/** startLine 内容重锚（tmux 滞后帧兜底，两种后端统一）：C 时刻把「回显首行 + 1」
 *  记为输出首行，但长提示符下命令回绕时回显占多行，C 光标行 + 1 会落在回绕行，
 *  把回显续行扫进输出区间（Linux 实测剪贴板多出回绕行）。按「回显头行 + 折行数」
 *  重锚：自 C 锚点行向上找命令头片段（输出一般不含命令头，回显行必含），折行数
 *  = (提示符列 + 命令长度 − 列宽) / 列宽 向上取整，输出首行 = 回显末行 + 1。
 *  扫描仅在结果比现锚点更靠下时生效（= 排除了回显续行）；native 未回绕场景两
 *  锚点一致，零变化。D 时刻 buffer 可能尚未含全部回显 cell（帧滞后），提取侧
 *  须以本函数在稳定 buffer 上重做一次 */
export function reanchorCommandStart(sessionId: string, rec: CommandOutputLines): void {
  const trimmed = rec.command
  if (trimmed.length < 3) return
  const inst = termInstances.get(sessionId)
  if (!inst) return
  const buf = inst.term.buffer.active
  const anchor = Math.min(Math.max(rec.startLine - 1, 0), buf.length - 1)
  const hit = scanCommandHead((i) => buf.getLine(i), trimmed, anchor, 60)
  if (!hit) return
  const cols = Math.max(1, inst.term.cols)
  const echoLen = hit.col + trimmed.length
  const wrapRows = Math.max(0, Math.ceil((echoLen - cols) / cols))
  const reanchored = hit.row + 1 + wrapRows
  if (reanchored > rec.startLine) rec.startLine = reanchored
}

/**
 * 提示符行钳制端点：本条命令开始之后提示符已重渲染（A 帧或 R 哨兵使代数增长）
 * 时返回「当前光标行 - 1」——shell 空闲时光标停在提示符行上，其上一行即输出
 * 内容尾。这是「复制上一条命令输出」区间的硬上限：D 记账的 endLine 取的是
 * D 帧处理时的光标行 = 输出后的空行，而下一条提示符恰好渲染在该行上——按行号
 * 提取时该行已是提示符文本，区间会整行扫进剪贴板（fulle2e run6/run7 实测形态：
 * 剪贴板 = 输出行 + "PS ...> "；本地探针抓得 rec endLine=提示符行实证）。
 * 旧「尾空行裁剪」只在提示符尚未渲染/行仍为空时侥幸成立。命令运行中（提示符
 * 未重渲染，代数未增）返回 null 不钳制；无记账返回 null
 */
export function getCommandOutputPromptClamp(sessionId: string): number | null {
  const rec = commandOutputLines.get(sessionId)
  if (!rec) return null
  const gen = commandPromptGen.get(sessionId) ?? 0
  if (gen <= rec.startPromptGen) return null
  const cursorLine = cursorContentLine(sessionId)
  if (cursorLine === null) return null
  return cursorLine - 1
}

/** 非重放 A 帧 / R 哨兵到达：提示符重渲染（或重放内容尾=提示符行）——代数自增。
 *  在写入路径按段检查（enqueueWriteMessage），只增计数不读光标 */
export function bumpCommandPromptGen(sessionId: string): void {
  commandPromptGen.set(sessionId, (commandPromptGen.get(sessionId) ?? 0) + 1)
}

export interface UseTerminalSessionParams {
  // 本会话标识（同时是共享 termInstances Map 的 key，
  // 供 TerminalView 侧 selectTab / fitAllPanes 等按 id 查找实例）
  sessionId: string
  // WS 地址构造：项目终端传 getTerminalWsUrl，远程终端传远程版
  wsUrlFactory: (sessionId: string) => string
  // 字号 / scrollback 行数（连接时读取最新值）
  getFontSize: () => number
  getScrollbackLines: () => number
  // OSC 133 事件外抛——tab 运行状态与长任务通知由宿主（TerminalView）处理
  oscHook?: (event: OscEvent, sessionId: string) => void
  // 底层会话退出（重连预算耗尽）——宿主决定后续（关 tab / 标记）
  onExit?: (sessionId: string) => void
  // xterm 快捷键接线（搜索 / 复制 / 粘贴）
  onSearchOpen: () => void
  onCopySelection: (sessionId: string) => void
  onPaste: (sessionId: string) => void
  // 右键菜单打开（bufferLine = 右键命中的缓冲绝对行号，P-20261004-16「标记此行」
  // 的目标行——解析失败为 undefined，菜单不含行级动作）
  onContextMenu: (sessionId: string, e: MouseEvent, bufferLine?: number) => void
  // tab 编排快捷键（可选，未注册时快捷键不拦截）
  onSplitHorizontal?: () => void
  onSplitVertical?: () => void
  onClosePane?: () => void
  onSwitchTab?: (delta: number) => void
  onSwitchToTab?: (index: number) => void
  // pane 焦点切换（P-20261004-111，可选）：返回 true = 已切换（键位拦截），
  // false/未注册 = 放行 PTY（单 pane 保终端原语义）——经 ...params 直传
  // attachTerminalKeyHandlers
  onFocusOtherPane?: (sessionId: string) => boolean
  // 命令块跳过导航（P-20261003-269，可选）：上一/下一命令块起点跳转——纯视口
  // 操作不依赖宿主上下文，未注入时走本 composable 的共享实现 scrollCommandBlock
  onPrevCommandBlock?: () => void
  onNextCommandBlock?: () => void
  // 终端域键位读取（P-20261003-111，透传 attachTerminalKeyHandlers）：返回 keymap
  // 生效表对应动作的组合键，改绑即时生效；缺省用出厂默认
  comboOf?: (action: TerminalKeyAction) => string
  // 原生粘贴接管（P-20261024-2）：普通 Ctrl/Cmd+V 在 useTerminalKeys 放行原生 paste
  // 事件，本回调在其上挂 document capture paste 监听（可选）——文本直贴/截图上传/
  // 文件上传贴路径三分支
  attachNativePaste?: (textarea: HTMLTextAreaElement, sessionId: string) => () => void
  // resize 上报（必传注入）：项目终端传 terminalApi.resize 等价实现，远程终端传各自实现
  resizeCall: (sessionId: string, rows: number, cols: number, silent: boolean) => void
  // 窗格只读观察锁（P-20261003-91）：返回 true 时键盘/粘贴输入不写 WS（PTY 无回滚，
  // 旁观/演示场景防误触）。每次 onData 现场读取——锁定切换对已连接 pane 即时生效，
  // 输出方向（PTY→xterm）与选区/复制不受影响
  isInputLocked?: () => boolean
  // 写链路背压风暴落定自愈的权威重绘注入（P-20261004-47）：与 pane 可见性自愈
  // 同一条 redrawCall——项目终端走 terminalApi.redraw（tmux refresh-client 以服务端
  // 网格重发整屏，native 服务端 no-op），远程终端走远程 redraw 端点。未注入时
  // 自愈退化为纯本地重绘重同步
  redrawCall?: (sessionId: string) => void
  // pane 可见性（P-20261004-46）：返回 false 时输出帧不入 xterm（解析渲染的
  // CPU 大头），入有界延迟队列，重见时 flushPendingWrites 一次性重放。每次
  // 写入现场读取——可见性切换即时生效。未传 = 恒可见（行为同旧，测试/复用零负担）
  isVisible?: () => boolean
  // 高危命令粘贴预检闸门（P-20261005-191）：onData 收口处对每个 chunk 现跑
  // （纯本地正则，键入逐字符天然 miss，零常规开销）。命中返回 true = 本 chunk
  // 交由闸门接管（确认卡裁决后才发送），false = 走既有直发路径。未传 = 不预检
  inputGate?: (sessionId: string, data: string) => boolean
  // 输入域历史采集缝（P-20261005-188，可选）：onData 收口在写入 WS 前截获
  // 按键流（observe-only：不返回、不拦截、不改写数据）。仅远程终端注入——
  // 无 shell integration 域的采集退路，行缓冲回车分条记「提交的输入行」。
  // 经 inputGate 接管的 chunk（确认卡裁决后经 sendRawToSession 直发）不经本
  // 缝，不记。未传 = 不采集（项目终端走 OSC 133 输出侧精确域）
  inputTap?: (sessionId: string, data: string) => void
}

// 单个终端会话的连接生命周期：xterm 实例创建 + WS 连接/重连 + OSC 133 处理。
// 从旧 useTerminalWs（View 级多 tab 管理）抽取为单会话粒度，由 TerminalPane 持有；
// tabs 状态更新（running/lastExitCode）与长任务通知经 oscHook / onExit 外抛给宿主。
export function useTerminalSession(params: UseTerminalSessionParams) {
  const { sessionId } = params
  const terminalThemeStore = useTerminalThemeStore()
  // 光标形态/闪烁偏好（P-20261005-212）：connect 创建期读取最新值（运行期随动
  // 由 useTerminalInstances / TerminalPane 的 watch 直写 options 承接）
  const fontStore = useFontStore()
  const lockStore = useLockStore()
  const sessionsStore = useTerminalSessionsStore()
  const { t } = useI18n()
  // WebGL 降级 toast：与其他终端 composable 同款 useMessage（Naive UI provider 子树内）
  const message = useMessage()

  // 连接中（驱动 pane 内 loading spinner，语义同旧 tab.loading 的显示部分）
  const connecting = ref(true)
  // 重连失败超限（驱动 pane 内「后端不可用」浮层）
  const failed = ref(false)
  // WS 已断开（含自动重连退避期）：驱动 pane 内「立即重连」浮层；onopen 撤销
  const disconnected = ref(false)

  // 断档检测（P-20261005-233）：lastOutputAt=最近一次收到本会话服务端字节的
  // 本地时刻（headless 驱逐期照常记账，WS 死亡即冻结=断开前最后输出时刻）；
  // reconnectGapAnchor=重连 onopen 时冻结的比对锚点快照——仅重连附着有值
  // （首次附着无「断开前」可言；G 帧自身也是收到的字节，不冻结快照会被
  // 「当下时刻」污染成恒缺口），由重放流首段的 G 帧一次性消费
  let lastOutputAt: number | null = null
  let reconnectGapAnchor: number | null = null

  // 重放段最近失败命令（P-20261006-37 重挂恢复）：重放 D 事件的 exitCode/command
  // 字段与光标无关、可靠；行号区间不可信（Windows ConPTY 的重放是绝对定位整屏
  // 重绘流，replayed C/D 帧解析时刻的光标被 \x1b[H 重绘钉在任意行——实测记账
  // 出 {0,0} 垃圾区间）。故不在段循环即时记账，暂存此处，待 R 哨兵（重放边界）
  // 后在稳定 buffer 上按命令文本重锚（tryRestoreReplayFailedMark）——内容重锚与
  // tmux 滞后帧的 reanchorCommandStart 同哲学。后到失败覆盖前者 =「最近一次失败」
  // 语义（与 lastFailed 同口径）；connect() 清空（新附着由重放重新收集），
  // 注册成功/会话释放即消费
  let replayFailedPending: { command: string; exitCode: number } | null = null
  let restoreFailedMarkTimer: ReturnType<typeof setTimeout> | null = null

  // 图片粘贴监听 detach（连接时挂载，dispose 时解除——旧实现从不解除会跨重挂载累积）
  let imagePasteDetach: (() => void) | null = null
  // 本 composable 实例持有的 xterm 实例（connect 时赋值）：dispose 时作所有权
  // 凭据传给 disposeInstance——会话被后挂接的 pane 接管后，旧 pane 卸载不得
  // 清理接管者的现役实例
  let ownedTerm: Terminal | null = null

  // LRU 驱逐态（P-20261007-21）：headless = 渲染层（xterm 实例）已按预算释放、
  // WS 保留走轻量事件管线（未读点/运行态/cwd 通知不断流）；evictedWs = 驱逐期
  // 保留的现役 socket——重挂 connect / 卸载 dispose 时收编关闭，防双附着泄漏
  // （termInstances 条目已摘，connect 的既有接管守卫够不到这根 socket）
  let headless = false
  let evictedWs: WebSocket | null = null

  // resize 上报：由宿主注入（项目终端 terminalApi.resize / 远程终端各自实现）
  const reportResize = params.resizeCall

  // resize 上报串行链：最大化/还原、面板拖拽会高频产生 resize，HTTP 请求各自
  // 独立在途时到达顺序不保证——后算出的尺寸先到、先算的后到，服务端 PTY 最终
  // 停在旧尺寸而 xterm 已是新尺寸，tmux 按旧尺寸持续绘制即整屏错乱且不自愈
  // （最大化/最小化后乱屏的根因）。串行化保证发送序 = 计算序：上一单落地才发
  // 下一单，服务端相同尺寸去重后终态必为最新值
  let resizeChain: Promise<void> = Promise.resolve()
  function queueResize(rows: number, cols: number, silent: boolean): void {
    resizeChain = resizeChain
      .then(() => reportResize(sessionId, rows, cols, silent))
      .catch(() => { /* 单次 resize 失败不破坏链路 */ })
  }

  // 统一构造 terminal WebSocket：附加 unlock token 子协议（内存态，P-20261019-2）
  // 锁定中间件在握手期校验 token；内存缺省（刷新后）由同源 cookie 兜底，
  // 无 token 则连接被拒
  function makeTerminalWs(): WebSocket {
    const url = params.wsUrlFactory(sessionId)
    const token = getUnlockToken()
    return token ? new WebSocket(url, [token]) : new WebSocket(url)
  }

  // OSC 133 帧跨 message 重组器：E 帧超 4096 字节必分片，重组后统一 parse/strip
  const oscReassembler = createOscFrameReassembler()

  // git 面板自动刷新感知（P-20261003-74）：D 事件携带命令文本且命中写类白名单时
  // 派发窗口事件，GitBranchesSection/CommitPanel 经 useGitPanelAutoRefresh 去抖拉取。
  // 所有终端面（底部项目终端 / agent 会话 pane）统一经本收口——服务端 git.command
  // 广播只覆盖 execGit 失败路径，终端里的命令是 PTY shell 子进程，服务端不可见。
  // 失败 D 同样派发：复合命令（git add -A && git commit）失败时前段已改索引；
  // 重放段跳过（重连重放不得触发刷新）。已知边界：TUI 运行时（claude/codex）内部
  // 子进程调 git 不产生 OSC 133，不在感知范围
  function notifyGitPanelsOnWriteCommand(ev: OscEvent): void {
    if (ev.type !== 'D' || ev.replayed || !ev.command) return
    if (!isGitWriteCommand(ev.command)) return
    window.dispatchEvent(new CustomEvent(GIT_PANEL_AUTO_REFRESH))
  }

  // 事件语义管线（命令记账/重放门禁/失败 D 延后外抛）抽至 terminalOscFrames
  const oscSink = createOscEventSink({
    sessionId,
    oscHook: (ev, sid) => {
      notifyGitPanelsOnWriteCommand(ev)
      params.oscHook?.(ev, sid)
    },
  })

  // 写链路背压风暴的落定自愈（P-20261004-47）：丢弃帧可能携带光标定位/色彩/
  // 备屏切换序列，风暴平息后 xterm 屏态与 PTY 真实屏偏离且用户无线索。落定
  // （链排空 + 静默窗）后一次性重同步；丢帧计数（inst.droppedWrites，跨重连
  // 保留）供设置·终端·背压诊断面观测。episode 判定收口在 createWriteStormTracker
  // （terminalWriteBackpressure.ts，单测覆盖计数/去抖/重入风暴）
  const writeStorm = createWriteStormTracker({
    onSettle: (droppedInEpisode) => {
      const inst = termInstances.get(sessionId)
      if (!inst) return
      inst.stormHeals = (inst.stormHeals ?? 0) + 1
      // 一 episode 一条 warn：风暴事后可考（丢弃本身保持静默不刷控制台）
      console.warn(
        `[terminal] write backpressure: dropped ${droppedInEpisode} frame(s) during output storm, resyncing screen (session ${sessionId})`,
      )
      // ① 服务端权威重绘：tmux 后端 refresh-client 以服务端网格重发整屏（内容+
      // 光标+备屏态），把丢帧偏离的屏态拉回 PTY 真实屏；native 后端服务端 no-op
      // （丢帧内容客户端不可恢复，只做下方渲染层自愈）；远程终端走远程 redraw
      // 端点——与 pane 可见性自愈同一条注入，零新协议
      try {
        params.redrawCall?.(sessionId)
      } catch { /* 自愈尽力而为，失败不破坏写链 */ }
      // ② 本地渲染层自愈：整视口重绘 + 滚动区尺寸强制重同步——xterm v6 视口
      // 失步（渲染尺寸/滚动区缓存停在陈旧值）是「风暴后疑似花屏/滚轮失灵」的
      // 渲染侧来源；行数抖动 resize 与拖窗口完全同链路，终态尺寸不变
      try {
        inst.term.refresh(0, Math.max(inst.term.rows - 1, 0))
      } catch { /* ignore */ }
      forceTerminalScrollResync(inst.term)
    },
  })

  // 统一写入入口：把字节流写入 xterm
  // 隐藏 pane 写入延迟队列（P-20261004-46）：term.write 的流解析 + cell 更新 +
  // 渲染是后台会话的 CPU 大头，多会话并行盯输出时随全部会话总输出线性扩展。
  // 不可见 pane 的帧字节入队（有界，超限丢最旧保末屏），激活时一次性重放；
  // OSC 133/7 事件解析与记账不入门控（见 enqueueWriteMessage 段循环），命令
  // 历史 / cwd 追踪 / 未读点亮的数据链不因延迟断流
  const deferredWrites = createDeferredWriteQueue()

  // 统一写入入口：把字节流写入 xterm。会话级记账（输出过标记 / 未读点亮）不
  // 在此做——隐藏 pane 不经过本函数，记账上移到段循环（每段必经）
  function writeTermDataDirect(data: Uint8Array): void {
    const inst = termInstances.get(sessionId)
    if (!inst) return
    inst.term.write(data)
  }

  // 段解析时刻（P-20261005-202）：命中时间锚的命令 At 取「D 帧解析到」的本地
  // 时刻，但隐藏 pane 的段要等重见重放才过 writeSegmentNow——直接在记账点取
  // Date.now() 会给后台 tab 的长命令盖上「重见时刻」的错表。段循环解析出段时
  // 就地盖章（WeakMap 随段对象消亡，无界积压无虞），延迟路径照带原时刻
  const segAt = new WeakMap<OscWriteSegment, number>()

  // 断档标记行判定（P-20261005-233）：段内含 G 帧时一次性消费比对锚点——
  // earliestAt（现存缓冲最早行时间，服务端钟）晚于「断开前最后输出时刻」
  // ⇒ 断线窗口内环形缓冲发生过淘汰，已见内容与重放起点之间有缺口，返回标记
  // 行字节（由调用方前插到本段写入流：缺口处=重放起点）。标记语义上属于输出
  // 流（导出/复制随之带走，留档完整性自明），与 OSC 133 行号记账无涉——标记
  // 位于一切重放内容与记账之前，重连后行号体系相对新 buffer 重建，无跨代错位。
  // 比对换算到服务端钟系：anchor（本地钟读数）+
  // (serverNowAt − 收到时刻) ≈ anchor 的服务端钟读数——跨机部署时钟偏差会把
  // 无淘汰误判成缺口，不做校准则重连即误报。返回 null 的情形：非重连附着
  // （无锚点）/ 无 G 帧 / 不可解析（0 值）/ 未淘汰——短断线零标记（精确判定
  // 不误报）；tmux 后端服务端本就不发 G 帧，天然零标记
  function takeGapMarkerBytes(events: OscEvent[]): Uint8Array | null {
    const gap = events.find((ev) => ev.type === 'G')
    if (!gap) return null
    const anchor = reconnectGapAnchor
    reconnectGapAnchor = null
    if (anchor === null || !gap.earliestAt) return null
    const skewMs = gap.serverNowAt ? gap.serverNowAt - Date.now() : 0
    if (gap.earliestAt <= anchor + skewMs) return null
    return sharedEncoder.encode(`\x1b[33m⟨ ${t('terminal.disconnectGapMarker')} ⟩\x1b[0m\r\n`)
  }

  // 单段「缓冲依赖」管线：C/D 行号记账与成败装饰都读 xterm 光标/buffer，必须
  // 与本段字节的真实写入同刻执行。可见路径即时调用；隐藏路径随队列在重见时
  // 重放（届时 buffer 已追平，记账语义与实况一致）。失败 D 外抛不在内——
  // tab 状态/长任务通知等消费方均不读 buffer，外抛留在段循环即时做（隐藏期
  // 通知不积压）
  function writeSegmentNow(seg: OscWriteSegment): void {
    // 段解析时刻（见 segAt 注）：C/D 记账的时刻表，延迟重放路径照带原时刻
    const segAtMs = segAt.get(seg) ?? Date.now()
    // C 边界行号记账在写入前：C 帧后的回车换行与输出尚未上屏（PowerShell
    // 时序），记账语义见 recordCommandStartLine。重放段（133;R 哨兵前解析到）
    // 的 C 不记账——重放窗是服务端 scrollback 的重发，Windows ConPTY 的重放
    // 字节更是「绝对定位整屏重绘流」而非时间序回放（实测 replayed C 帧解析
    // 时刻光标被 \x1b[H 重绘钉在任意行），行号记账只对 live 流可信；重放恢复
    // 走 R 哨兵后的内容重锚（见 scheduleReplayFailedMarkRestore）
    if (seg.events.some((ev) => ev.type === 'C' && !ev.replayed)) {
      recordCommandStartLine(sessionId)
      // 命中时间锚（P-20261005-202）：紧随 C 行号记账——此刻 rec 已是本条命令
      // 新账（recordCommandStartLine 建账失败时残留旧账 endLine 非空，守卫跳过），
      // 回显行 = 输出首行 - 1
      const rec = commandOutputLines.get(sessionId)
      if (rec && rec.endLine === null) noteCommandTimeStart(sessionId, rec.startLine - 1, segAtMs)
    }
    writeTermDataDirect(seg.write)
    // D 边界行号记账在写入后：输出先于 D 帧到达，此刻内容尾 = 输出末行。
    // 重放段的 D 同样不记账（同上——重放段光标读数不可信）。命令文本（E 帧
    // 盖章回 D 事件）供 tmux 滞后帧的内容锚定兜底（见 recordCommandEndLine）
    const segD = seg.events.find((ev) => ev.type === 'D' && !ev.replayed)
    if (segD) {
      // 新命令周期判定须在 recordCommandEndLine 之前取账：首 prompt 的 D 无 C 记账
      // （rec 不存在）与同一周期的重复 D（endLine 已落账）都不算，防重复锚点
      const blockRec = commandOutputLines.get(sessionId)
      const freshCycle = !!blockRec && blockRec.endLine === null
      recordCommandEndLine(sessionId, segD.command)
      // 命令块锚点（P-20261003-269）：D 时刻注册（P-150 成败装饰同刻同法）——此刻
      // 回显行已稳定（输出先于 D 帧到达；tmux 滞后帧下 C 时刻光标读数不可信，
      // startLine 已按「回显头行 + 折行数」重锚），锚点行 = 重锚后输出首行 - 1 =
      // 回显行（提示符+命令）。tmux 滞后致 endLine 未落账时 startLine 重锚已完成，
      // 锚点照记（装饰走 150ms 延迟兜底，导航锚点无此依赖）。重放段不入（segD 已滤）
      if (freshCycle) {
        const rec = commandOutputLines.get(sessionId)
        if (rec) {
          recordCommandBlockAnchor(sessionId, rec.startLine - 1)
          // 命中时间锚（P-20261005-202）：闭合运行中账——At 取 D 解析时刻
          //（HistoryEntry.At 的前端等价：命令历史由前端在 D 到达时上报、服务端
          // 盖章 at，两者差一次 HTTP 往返内）；区间终值用重锚后的回显行与 endLine
          noteCommandTimeEnd(sessionId, rec.startLine - 1, rec.endLine, segAtMs)
        }
      }
    }
    // 提示符重渲染感知（A 帧非重放 / R 哨兵=重放内容尾）：提示符代数自增，
    // 供「复制上一条命令输出」的提示符行钳制（见 bumpCommandPromptGen /
    // getCommandOutputPromptClamp）
    if (seg.events.some((ev) => ev.type === 'R' || (ev.type === 'A' && !ev.replayed))) {
      bumpCommandPromptGen(sessionId)
    }
    // 命令成败装饰（P-20261003-150）：D 帧退出码 × C/D 行号记账区间 → 成功绿/
    // 失败红装饰行（xterm DOM 覆盖层，不写 PTY 字节流，输出零污染），失败命令
    // 另记会话级记录供右键「交给 agent 修」。重放段不记（同行号记账口径——
    // 重放段光标读数不可信，见上；重挂恢复走 R 后内容重锚）。无 shell 集成的
    // 会话没有 D 帧，天然零变化。失败 D 事件直接取 seg.events 原始对象——
    // sink 已在事件上盖章 command/replayed，与 takePendingFailure 的副本字段
    // 一致（外抛已在段循环即时完成，此处只补装饰）
    const dEvent = seg.events.find((ev) => ev.type === 'D' && !ev.replayed)
    if (dEvent && !dEvent.replayed) {
      const markRec = commandOutputLines.get(sessionId)
      if (markRec && markRec.endLine !== null) {
        markCommandOutcome(sessionId, dEvent.exitCode ?? 0, dEvent.command, markRec)
      } else if (markRec) {
        // tmux 滞后帧：endLine 未落账（D 时刻光标不可信），延迟到重绘批
        // 收尾后再注册——届时提示符已渲染，光标行 - 1 即输出末行
        const deferredStart = markRec.startLine
        setTimeout(() => {
          const line = cursorContentLine(sessionId)
          if (line === null || line < deferredStart) return
          markCommandOutcome(sessionId, dEvent.exitCode ?? 0, dEvent.command, {
            startLine: deferredStart,
            endLine: line - 1,
          })
        }, 150)
      }
    }
  }

  // 重放隐藏期积压帧：一次性 drain。无事件的连续段（隐藏期输出的大头，纯输出
  // 无 OSC 帧）合并单次 write 重放——「恢复时一次性 write」的量级保障，write
  // 调用数从段数收敛到「带帧段数 + 1」；带帧段单独走 writeSegmentNow，保行号
  // 记账/装饰锚定与实况路径逐段同刻
  function drainDeferredWrites(): void {
    const segs = deferredWrites.drain()
    if (segs.length === 0) return
    let batch: Uint8Array[] = []
    let batchBytes = 0
    const flushBatch = (): void => {
      if (batch.length === 0) return
      if (batch.length === 1) {
        writeTermDataDirect(batch[0]!)
      } else {
        const merged = new Uint8Array(batchBytes)
        let off = 0
        for (const part of batch) {
          merged.set(part, off)
          off += part.length
        }
        writeTermDataDirect(merged)
      }
      batch = []
      batchBytes = 0
    }
    for (const seg of segs) {
      if (seg.events.length === 0) {
        batch.push(seg.write)
        batchBytes += seg.write.length
        continue
      }
      flushBatch()
      writeSegmentNow(seg)
    }
    flushBatch()
  }

  // 激活入口（pane 重见时宿主调用）：把重放挂到写链尾，与在途 WS 消息的段处理
  // 严格串行——行号记账与写入序的全序都建立在 writeChain 之上，flush 不得旁路。
  // drain 后补一次重放失败恢复（P-20261006-37）：隐藏 pane 的重放字节在此刻才
  // 落 buffer，R 哨兵时的 250ms 定时恢复会落空，重见 flush 是第二触发点
  function flushPendingWrites(): void {
    const inst = termInstances.get(sessionId)
    if (!inst || deferredWrites.length === 0) return
    inst.writeChain = inst.writeChain
      .then(() => drainDeferredWrites())
      .then(() => { tryRestoreReplayFailedMark() })
      .catch(() => { /* 单次重放失败不破坏链路 */ })
  }

  // —— LRU 驱逐（P-20261007-21）：释放渲染层、保数据链 ——
  // 内存大头是 xterm 实例（行 buffer 拉满 ≈40MB/会话），后台 tab 用户看不见，
  // 是可丢弃的渲染层缓存副本：dispose term + 摘 termInstances 条目即可，会话
  // 与服务端缓冲零变化（native readLoop 无条件写 scrollback / tmux 会话独立
  // 存活），重见时 connect() 经服务端 scrollback 重放恢复。WS 保留换 headless
  // 接线：未读点亮（P-310）/运行态/长任务通知/cwd 的轻量管线照常——驱逐对
  // 用户零可见的关键，后台 tab 的未读点不因驱逐失灵。
  // 与在途 write 的竞态守卫：deferred 队列就地作废；writeChain 在途任务经
  // termInstances.get 守卫自然 no-op（Map 条目已摘，无第二消费者）
  function evict(): void {
    const inst = termInstances.get(sessionId)
    if (!inst) return
    if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer)
    inst.detachContextMenu?.()
    inst.resizeObserver.disconnect()
    const ws = inst.ws
    if (ws.readyState === WebSocket.CONNECTING) {
      // 半开 socket 无簿记价值，且其重放到达时旧 handler 已被换下、
      // closeHistoryGate 无人调用，重放帧会被误记为活命令——直接关闭走静默
      // 路径（重挂 connect 自会建新连接拿全量重放）
      try {
        ws.close()
      } catch { /* ignore */ }
      headless = false
    } else {
      headless = true
      evictedWs = ws
      // 旧 handler 闭包持有已 dispose 的 term（onclose 重连分支的 term.write /
      // onopen 重连分支的 term.reset 都会炸），必须整体替换——消息只走轻量
      // 管线，字节不落任何前端缓冲（权威副本在服务端 scrollback）
      ws.onmessage = (event) => {
        // 服务端控制帧（TextMessage，P-20261008-17）：驱逐态连接不驱动 UI，
        // 拒绝帧不落 toast 不落字节（现役连接的 onmessage 负责反馈）
        if (parseTerminalControlFrame(event.data)) return
        consumeHeadless(
          event.data instanceof Blob
            ? event.data.arrayBuffer().then((buf) => new Uint8Array(buf))
            : Promise.resolve(sharedEncoder.encode(event.data)),
        )
      }
      ws.onclose = () => {
        // 链路死亡：簿记暂停（诚实边界，重挂 connect 恢复）。headless 期不做
        // 自动重连——无 term 可渲染，重连重放无从落地；驱逐态的断线在重见时
        // 由 connect 统一重建（重连守卫：inst 已不在 Map，onclose 早退不调度）
        headless = false
        evictedWs = null
      }
      ws.onopen = null
      ws.onerror = null
    }
    inst.term.dispose()
    termInstances.delete(sessionId)
    ownedTerm = null
    deferredWrites.clear()
    // 实例绑定簿记随 dispose 消亡（与 dispose() 同口径）：marker 类状态（命令
    // 块/书签/成败装饰）指向已释放实例必须清簿记；C/D 行号记账在重放后由新
    // 实例重建（重放段不记账的既有门禁保证不污染）；失败记录随会话存活保留
    // （重挂恢复语义，见 resetCommandMarks 注）
    resetCommandBlocks(sessionId)
    resetCommandTimes(sessionId)
    resetBookmarks(sessionId)
    resetCommandMarks(sessionId)
    commandOutputLines.delete(sessionId)
    commandPromptGen.delete(sessionId)
    // 重放失败收集与挂起的恢复定时器随实例消亡（P-20261006-37）：重见重挂的
    // attach 会重新收集重放段，不清会把旧 pending 恢复到新 buffer 的错误锚点
    replayFailedPending = null
    if (restoreFailedMarkTimer !== null) {
      clearTimeout(restoreFailedMarkTimer)
      restoreFailedMarkTimer = null
    }
    // 重见恢复期显示既有 connecting spinner（重挂 connect → onopen 撤销）
    connecting.value = true
  }

  // headless 消费：与 enqueueWriteMessage 段循环的轻量半边同款（事件外抛 /
  // cwd / 未读 / 稳定窗），仅去掉渲染与缓冲依赖段（writeSegmentNow / deferred
  // 队列）——term 已释放，OSC 帧语义链（命令历史/通知/运行态）不因驱逐断流
  function consumeHeadless(dataPromise: Promise<Uint8Array>): void {
    dataPromise
      .then((data) => {
        // 恢复竞态守卫：connect 收编旧 socket 后，驱逐期在途的 Blob 解析不得
        // 再入管线（防与新连接的消息双份记账）
        if (!headless) return
        // 断档检测锚点（P-20261005-233）：驱逐期 WS 仍活，锚点跟随到最后字节
        lastOutputAt = Date.now()
        const { segments } = oscReassembler.push(data)
        for (const seg of segments) {
          oscSink.processEvents(seg.events)
          const cwd = parseOsc7Cwd(seg.write)
          if (cwd) sessionsStore.reportCurrentDir(sessionId, cwd)
          if (seg.events.some((ev) => ev.type === 'R')) scheduleUnreadArm()
          sessionsWithOutput.add(sessionId)
          if (unreadArmed) sessionsStore.markUnread(sessionId)
          const pendingD = oscSink.takePendingFailure()
          if (pendingD) {
            notifyGitPanelsOnWriteCommand(pendingD.event)
            params.oscHook?.(pendingD.event, sessionId)
          }
        }
      })
      .catch(() => { /* 单条消息处理失败不破坏链路 */ })
  }

  // 未读点亮闸：附着/重连时服务端先重放 scrollback 字节缓冲（历史非新活动，
  // 不点亮），重放完后发 OSC 133;R 哨兵（无重放的新会话也发，terminal 侧
  // attach 处理无条件发送）。R 之后还有一个「附着稳定窗」才开门：服务端在
  // 输出回调注册后强制 tmux refresh-client 重发整屏（attach 序列的自发同步
  // 字节），客户端初始 resize 也会触发 conpty 整屏重绘——这些都不是用户
  // 活动，不点亮未读；稳定窗内恰有真输出会被吞（页面刚加载的秒级窗口，
  // 持续输出流随后照常点亮）。重连重放前复位
  let unreadArmed = false
  let armTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleUnreadArm(): void {
    if (armTimer !== null) clearTimeout(armTimer)
    armTimer = setTimeout(() => {
      armTimer = null
      unreadArmed = true
    }, ATTACH_SETTLE_MS)
  }

  // 重放段失败恢复（P-20261006-37）：R 哨兵（重放边界）后延迟一拍，在稳定
  // buffer 上按命令文本重锚重放段最近失败命令并注册装饰+失败记录——「交给
  // agent 修」入口的重挂恢复面。时机三条件：①R 后 250ms——重放定位序列与
  // attach 自发重绘（resize 触发 conpty 整屏重绘等）已消化，光标停在本轮
  // 提示符行；②interval 终点 = 光标行-1（重放内容尾=提示符行，与
  // getCommandOutputPromptClamp 同口径——失败命令之后重放窗内若还有其他命令，
  // 区间偏大属提取端钳制的固有近似）；③起点 = scanCommandHead 找到的回显行+1，
  // 找不到（失败命令被重放窗/清屏序列裁掉）放弃——宁缺勿错，入口置灰回落
  // 重挂前行为，不猜区间。隐藏 pane 场景重放字节尚在延迟队列：本轮 try 落空
  // 后 pending 保留，flushPendingWrites（重见 flush）再试一次。巨量 scrollback
  // 的重放解析若 250ms 未消化完，本轮同样落空（诚实边界：恢复缺席优于错位）
  function scheduleReplayFailedMarkRestore(): void {
    if (restoreFailedMarkTimer !== null) clearTimeout(restoreFailedMarkTimer)
    restoreFailedMarkTimer = setTimeout(() => {
      restoreFailedMarkTimer = null
      tryRestoreReplayFailedMark()
    }, 250)
  }

  // 尝试恢复（幂等）：pending 已消费/无实例/缓冲空/找不到回显行都静默早退，
  // pending 只在装饰+记录注册成功后清空
  function tryRestoreReplayFailedMark(): void {
    const failed = replayFailedPending
    if (!failed || failed.command.length < 3) return
    const inst = termInstances.get(sessionId)
    if (!inst) return
    const buf = inst.term.buffer.active
    // shell 空闲时光标停在提示符行 = 重放内容尾；baseY+cursorY=0 说明缓冲
    // 还没有任何内容（重放未 flush），交由 flush 触发点再试
    const tail = buf.baseY + buf.cursorY
    if (tail <= 0) return
    const hit = scanCommandHead((i) => buf.getLine(i), failed.command, tail - 1, 60)
    if (!hit) return
    replayFailedPending = null
    markCommandOutcome(sessionId, failed.exitCode, failed.command, {
      startLine: hit.row + 1,
      endLine: tail - 1,
    })
  }

  // 把 WS 消息（可能含异步 Blob 读取）串行化写入 xterm
  // 由 onmessage 调用：dataPromise 只负责读字节，事件处理（帧重组 + 解析 + 剥离）在
  // chain 内按消息顺序执行——Blob 读取完成顺序不保证与到达顺序一致，重组器 pending
  // 状态与写入顺序都不能依赖 promise 完成序
  function enqueueWriteMessage(dataPromise: Promise<Uint8Array>): void {
    const inst = termInstances.get(sessionId)
    if (!inst) {
      // 没有实例也要消费 promise，避免 unhandled rejection
      dataPromise.catch(() => {})
      return
    }
    // 写链路背压：输出生产速度长期超过 xterm 渲染消费速度时，挂起的
    // promise 闭包会无界累积（历史实现无上限）。超过上限丢弃本帧输出——
    // 仅影响显示（重新绘制即可恢复），不写入 PTY，不影响 shell 状态。
    // 丢弃不再静默（P-20261004-47）：累计计数进 inst.droppedWrites（诊断面
    // 展示），并喂给风暴追踪器——落定后一次性重同步屏态
    const pending = (inst.pendingWrites ?? 0)
    if (pending > TERMINAL_PENDING_WRITE_LIMIT) {
      dataPromise.catch(() => {})
      inst.droppedWrites = (inst.droppedWrites ?? 0) + 1
      writeStorm.onFrameDropped()
      return
    }
    inst.pendingWrites = pending + 1
    inst.writeChain = inst.writeChain
      .then(() => dataPromise)
      .then((data) => {
        // 断档检测锚点（P-20261005-233）：最近一次收到服务端字节的本地时刻。
        // 每条消息一次（非每段），重连 G 帧比对的是 onopen 冻结的快照不受污染
        lastOutputAt = Date.now()
        // 逐段处理：与可见性无关的轻量管线（事件解析外抛 / cwd / 未读 / 稳定窗）
        // 每段照常——OSC 133/7 数据链不因门控断流；「写入 xterm + 缓冲依赖记账」
        // 这段重活按 pane 可见性分流（P-20261004-46）：可见即时写，隐藏入延迟
        // 队列待重放
        const { segments } = oscReassembler.push(data)
        for (const seg of segments) {
          // 断档标记行（P-20261005-233）：G 帧判得淘汰缺口时把标记行前插到本段
          // 写入流（缺口处=重放起点）。前插不改事件序：G 不参与 C/D 记账与
          // cwd 解析（seg.write 里已无 OSC 字节），标记行是纯文本
          const gapBytes = takeGapMarkerBytes(seg.events)
          if (gapBytes) seg.write = concatBytes(gapBytes, seg.write)
          oscSink.processEvents(seg.events)
          // 重放段最近失败命令收集（P-20261006-37）：replayed D 的 exitCode/command
          // 与光标无关、可靠收集（行号不可信不入账，见 replayFailedPending 注）。
          // 轻量管线收口——隐藏 pane / 延迟重放路径同样收集；R 哨兵处消费重锚
          const replayedD = seg.events.find((ev) => ev.type === 'D' && ev.replayed)
          if (replayedD && (replayedD.exitCode ?? 0) !== 0) {
            replayFailedPending = { command: (replayedD.command ?? '').trim(), exitCode: replayedD.exitCode ?? 0 }
          }
          // OSC 7 cwd 上报（P-20261004-59）：段内旁挂解析（帧字节与 133 同流，
          // seg.write 中 OSC 7 完整在位），最近一帧生效。cd 后的下一条 prompt
          // 即刷新会话 currentDir，文件链接/树定位/驻留徽标据此实时跟随；
          // 无帧（旧 shell）时 store 不写键，消费方回落创建 dir
          const cwd = parseOsc7Cwd(seg.write)
          if (cwd) sessionsStore.reportCurrentDir(sessionId, cwd)
          // R 哨兵 = 重放结束（事件先于本段字节处理）：启动附着稳定窗，
          // 窗后本会话输出才参与未读点亮。时间敏感（稳定窗自 R 起算），不入
          // 延迟重放。重放段失败恢复同刻调度（稳定窗后 buffer 已稳定，
          // scheduleReplayFailedMarkRestore 内部再延迟一拍，见其注）
          if (seg.events.some((ev) => ev.type === 'R')) {
            scheduleUnreadArm()
            scheduleReplayFailedMarkRestore()
          }
          // 会话收过服务端字节记账 + 后台 tab 未读活动点（P-20261003-310）：稳定
          // 窗结束后的首字节点亮（一次性布尔，不计频）。markUnread 对已亮/当前
          // 可见会话早退——高频输出稳态零响应式写入。原在 writeTermDataDirect
          // 内，隐藏 pane 不直写后上移至此（隐藏期输出照常点亮未读点）
          sessionsWithOutput.add(sessionId)
          if (unreadArmed) sessionsStore.markUnread(sessionId)
          // 失败 D 延后外抛：原语义为本段写入后外抛（宿主回调时输出已上屏）。
          // 隐藏 pane 写入被延迟后该等待无界——降级为解析后即外抛：消费方
          // （tab 运行状态 / 长任务通知 / 命令历史 / git 面板刷新 / runbook）
          // 均不读 xterm buffer，通知时效优先于「回调时输出已上屏」的形式语义。
          // 成败装饰所需 D 事件在重放时经 seg.events 原始对象补取（sink 已盖章）
          const pendingD = oscSink.takePendingFailure()
          if (pendingD) {
            notifyGitPanelsOnWriteCommand(pendingD.event)
            params.oscHook?.(pendingD.event, sessionId)
          }
          // 写入分流：不可见入队（有界），可见先清积压再直写——顺序由段循环
          // 的全序保证，队列帧恒先于其后到达的帧上屏
          segAt.set(seg, Date.now())
          if (params.isVisible && !params.isVisible()) {
            deferredWrites.enqueue(seg)
          } else {
            drainDeferredWrites()
            writeSegmentNow(seg)
          }
        }
      })
      .catch(() => {
        /* 单条消息处理失败不破坏整条链 */
      })
      .finally(() => {
        inst.pendingWrites = Math.max((inst.pendingWrites ?? 1) - 1, 0)
        // 风暴落定检测（P-20261004-47）：链排空且本 episode 有丢帧 → 去抖后
        // 一次性自愈；风暴仍在途（pending>0）或无丢弃时为 no-op
        writeStorm.onChainIdle(inst.pendingWrites === 0)
      })
  }

  // 创建并连接终端：实例创建 + addon 装配（createTerminalWithAddons）与快捷键接线
  // （attachTerminalKeyHandlers）已拆至 useTerminalAddons / useTerminalKeys；
  // 本函数负责 open 容器 + 绑定 WS 事件 + ResizeObserver，
  // 并把实例登记进共享 termInstances Map（TerminalView 侧按 id 查找）
  function connect(container: HTMLElement): void {
    // LRU 驱逐后的重挂恢复也从本函数进入（makeTerminalWs + 服务端 scrollback
    // 重放，与网络断线重连同码路径）：先收编驱逐期保留的 socket——headless
    // 管线停摆（防与新连接双份记账），socket 显式关闭防双附着泄漏
    headless = false
    if (evictedWs) {
      const stale = evictedWs
      evictedWs = null
      if (stale.readyState <= WebSocket.OPEN) {
        try {
          stale.close()
        } catch {
          /* 已断开时 close 抛错可忽略 */
        }
      }
    }
    // 新 attach 的门禁/流水线复位：重挂恢复复用本 composable，上一世代的历史
    // 门禁是开着的——不关则本次 attach 的 scrollback 重放被当活命令记账（命令
    // 历史/长任务通知双份）；帧重组器的 pending 半帧来自已终结的旧字节流，
    // 不清则拼花新流首帧。全新 pane 的首连此处均为初值，幂等（与重连路径
    // attachWsHandlers(isReconnect) 的复位项对齐；term.reset 不需要——term
    // 是新实例）
    oscSink.closeHistoryGate()
    unreadArmed = false
    if (armTimer !== null) {
      clearTimeout(armTimer)
      armTimer = null
    }
    // 重放失败收集随新 attach 清零（P-20261006-37）：上一轮未消费的 pending 不
    // 跨附着——本轮重放会重新收集；挂起的恢复定时器一并撤销防旧 buffer 扫描
    replayFailedPending = null
    if (restoreFailedMarkTimer !== null) {
      clearTimeout(restoreFailedMarkTimer)
      restoreFailedMarkTimer = null
    }
    oscReassembler.reset()
    const { term, fitAddon, searchAddon } = createTerminalWithAddons({
      sessionId,
      fontSize: params.getFontSize(),
      scrollback: params.getScrollbackLines(),
      fontStack: terminalThemeStore.currentFontStack,
      themeColors: terminalThemeStore.currentThemeDef.colors,
      cursorStyle: fontStore.cursorStyle,
      cursorBlink: fontStore.cursorBlink,
      onWebglContextLossNotify: () => {
        message.warning(t('terminal.webglContextLost'), { duration: 5000 })
      },
    })
    ownedTerm = term
    // 快捷键拦截：回调集即本 composable 的 params（TerminalKeyHandlers 的结构超集，直传）。
    // 命令块跳过导航（P-20261003-269）缺省走共享视口实现——项目终端/agent 会话/
    // 远程终端全部面零接线生效；宿主显式注入时以宿主为准
    attachTerminalKeyHandlers(term, {
      ...params,
      onPrevCommandBlock: params.onPrevCommandBlock ?? (() => { scrollCommandBlock(sessionId, -1) }),
      onNextCommandBlock: params.onNextCommandBlock ?? (() => { scrollCommandBlock(sessionId, 1) }),
    })

    term.open(container)
    safeFit(fitAddon, container)
    // 双 RAF 补一次（v-show 刚切换时 container 可能未 layout 完）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        safeFit(fitAddon, container)
      })
    })

    // 右键菜单：覆盖浏览器默认菜单，始终打开本系统统一菜单（解除函数挂到实例上，
    // disposeInstance 调用）。tmux 自带右键菜单由服务端在各 tmux 启动路径统一解绑
    // （tmux_conf.go / backend_tmux.go / remotehost_terminal.go），此处不会与之双层同现；
    // claude code 等 TUI 默认不开鼠标上报，右键复制粘贴由本菜单承担
    const onContainerContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // 右键命中的缓冲行即时解析（P-20261004-16「标记此行」）：菜单打开到点击
      // 之间输出可能推进视口，行语义以右键时刻为准；解析失败（元素未就绪等）
      // 传 undefined，宿主菜单按无行级动作渲染
      params.onContextMenu(sessionId, e, bufferLineFromPointer(term, e.clientY) ?? undefined)
    }
    container.addEventListener('contextmenu', onContainerContextMenu)

    // 获取或初始化重连状态
    const instance = termInstances.get(sessionId)
    const reconnectAttempts = instance?.reconnectAttempts || 0

    // 接管旧挂接：同一会话被另一 pane（如底部面板与管理页并存）重复挂接时，
    // 旧 WS 不关闭会导致 PTY 输出扇出双份（oscHook 双触发→命令历史双记账）
    // 且连接泄漏。服务端 WS 断开仅摘除输出回调、会话存活可重附着，因此关闭
    // 旧连接是安全的；旧 pane 的 onclose 经孤儿检查（inst.ws !== wsConn）不会
    // 触发重连。旧实例的未决重连定时器一并清除，防止孤儿重连复活第三条连接
    if (instance?.ws && instance.ws.readyState <= WebSocket.OPEN) {
      try {
        instance.ws.close()
      } catch {
        /* 已断开时 close 抛错可忽略 */
      }
    }
    if (instance?.reconnectTimer) {
      clearTimeout(instance.reconnectTimer)
    }

    const ws = makeTerminalWs()

    attachWsHandlers(ws, term, fitAddon, /* isReconnect */ false)

    term.onData((data) => {
      // 只读观察锁（P-20261003-91）：全部输入路径（键盘 / 原生与右键粘贴 /
      // 拖拽 / 图片粘贴——后三者经 term.paste 同样触发 onData）在此统一收口，
      // 锁定时不写 WS。输出方向与选区复制（attachCustomKeyEventHandler 拦截，
      // 不经 onData）不受影响
      if (params.isInputLocked?.()) return
      const inst = termInstances.get(sessionId)
      if (inst && inst.ws.readyState === WebSocket.OPEN) {
        // 高危命令粘贴预检（P-20261005-191）：命中预筛的 chunk 交由闸门接管
        //（服务端影响面预览 + 确认卡裁决后才发送），未命中/未注入走既有直发
        if (params.inputGate?.(sessionId, data)) return
        // 输入域历史采集（P-20261005-188）：恰在写入前截获——只有真正送达
        // PTY 的按键流才是「提交的输入」（锁定/闸门接管/WS 未开都不算）
        params.inputTap?.(sessionId, data)
        inst.ws.send(data)
      }
    })

    // 闭包内维护最近一次发送的尺寸，避免 fit 抖动时反复触发 PTY resize
    // PowerShell 收到 resize 会重发完整 banner + 整屏重绘，污染 scrollback
    let lastSentCols = 0
    let lastSentRows = 0
    term.onResize(({ rows, cols }) => {
      if (cols < 20 || rows < 2) return
      if (cols === lastSentCols && rows === lastSentRows) return
      lastSentCols = cols
      lastSentRows = rows
      queueResize(rows, cols, /* silent */ true)
    })

    const resizeObserver = new ResizeObserver(() => {
      safeFit(fitAddon, container)
    })
    resizeObserver.observe(container)

    termInstances.set(sessionId, {
      term,
      fit: fitAddon,
      search: searchAddon,
      ws,
      reconnectAttempts,
      reconnectTimer: null,
      resizeObserver,
      writeChain: Promise.resolve(),
      detachContextMenu: () => container.removeEventListener('contextmenu', onContainerContextMenu),
    })

    // LRU 记账（P-20261007-21）：entry 与活实例同生命周期注册（重挂恢复幂等
    // 覆盖）。注册即执行预算——超额时最久未用的隐藏实例在此被驱逐
    terminalLru.register(sessionId, evict)

    // 原生粘贴接管：在 xterm helper textarea 焦点域挂 capture phase paste 监听
    if (params.attachNativePaste && term.textarea) {
      imagePasteDetach = params.attachNativePaste(term.textarea, sessionId)
    }
  }

  // 绑定 WebSocket 事件：初次连接 + 重连共用同一套 handler，避免重复实现。
  // - onopen：重置重连计数 + 清 timer；重连路径下额外 term.reset() 准备接收 scrollback 重放
  // - onmessage：统一走 processShellIntegration（捕获 OSC 133 命令事件 + 剥离序列）
  // - onclose：锁定状态阻止重连，否则指数退避递归重连
  function attachWsHandlers(
    wsConn: WebSocket,
    termInstance: Terminal,
    fit: FitAddon,
    isReconnect: boolean,
  ): void {
    wsConn.onopen = () => {
      connecting.value = false
      // 连接成功即撤销失败态：宿主触发的重连（实例切换/解锁兜底）成功后，
      // 旧 onclose 竞态写入的 failed 残留浮层须随之消失
      failed.value = false
      disconnected.value = false
      const inst = termInstances.get(sessionId)
      if (inst) {
        inst.reconnectAttempts = 0
        if (inst.reconnectTimer) {
          clearTimeout(inst.reconnectTimer)
          inst.reconnectTimer = null
        }
      }
      if (isReconnect) {
        // 断档比对锚点（P-20261005-233）：冻结「断开前最后输出时刻」供重放流
        // 首段的 G 帧一次性比对（快照在此刻之后不被新收字节污染）
        reconnectGapAnchor = lastOutputAt
        // 重置 xterm，准备接收服务端 scrollback 重放；
        // 同时丢弃帧重组器的旧半帧缓冲，防断线残留污染重放流。
        // 历史门禁随之重关：重放段里的 D 事件在本次连接内重新视为重放
        oscSink.closeHistoryGate()
        // 未读点亮闸同步重关：重连后的重放是历史，等 R 哨兵再开稳定窗
        // （同 historyGate 语义）
        unreadArmed = false
        if (armTimer !== null) {
          clearTimeout(armTimer)
          armTimer = null
        }
        termInstance.reset()
        oscReassembler.reset()
        // 延迟队列一并丢弃（P-20261004-46）：服务端将重放完整 scrollback，队列里
        // 的断线前积压帧与之重叠，不清即重放后双份；历史门禁/未读闸已重关，
        // 重放帧按既有重放语义处理
        deferredWrites.clear()
        // 通过 fit() 间接触发 onResize → 仅在尺寸实际变化时调 resize API
        try {
          fit.fit()
        } catch {
          // ignore
        }
      } else {
        // 初次连接：发送初始 resize（拒绝异常小尺寸，避免触发 PowerShell 重发 banner）
        // 断档锚点同步清零（P-20261005-233）：首次附着无「断开前」可言——服务端
        // G 帧仍会到达，无锚点即不标记（全新页面加载/pane 重挂的场景）
        reconnectGapAnchor = null
        const dims = fit.proposeDimensions()
        if (dims && dims.cols >= 20 && dims.rows >= 2) {
          queueResize(dims.rows, dims.cols, /* silent */ false)
        }
      }
      // 连接建立后延迟补一次 fit + 强制重绘：scrollback 重放在连接建立后立刻
      // 到达，此时 xterm v6 滚动区尺寸可能尚未与重放后的 buffer 同步（症状：
      // 首次打开滚轮无法上翻历史，任意按键/resize 后自愈）。重放到达时机
      // 不可控，rAF 补丁未必落在重放之后——再叠一次行数抖动强制滚动区
      // 重同步（与窗口 resize 同链路），把「首次打开上翻失灵」整类治掉
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            fit.fit()
          } catch { /* ignore */ }
          try {
            termInstance.refresh(0, Math.max(termInstance.rows - 1, 0))
          } catch { /* ignore */ }
          forceTerminalScrollResync(termInstance)
        })
      })
    }
    wsConn.onmessage = (event) => {
      // 服务端控制帧（TextMessage 整类，P-20261008-17）：PTY 输出恒为
      // BinaryMessage，文本帧不落 xterm——只读闸拒绝帧展示 toast（agent 直调
      // 写链被拒时人盯着的 pane 有感知），未知控制类型静默消费
      const ctrl = parseTerminalControlFrame(event.data)
      if (ctrl) {
        if (ctrl.type === 'input_rejected' && ctrl.code === TERMINAL_WS_REJECT_READONLY_EXTERNAL) {
          maybeToastReadonlyReject(sessionId, message, t)
        }
        return
      }
      const dataPromise =
        event.data instanceof Blob
          ? event.data.arrayBuffer().then((buf) => new Uint8Array(buf))
          : Promise.resolve(sharedEncoder.encode(event.data))
      enqueueWriteMessage(dataPromise)
    }
    wsConn.onclose = (ev) => {
      // 本连接字节流终止：延迟队列一并作废（P-20261004-46）。须在孤儿检查之前——
      // 接管场景（本会话被后挂接 pane 抢走，Map 已登记接管者的 ws）旧连接 close
      // 时孤儿检查会早退，不清队则旧 pane 重见时把陈旧积压帧写进接管者的现役
      // 实例（重放字节双份）；正常重连场景服务端本就全量重放，先清无损
      deferredWrites.clear()
      const inst = termInstances.get(sessionId)
      if (!inst) return
      // 孤儿 socket（已被手动重连/自动重连替换）：其关闭不得驱动重连逻辑，
      // 否则会与现役连接的重连调度并发，产生双会话双写
      if (inst.ws !== wsConn) return
      // 锁定拒绝（close 4001）：token 已失效，重试必然失败——统一切锁定屏
      // 并停止本会话重连；解锁后由既有解锁兜底恢复会话
      if (ev.code === LOCK_REJECTED_CLOSE_CODE) {
        applyLockRejection()
        disconnected.value = true
        return
      }
      // 消息超限（1009，服务端 P-313 读上限防线）/服务端异常关闭（1011）：同
      // useWebSocketBase 的长退避判——不进常规指数退避（大粘贴→1009→重连→
      // 全量 scrollback 重放的循环放大），终端内明写一行原因（替代「无解释断线」），
      // 固定 60s 单次重连；不计入 attempts（不触发达限 failed 态），重连成功后
      // onopen 归零语义不变
      if (ev.code === WS_CLOSE_MESSAGE_TOO_BIG || ev.code === WS_CLOSE_INTERNAL_ERROR) {
        disconnected.value = true
        const reasonKey = ev.code === WS_CLOSE_MESSAGE_TOO_BIG ? 'terminal.wsTooBigClosed' : 'terminal.wsServerClosed'
        termInstance.write(`\r\n\x1b[33m[${t(reasonKey, { delay: Math.round(WS_LONG_BACKOFF_DELAY_MS / 1000) })}]\x1b[0m\r\n`)
        inst.reconnectTimer = setTimeout(() => {
          inst.reconnectTimer = null
          if (lockStore.isLocked) return
          try {
            const retryWs = makeTerminalWs()
            attachWsHandlers(retryWs, termInstance, fit, true)
            inst.ws = retryWs
          } catch {
            // 重连失败：onerror 会触发，由 onclose 递归重试
          }
        }, WS_LONG_BACKOFF_DELAY_MS)
        return
      }
      if (lockStore.isLocked) return
      disconnected.value = true
      inst.reconnectAttempts++
      if (inst.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const delay =
          RECONNECT_BASE_DELAY * Math.pow(1.5, inst.reconnectAttempts - 1)
        termInstance.write(
          `\r\n\x1b[33m[${t('terminal.reconnecting', {
            delay: Math.round(delay / 1000),
            attempt: inst.reconnectAttempts,
            max: MAX_RECONNECT_ATTEMPTS,
          })}]\x1b[0m\r\n`,
        )
        inst.reconnectTimer = setTimeout(() => {
          inst.reconnectTimer = null
          if (lockStore.isLocked) return
          try {
            const retryWs = makeTerminalWs()
            attachWsHandlers(retryWs, termInstance, fit, true)
            inst.ws = retryWs
          } catch {
            // 重连失败：onerror 会触发，由 onclose 递归重试
          }
        }, delay)
      } else {
        termInstance.write(`\r\n\x1b[31m[${t('terminal.disconnected')}]\x1b[0m\r\n`)
        // 标记为失败会话，pane 显示「后端不可用」+ 重试按钮
        failed.value = true
        params.onExit?.(sessionId)
      }
    }
    wsConn.onerror = () => {
      connecting.value = false
    }
  }

  // 重试按钮：撤销失败/断开浮层并立即发起重连（reconnect 自带 OPEN 守卫，连接中为 no-op）
  function retry(): void {
    failed.value = false
    disconnected.value = false
    reconnect()
  }

  // 宿主主动断开（实例切换）：清重连 timer + 阻止自动重连后关闭
  // 语义同旧 disconnectAllTerminals 的单实例版本
  function disconnect(): void {
    const inst = termInstances.get(sessionId)
    if (!inst) return
    disconnected.value = false
    if (inst.reconnectTimer) {
      clearTimeout(inst.reconnectTimer)
      inst.reconnectTimer = null
    }
    inst.reconnectAttempts = MAX_RECONNECT_ATTEMPTS + 1 // 阻止自动重连
    inst.ws.close()
  }

  // 宿主主动重连（实例切换 / 解锁兜底）：WS 非开放态时重建连接
  // 语义同旧 reconnectExistingSessions 的既有 tab 分支（bindWsEvents isReconnect=true）
  function reconnect(): void {
    const inst = termInstances.get(sessionId)
    if (!inst || inst.ws.readyState === WebSocket.OPEN) return
    // 取消挂起的自动重连：否则 timer 触发会再建一条 WS 与手动重连并发——
    // 双会话双写（同一 xterm 收到两份 motd），且后 attach 者被服务端
    // 单挂载策略踢掉时 inst.ws 变死连接，输入静默失效
    if (inst.reconnectTimer) {
      clearTimeout(inst.reconnectTimer)
      inst.reconnectTimer = null
    }
    // 半开（CONNECTING）的旧 socket 一并关闭：孤儿 onclose 由上方守卫忽略
    if (inst.ws.readyState === WebSocket.CONNECTING) {
      try {
        inst.ws.close()
      } catch {
        /* ignore */
      }
    }
    inst.reconnectAttempts = 0
    const ws = makeTerminalWs()
    attachWsHandlers(ws, inst.term, inst.fit, true)
    inst.ws = ws
  }

  // 失败态自愈：重连退避耗尽进入失败态后，用户切走再切回页面（窗口 focus）
  // 时自动重试一次——服务端重启场景下免去逐 pane 手动点「重试」。
  // 常驻监听 + failed 门控：仅在失败态响应 focus，pane 卸载时随 dispose 移除
  function onWindowFocusRetry(): void {
    if (failed.value) retry()
  }
  window.addEventListener('focus', onWindowFocusRetry)

  // 彻底释放：close ws / disconnect observer / dispose term / 移出共享 Map
  function dispose(): void {
    window.removeEventListener('focus', onWindowFocusRetry)
    imagePasteDetach?.()
    imagePasteDetach = null
    if (armTimer !== null) {
      clearTimeout(armTimer)
      armTimer = null
    }
    if (restoreFailedMarkTimer !== null) {
      clearTimeout(restoreFailedMarkTimer)
      restoreFailedMarkTimer = null
    }
    replayFailedPending = null
    sessionsWithOutput.delete(sessionId)
    commandOutputLines.delete(sessionId)
    commandPromptGen.delete(sessionId)
    // 命令块锚点（P-20261003-269）：marker 随 xterm 实例 dispose 一并消亡，此处
    // 清簿记引用防跨重挂残留（接管场景与 resetCommandMarks 同口径）
    resetCommandBlocks(sessionId)
    // 命中时间锚（P-20261005-202）：区间 marker 同随实例消亡，清簿记引用
    resetCommandTimes(sessionId)
    // 书签（P-20261004-16）：marker/装饰随实例消亡，清簿记引用（跨重挂残留指向
    // 已消亡实例会让列表点击落空）
    resetBookmarks(sessionId)
    // 风暴追踪器停定时器：dispose 后不再触达已卸载实例（onSettle 首行有
    // termInstances 守卫，此处置为双保险）
    writeStorm.dispose()
    resetCommandMarks(sessionId)
    // LRU 摘账（entry ⇔ 活实例同生命周期）+ 驱逐期收编：pane 在驱逐态被卸载
    // （会话关闭/宿主销毁）时，保留的 headless socket 在此关闭。
    // release 带自身 evict 闭包做所有权比对——双挂接窗口期新 pane 已覆盖注册，
    // 旧 pane 的卸载不得摘走接管者的条目（disposeInstance ownerTerm 同哲学）
    terminalLru.release(sessionId, evict)
    headless = false
    if (evictedWs) {
      try {
        evictedWs.close()
      } catch {
        /* 已断开时 close 抛错可忽略 */
      }
      evictedWs = null
    }
    disposeInstance(sessionId, ownedTerm ?? undefined)
  }

  return {
    connecting,
    failed,
    disconnected,
    connect,
    retry,
    disconnect,
    reconnect,
    flushPendingWrites,
    dispose,
  }
}
