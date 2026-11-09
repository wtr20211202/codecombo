import { reactive, ref } from 'vue'
import type { Terminal } from '@xterm/xterm'
import { safeStorage } from '../utils/storage'

// ============== 终端鼠标上报模式追踪（P-20261106-6） ==============
// claude code 等 TUI 开启鼠标上报（mouse reporting）后，普通拖选被应用消费，
// 按住 Shift 拖选才走 xterm 本地选择进剪贴板——xterm/主流终端的协议语义。
// 应用自报「已复制」是否真进剪贴板取决于应用是否经 OSC 52 写入且终端侧写入
// 成功（P-20261107-6 实勘纠正：新版 claude code 走 OSC 52，写入成功即复制可用；
// 不支持 OSC 52 的应用或非安全上下文写入失败时剪贴板才无内容）——提示条对
// 「OSC 52 已写入成功」的会话做粘性抑制，见 terminalOsc52Clipboard。本模块
// 只负责「检测 + 供提示」：协议本身不动，handler 恒返回 false 透传（xterm
// 默认处理照常），绕过/拦截会破坏 TUI 点击交互。
//
// 检测实现：term.parser.registerCsiHandler 监听 DECSET(CSI ?h)/DECRST(CSI ?l)
// 私有模式序列。xterm 对 mode 变化无公共事件（term.modes.mouseReportingMode
// 是快照读数，无 onChange，轮询无意义），CSI handler 是唯一的旁观缝；命中
// 1000/1002/1003 记账，其余私有模式（1004 焦点上报 / 1005·1006 扩展坐标等）
// 不关心。
//
// 重放语义：attach/重连的 scrollback 重放里携带的 DECSET 序列同样经 handler
// 记账——重放本就是「重建会话屏态」，鼠标模式随重放恢复是正确行为；
// term.reset()（重连前置）清 xterm 自身模式时会话追踪集合同步软清零
// （resetMouseModeTracking，useTerminalSession 重连分支调用），随后由重放流
// 重新建立，两侧一致。handler 随 term.dispose 消亡，簿记由
// detachMouseModeTracking 清理（evict 驱逐 / dispose 释放）。

// 鼠标上报的三种 DECSET 私有模式：按键(1000) / 按键+拖动(1002) / 全部移动(1003)。
// 任一在位即视为「应用已接管鼠标」
const MOUSE_TRACKING_MODES = new Set([1000, 1002, 1003])

/** 「不再提示」持久化键（safeStorage 通道，同 sc.terminal.closeNoConfirm 惯例；
 *  设置页可重置） */
export const MOUSE_MODE_HINT_DISMISS_KEY = 'sc.terminal.mouseModeHintDismissed'

// 「不再提示」反应式镜像（模块级单份）：TerminalPane 的提示条显隐计算属性直接
// 读它。不做成各 pane 的本地 ref 快照——快照有两个一致性问题：①任一 pane 点 ✕
// 后其余已挂载 pane 的提示条仍挂着（每个 pane 各自持旧值）；②设置页「重置」
// 清存储后，已挂载 pane 不重挂就永远看不到恢复。镜像只在模块写路径（✕/重置）
// 与 safeStorage 同步变动，多 pane 与设置页天然同帧
const hintDismissed = ref(safeStorage.getItem(MOUSE_MODE_HINT_DISMISS_KEY) === '1')

/** 「鼠标接管提示不再显示」（反应式，默认显示；计算属性内读取可追踪） */
export function isMouseModeHintDismissed(): boolean {
  return hintDismissed.value
}

/** 永久不再提示（提示条 ✕ 写入；一次性教育提示的诚实出口，设置页可重置） */
export function dismissMouseModeHintForever(): void {
  safeStorage.setItem(MOUSE_MODE_HINT_DISMISS_KEY, '1')
  hintDismissed.value = true
}

/** 设置页重置入口：清「不再提示」记忆，恢复显示（与 resetCloseConfirm 同款
 *  行级恢复语义；反应式镜像同步复位，已挂载 pane 即时生效无需重挂） */
export function resetMouseModeHintDismissed(): void {
  safeStorage.removeItem(MOUSE_MODE_HINT_DISMISS_KEY)
  hintDismissed.value = false
}

// 会话级在位模式集合：非反应式 Set 在 handler 热路径读写（每序列 O(1)，
// 大流量输出下 DECSET 序列可能高频出现），反应式面只存布尔结果——避免把
// Set 本身做成深响应，写入路径开销与输出量解耦
const trackingModes = new Map<string, Set<number>>()
// UI 反应式面：sessionId → 是否有任一鼠标上报模式在位（TerminalPane 提示条显隐依据）
const mouseReportingMap = reactive(new Map<string, boolean>())

/** 本会话是否有应用开启的鼠标上报模式（提示条显隐依据，计算属性内读取可追踪） */
export function isMouseReporting(sessionId: string): boolean {
  return mouseReportingMap.get(sessionId) === true
}

function syncFlag(sessionId: string): void {
  const modes = trackingModes.get(sessionId)
  mouseReportingMap.set(sessionId, !!modes && modes.size > 0)
}

// DECSET/DECRST 旁观 handler：命中追踪模式记账，恒返回 false——xterm 约定
// handler 返回 true 即消费序列（默认处理被跳过），返回 false 交回默认链。
// 这里是纯旁观，必须透传，否则鼠标上报整体失效
function registerTrackingHandler(sessionId: string, term: Terminal): void {
  const update = (params: (number | number[])[], set: boolean): void => {
    const modes = trackingModes.get(sessionId)
    if (!modes) return
    // 参数可为多模式同发（如 ?1000;1006h），逐个识别；子参数数组形态
    // （冒号分隔）不属于 DECSET 私有模式，跳过
    let touched = false
    for (const p of params) {
      if (typeof p !== 'number' || !MOUSE_TRACKING_MODES.has(p)) continue
      if (set) modes.add(p)
      else modes.delete(p)
      touched = true
    }
    if (touched) syncFlag(sessionId)
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    update(params, true)
    return false
  })
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    update(params, false)
    return false
  })
}

/** 会话连接时注册追踪（connect 调用，先于 WS 建立——重放字节到达前 handler
 *  已在位；随 term.dispose 自然失效） */
export function attachMouseModeTracking(sessionId: string, term: Terminal): void {
  trackingModes.set(sessionId, new Set())
  syncFlag(sessionId)
  registerTrackingHandler(sessionId, term)
}

/** 软清零（term.reset 重连分支调用）：只清集合内容、保留 Map 条目——重放流
 *  的 DECSET 还要靠 handler 重新记账（handler 内按条目守卫，条目被删会静默
 *  丢掉重放里的模式恢复） */
export function resetMouseModeTracking(sessionId: string): void {
  const modes = trackingModes.get(sessionId)
  if (modes) modes.clear()
  syncFlag(sessionId)
}

/** 硬清理（evict 驱逐 / dispose 释放调用）：term 已消亡、handler 随之失效，
 *  簿记条目须删除防跨重挂残留与 Map 无界增长 */
export function detachMouseModeTracking(sessionId: string): void {
  trackingModes.delete(sessionId)
  mouseReportingMap.delete(sessionId)
}
