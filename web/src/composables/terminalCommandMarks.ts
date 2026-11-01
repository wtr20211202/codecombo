import type { IDecoration } from '@xterm/xterm'
import { termInstances, type TermInstance } from './useTerminalInstances'

// 命令成败装饰与失败命令记账（P-20261003-150）：OSC 133 D 帧的 exit code 在
// 写入路径（useTerminalSession 的 enqueueWriteMessage 段循环）按 C/D 行号记账
// 区间标记成绿/红装饰行——xterm registerDecoration 是 DOM 覆盖层，不写 PTY
// 字节流，输出内容/复制区间/命令历史零污染；失败命令另记会话级记录，供右键
// 「交给 agent 修」组装 prompt（useEditorAskAgent.askAgentToFixFailedCommand）。
// 重挂/重连的重放段 D 帧同样记账装饰（P-20261006-37）：重放目的地是全新
// buffer，重放段行号在新 buffer 上天然自洽，装饰与失败记录随重放原样恢复
// （截断重放窗的无 C 边界命令由调用侧「宁缺勿错」守卫跳过）；pane 卸载只清
// 装饰引用，失败记录留至会话真死清账。无 shell 集成的会话没有 D 帧，本模块
// 不被触达，天然降级现状。

// 单会话装饰上限：长会话滚动缓冲可容纳成百上千条命令，装饰元素无上限会拖累
// xterm 每次视口重绘（BufferDecorationRenderer._doRefreshDecorations 逐装饰写
// style）。钳在最近 50 条（视觉窗口数屏，足够）；滚出 scrollback 上限的行，
// xterm 依 marker 裁剪自动连带 dispose 装饰（DecorationService 挂 marker.onDispose）
const MAX_MARKS_PER_SESSION = 50

/** 最近一次失败命令（区间为 D 帧记账时点快照，行号在 scrollback 裁剪/清屏后
 *  按提取端钳制近似读取——与「复制上一条命令输出」同口径） */
export interface FailedCommandRecord {
  command: string
  exitCode: number
  startLine: number
  endLine: number
}

const lastFailed = new Map<string, FailedCommandRecord>()
// 每会话装饰登记（上限裁剪用）；装饰本体随 xterm 实例存亡，此处只持引用
const sessionMarks = new Map<string, IDecoration[]>()

/**
 * 命令结束标记：按 OSC 133 C/D 行号记账区间注册成功绿/失败红装饰行；失败命令
 * 同时记入会话级记录。interval 未记账（首个 prompt 的 D 等无 C 边界场景）时
 * 跳过——起点未知不装饰，宁缺勿错（与区间提取同口径）
 */
export function markCommandOutcome(
  sessionId: string,
  exitCode: number,
  command: string | undefined,
  interval: { startLine: number; endLine: number | null } | undefined,
): void {
  const inst = termInstances.get(sessionId)
  if (!inst || !interval) return
  const buf = inst.term.buffer.active
  const last = buf.length - 1
  const start = interval.startLine
  const end = interval.endLine
  if (start < 0 || start > last || end === null || end < start) return
  const endClamped = Math.min(end, last)
  // 失败记账先于装饰：记录供右键「交给 agent 修」使用，与装饰能否锚定无关
  if (exitCode !== 0) {
    lastFailed.set(sessionId, { command: command ?? '', exitCode, startLine: start, endLine: endClamped })
  }
  // 锚定命令行（输出首行的上一行，两种 shell 时序下都是回显命令所在行）：
  // 装饰元素纵向铺满 [命令行..输出末行] 整块。锚行刻意不落在输出首行——
  // xterm DOM 渲染器把被装饰覆盖的 cell 排除出 span 合并（DomRendererRowFactory
  // 的 !isDecorated 分支），锚在输出首行会把行首字符拆成独立文本节点，破坏
  // 「行内 Range 定位终端文本」的 e2e 技术（waitForMarkerRect/needleBand 同款）
  // 与任何 DOM 级整词匹配；命令行的 cell 0 拆分只孤立提示符首字符，不切割
  // 任何完整标记词。命令行在缓冲顶（start=0）时无从锚定，跳过装饰。
  // registerMarker 相对当前光标行偏移（此刻内容尾 = end 附近）。行号越界钳制
  // 同区间提取的固有近似
  const anchorLine = start - 1
  if (anchorLine < 0) return
  const marker = inst.term.registerMarker(anchorLine - (buf.baseY + buf.cursorY))
  if (!marker || marker.line < 0) return
  const deco = inst.term.registerDecoration({
    marker,
    anchor: 'left',
    x: 0,
    width: 1,
    height: endClamped - anchorLine + 1,
    layer: 'bottom',
  })
  if (deco) {
    // 样式必须走 class：元素被渲染器持久复用，行内样式会在每次重绘被重写；
    // onRender 每次刷新都 fire，重复 addClass 幂等
    deco.onRender((el) => el.classList.add(exitCode === 0 ? 'sc-cmd-ok' : 'sc-cmd-fail'))
    const marks = sessionMarks.get(sessionId) ?? []
    marks.push(deco)
    while (marks.length > MAX_MARKS_PER_SESSION) marks.shift()?.dispose()
    sessionMarks.set(sessionId, marks)
  }
}

