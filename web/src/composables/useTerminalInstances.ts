import { watch } from 'vue'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { useFontStore } from '../stores/font'
import { useTerminalThemeStore } from '../stores/terminal-theme'

// 单个终端实例的运行时句柄。
// termInstances Map 的 value 类型——持有 xterm 实例 + addon + ws + 串行化队列等。
export interface TermInstance {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  ws: WebSocket
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  resizeObserver: ResizeObserver
  // 写入串行化队列：所有 WS 消息按到达顺序入队处理。
  // 1) Blob 类型 WS 消息的 arrayBuffer() Promise 解析顺序不保证与到达顺序一致，
  //    直接 term.write 会导致显示乱序；
  // 2) refreshActiveTerminal 也作为 writeChain 的一个 task，
  //    保证 reset + snapshot 重放与并发到达的 WS 消息严格按序处理，杜绝竞态丢失。
  writeChain: Promise<void>
  // 写链路在途消息数（背压用）：超过上限时新消息丢弃，防止输出风暴下闭包无界累积
  pendingWrites?: number
  // 写链路背压累计丢弃帧数（P-20261004-47）：丢弃分支自增，会话存活期只增不减。
  // 调试面（设置·终端·写链路背压诊断）按会话展示——丢帧是「屏态偏离/疑似花屏」
  // 的唯一线索；新连接不重置（跨重连保留，诊断语义为会话历史总量）
  droppedWrites?: number
  // 风暴落定自愈已触发次数（P-20261004-47）：每次「pending 回落 0 且 episode 有
  // 丢帧」的落定自愈（服务端权威重绘 + 本地重绘重同步）自增，与 droppedWrites
  // 同面展示——dropped>0 且 heals=0 = 丢弃尚未走到落定（风暴进行中/刚停止）
  stormHeals?: number
  // 容器右键菜单监听的解除函数（connect 时注册，disposeInstance 时调用）
  detachContextMenu?: () => void
}

// 模块级共享状态：所有终端 composable 共用同一份 Map。
// TerminalView 与 TerminalPane（经 useTerminalSession 登记）都是消费者，
// BottomPanel v-if 切换不会引起状态丢失。
// 容器元素由 TerminalPane 自持（connect 时直接传入），不再单独登记 Map。
export const termInstances = new Map<string, TermInstance>()

// 安全 fit：仅当 container 真正有非 0 尺寸时才调 fit
// v-show 切换瞬间 container 可能 display:none 或 layout 未完成，此时 fit 会算到 cols≈10，
// 把 cols 同步到服务端 PTY 触发 PowerShell 重发 banner（含 \x1b[H 覆盖屏幕）造成"历史消失"错觉
export function safeFit(fit: FitAddon, container: HTMLElement): void {
  const r = container.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return
  try {
    fit.fit()
  } catch {
    // fit 在 certain race conditions 下抛错，忽略
  }
}

// 实例级安全 fit：从 xterm 根元素反查宿主容器做非零尺寸守卫。
// selectTab 等宿主路径禁止裸调 fit()——会话总览跨项目跳转时目标 tab 可能仍
// 被项目切换 watcher 的记忆值覆盖回隐藏态（display:none），裸 fit 算出极小
// 列数把 xterm 缩成窄条再弹回，缓冲内容经两次重排后错乱（跳转后乱屏成因之一）
export function safeFitInstance(inst: TermInstance): void {
  const el = inst.term.element?.parentElement
  if (!el) return
  safeFit(inst.fit, el)
}

// 查询选区长度（右键菜单的「复制」按钮 enable/disable 依据、复制操作的预检）
export function getSelectionLength(termInstances: Map<string, TermInstance>, tabId: string): number {
  const inst = termInstances.get(tabId)
  if (!inst) return 0
  const sel = inst.term.getSelection()
  return sel ? sel.length : 0
}

// 清理实例：close ws / disconnect observer / dispose term，并从 Map 移除。
// ownerTerm 所有权守卫：同一会话可能被后挂接的 pane 接管（connect 会覆盖
// Map 条目并关闭旧 WS）。此时旧 pane 卸载若仍无条件清理，会把接管者的
// 现役连接一并删掉——传入旧 pane 持有的 term，仅当仍是登记实例时才清理
export function disposeInstance(tabId: string, ownerTerm?: Terminal): void {
  const inst = termInstances.get(tabId)
  if (!inst) return
  if (ownerTerm && inst.term !== ownerTerm) return
  if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer)
  inst.detachContextMenu?.()
  inst.resizeObserver.disconnect()
  try {
    inst.ws.close()
  } catch {
    // ws 可能已 closed
  }
  inst.term.dispose()
  termInstances.delete(tabId)
}

// 字体大小 / 主题变化的同步：监听 store，遍历所有实例更新
// 由 useTerminalInstances 工厂在 setup 时调用，自动随组件卸载清理 watch
export function useTerminalInstances() {
  const fontStore = useFontStore()
  const terminalThemeStore = useTerminalThemeStore()

  // 字形度量变化（字号/字族）后重算所有实例的列行数：xterm 改 fontSize/
  // fontFamily 只影响渲染，cols/rows 停留旧值，必须随动 fit 才能自适应；
  // safeFit 跳过不可见容器（盲 fit 会算出 cols≈10 并同步 PTY，见其注释），
  // 恢复可见后 ResizeObserver 会再触发
  function refitAllInstances(): void {
    termInstances.forEach(({ term, fit }) => {
      if (term.element) safeFit(fit, term.element)
    })
  }

  // 终端字体大小变化时更新所有实例：监听生效字号（持久 sizes × 演示模式
  // 缩放，P-20261002-45）——投屏演示临时放大不落盘，进出演示随动 refit
  watch(
    () => fontStore.terminalFontSize,
    (size) => {
      termInstances.forEach(({ term }) => {
        term.options.fontSize = size
      })
      refitAllInstances()
    },
  )

  // 终端主题切换时更新所有 xterm 实例颜色（来自 terminalThemeStore，非应用 themeStore）
  watch(
    () => terminalThemeStore.currentThemeName,
    () => {
      const colors = terminalThemeStore.currentThemeDef.colors
      termInstances.forEach(({ term }) => {
        term.options.theme = colors
      })
    },
  )

  // 终端字体切换时更新所有实例：字形度量变化随动 fit 重算列行数。
  // 监听 currentFontStack 而非预设枚举 currentFont（P-20261005-227）：栈里还
  // 前插了自定义等宽字体名——只改字体名不动预设时同样要换字体重 fit
  watch(
    () => terminalThemeStore.currentFontStack,
    () => {
      termInstances.forEach(({ term }) => {
        term.options.fontFamily = terminalThemeStore.currentFontStack
      })
      refitAllInstances()
    },
  )

  // 光标形态/闪烁偏好变化时更新所有实例（P-20261005-212）：xterm options 运行期
  // 动态可设（cursorBlink 走 CursorBlinkService 重挂闪动、cursorStyle 走渲染
  // 刷新），不改字形度量无需随动 fit
  watch(
    () => [fontStore.cursorStyle, fontStore.cursorBlink] as const,
    ([style, blink]) => {
      termInstances.forEach(({ term }) => {
        term.options.cursorStyle = style
        term.options.cursorBlink = blink
      })
    },
  )

  return {
    termInstances,
    safeFit,
    disposeInstance,
    getSelectionLength: (tabId: string) => getSelectionLength(termInstances, tabId),
  }
}