/** 会话最近一次失败命令（无记录返回 undefined——右键菜单项置灰依据） */
export function getFailedCommandRecord(sessionId: string): FailedCommandRecord | undefined {
  const rec = lastFailed.get(sessionId)
  return rec ? { ...rec } : undefined
}

/**
 * 按行区间提取缓冲文本（钳制越界 + 去尾部空行 + 行尾空白裁剪）：区间提取共用
 * 原语——「复制上一条命令输出」（useTerminalClipboard）与失败输出读取同口径。
 * 行尾空白裁剪兜底 ConPTY 重绘：Windows ConPTY 重绘/重放会把行按渲染宽度补齐
 * 字面空格单元格，translateToString(true) 只裁空单元格不裁空格字符——复制输出
 * 会拖上一串无意义尾随空格（fulle2e run6/run7 实测），故按行右裁空格/制表
 */
export function extractBufferLines(inst: TermInstance, startLine: number, endLine: number): string {
  const buf = inst.term.buffer.active
  const last = buf.length - 1
  // 钳制：scrollback 裁剪（超上限丢最旧）/清屏重置后记账行号可能越界——
  // 收进当前缓冲界内；裁剪后内容已移位属固有近似（行号无法回推位移量）
  const start = Math.min(startLine, last)
  const end = Math.min(endLine, last)
  if (start > end) return ''
  const lines: string[] = []
  for (let i = start; i <= end; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true).replace(/[ \t]+$/, ''))
  }
  // 去尾部空行（命令输出常以空行收尾，与 extractBufferText 同口径）
  let e = lines.length
  while (e > 0 && lines[e - 1]!.trim() === '') e--
  return lines.slice(0, e).join('\n')
}

/** 失败命令的输出尾部（prompt 组装用；记录/实例缺失返回空串） */
export function extractFailedCommandOutput(sessionId: string): string {
  const rec = lastFailed.get(sessionId)
  const inst = termInstances.get(sessionId)
  if (!rec || !inst) return ''
  return extractBufferLines(inst, rec.startLine, rec.endLine)
}

/** 装饰引用清理（pane 卸载/LRU 驱逐/接管重挂对账）：装饰本体随 xterm 实例
 *  dispose 一并消亡，此处清引用仅为上限裁剪簿记兜底。失败记录不在此清
 *  （P-20261006-37 拆分）：pane 卸载 ≠ 会话真死——重挂恢复链路服务端会重放
 *  scrollback，装饰随重放段 D 帧在新 buffer 重建、失败记录原样保留让「交给
 *  agent 修」入口不置灰；清账随会话真死走 clearFailedCommandRecord
 *  （terminal-sessions store 会话移除两路对账收口） */
export function resetCommandMarks(sessionId: string): void {
  sessionMarks.delete(sessionId)
}

/** 会话真死清账：失败记录与会话共存亡。调用点 = terminal-sessions store 的
 *  removeLocal（destroy/killExternal/markExited 单会话移除收口） */
export function clearFailedCommandRecord(sessionId: string): void {
  lastFailed.delete(sessionId)
}

/** 存活集剪枝（快照全量对账路径调）：会话已从服务端列表消失的失败记录摘除，
 *  防跨会话累积无界——与 store 内 runningMap/unreadMap 等孤儿清理同汰口径 */
export function pruneFailedCommandRecords(alive: Set<string>): void {
  if (lastFailed.size === 0) return
  for (const id of lastFailed.keys()) {
    if (!alive.has(id)) lastFailed.delete(id)
  }
}
