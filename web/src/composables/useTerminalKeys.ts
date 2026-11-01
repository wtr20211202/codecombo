import type { Terminal } from '@xterm/xterm'
import { comboVariants, KEYMAP_DEFAULTS, matchLayoutCombo } from '../stores/keymap'

// 终端快捷键接线（自 useTerminalSession.connect 原样搬运）：
// 拦截段逻辑纯函数化——宿主传入回调集，本模块只负责 attachCustomKeyEventHandler。
// 回调缺省时对应快捷键不拦截（tab 编排钩子可选）。
//
// 键位来源（P-20261003-111）：单组合键位全部走 keymap 注册表（domain:'terminal'，
// 设置→快捷键终端分组可改绑），经 comboOf 在按键现场读生效值——改绑即时生效，
// 已连接的 pane 无需重连。区间键（Ctrl+Shift+1-9 切 tab）仍是硬编码（区间族不在
// 注册表建模范围，见 stores/keymap.ts 边界说明）。

/** xterm 焦点域可改键动作（stores/keymap.ts domain:'terminal' 的 xterm 级子集；
 *  doc 级历史/片段/字号键由 TerminalView document 监听消费，不经此处） */
const TERMINAL_KEY_ACTIONS = [
  'terminalSearch',
  'terminalCopy',
  'terminalPaste',
  'terminalSplitH',
  'terminalSplitV',
  'terminalClosePane',
  'termFocusOtherPane',
  'terminalCyclePrev',
  'terminalCycleNext',
  'terminalCmdPrev',
  'terminalCmdNext',
] as const

export type TerminalKeyAction = (typeof TERMINAL_KEY_ACTIONS)[number]

export interface TerminalKeyHandlers {
  // 会话标识：复制/粘贴回调按会话分发
  sessionId: string
  // xterm 快捷键接线（搜索 / 复制 / 粘贴）
  onSearchOpen: () => void
  onCopySelection: (sessionId: string) => void
  onPaste: (sessionId: string) => void
  // tab 编排快捷键（可选，未注册时快捷键不拦截）
  onSplitHorizontal?: () => void
  onSplitVertical?: () => void
  onClosePane?: () => void
  onSwitchTab?: (delta: number) => void
  onSwitchToTab?: (index: number) => void
  // pane 焦点切换（P-20261004-111，可选）：按键 pane 所在 tab 分屏双 pane 互切。
  // 返回 true = 已切换（拦截键位）；false / 未注册 = 放行 PTY——单 pane 时
  // Ctrl+Alt+- 保终端程序输入原语义（与「注册即拦截」的分屏/关 pane 家族不同，
  // 本动作按宿主裁决放行，故回调带返回值）
  onFocusOtherPane?: (sessionId: string) => boolean
  // 命令块跳过导航（P-20261003-269，可选，未注册时键位不拦截照旧转发 PTY）：
  // 上/下一命令块起点跳转（useTerminalSession 缺省注入共享视口实现）
  onPrevCommandBlock?: () => void
  onNextCommandBlock?: () => void
  // 终端域键位读取（keymap 生效表，TerminalPane 注入 store 读法；缺省用出厂默认
  // ——单测/无 pinia 场景可用）
  comboOf?: (action: TerminalKeyAction) => string
}

// 拦截终端快捷键（键位默认值，均可在设置→快捷键终端分组改绑）：
// - Ctrl+F：唤起搜索框，不转发到 PTY
// - Ctrl+Shift+C：复制选区到剪贴板（仅当有选区；Ctrl/Cmd+C 有选区复制是历史
//   副键位，不入注册表保持硬编码）
// - Ctrl+Shift+V：粘贴剪贴板（走多行警告 + 去尾换行管线）
// - Ctrl/Cmd+V：跳过 xterm 键控、放行原生 paste 事件（OS 复制文件的唯一数据面，
//   attachNativePaste 的 paste 监听接管——文本直贴/截图上传/文件上传贴路径）
// - Ctrl+Shift+\：水平 split（仅宿主注册钩子时生效）
// - Ctrl+Shift+-：垂直 split
// - Ctrl+Shift+W：关闭当前 pane
// - Ctrl+Alt+-：切分屏焦点 pane（P-20261004-111，宿主裁决：单 pane 放行）
// - Ctrl+Shift+[1-9]：切到第 N 个 tab（区间键，硬编码）
// - Ctrl+PageUp/Down：循环切 tab
// - Ctrl+Shift+↑/↓：上一/下一命令块起点（P-20261003-269，对标 VS Code 终端命令导航）
export function attachTerminalKeyHandlers(term: Terminal, handlers: TerminalKeyHandlers): void {
  const {
    sessionId,
    onSearchOpen, onCopySelection, onPaste,
    onSplitHorizontal, onSplitVertical, onClosePane,
    onSwitchTab, onSwitchToTab, onFocusOtherPane,
    onPrevCommandBlock, onNextCommandBlock,
  } = handlers
  const comboOf = handlers.comboOf ?? ((action: TerminalKeyAction) => KEYMAP_DEFAULTS[action])
  /** 组合键命中：主键位 + 移位字符变体（'ctrl+shift+\' 命中 '|' 上报、'ctrl+='
   *  命中 'ctrl+shift++' 移位档）——变体集与布局链同源（keymap.comboVariants） */
  const hit = (event: KeyboardEvent, action: TerminalKeyAction): boolean =>
    comboVariants(comboOf(action)).some(v => matchLayoutCombo(event, v))
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    // mod = Ctrl（Win/Linux）或 Cmd（macOS）——与布局/编辑器快捷键同约定，
    // macOS 只认 ctrlKey 会让 Cmd+F/Cmd+V 全部失效
    const mod = event.ctrlKey || event.metaKey
    if (hit(event, 'terminalSearch')) {
      onSearchOpen()
      return false
    }
    // 复制粘贴保留系统原生的 Ctrl/Cmd+Shift+C/V 语义，
    // 这里只拦截 xterm 默认会吞掉的组合。
    // Ctrl/Cmd+C：有选区时复制（VS Code / Windows Terminal 同语义，历史副键位）；
    // 无选区时不拦截，照旧作为 ^C 中断信号转发给 PTY
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'c') {
      if (term.hasSelection()) {
        onCopySelection(sessionId)
        return false
      }
    }
    // 复制主键位（注册表 terminalCopy）：仅在有选区时拦截；无选区时放行
    //（部分系统作为复制快捷键）
    if (hit(event, 'terminalCopy')) {
      if (term.hasSelection()) {
        onCopySelection(sessionId)
        return false
      }
    }
    if (hit(event, 'terminalPaste')) {
      onPaste(sessionId)
      return false
    }
    // 普通 Ctrl/Cmd+V（非 keymap terminalPaste 键位）：return false 让 xterm 跳过
    // 该键（不 preventDefault、不发 \x16），放行浏览器原生 paste 事件——OS 复制的
    // 文件只在 paste 事件 clipboardData.files 暴露（async clipboard.read 拿不到
    // Files，平台事实），原生事件是终端文件粘贴的唯一可达入口（P-20261024-2）。
    // 文本/截图/文件三分支由 attachNativePaste 的 document capture paste 监听接管
    //（useTerminalClipboard）。键位把 terminalPaste 重映射成 ctrl+v 的用户不受影响
    //（terminalPaste 命中在上方已拦截走警告链，原生事件不再派发）；altKey 排除
    // AltGr 组合（Windows AltGr=Ctrl+Alt，部分布局经它产字符，保持 xterm 原语义）
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v') return false
    if (hit(event, 'terminalSplitH')) {
      if (onSplitHorizontal) {
        onSplitHorizontal()
        return false
      }
    }
    if (hit(event, 'terminalSplitV')) {
      if (onSplitVertical) {
        onSplitVertical()
        return false
      }
    }
    if (hit(event, 'terminalClosePane')) {
      if (onClosePane) {
        onClosePane()
        return false
      }
    }
    // pane 焦点切换（P-20261004-111）：分屏双 pane 互切（编辑器组 focusOtherGroup
    // 对称）。宿主完成切换（返回 true）才拦截——单 pane 返回 false 落到末尾
    // return true 放行 PTY，不吞键
    if (hit(event, 'termFocusOtherPane')) {
      if (onFocusOtherPane?.(sessionId)) {
        event.preventDefault()
        return false
      }
    }
    // Ctrl/Cmd+Shift+1-9：切到第 N 个 tab（区间键硬编码；仅在钩子注册时生效）
    if (mod && event.shiftKey && /^[1-9]$/.test(event.key)) {
      if (onSwitchToTab) {
        const idx = parseInt(event.key, 10) - 1
        onSwitchToTab(idx)
        return false
      }
    }
    // Ctrl/Cmd+PageUp/Down：循环切 tab（浏览器同键切 tab，需 preventDefault）
    if (hit(event, 'terminalCycleNext')) {
      if (onSwitchTab) {
        event.preventDefault()
        onSwitchTab(1)
        return false
      }
    }
    if (hit(event, 'terminalCyclePrev')) {
      if (onSwitchTab) {
        event.preventDefault()
        onSwitchTab(-1)
        return false
      }
    }
    // 命令块跳过导航（P-20261003-269）：长输出命令块间掠读。回调缺省（理论不可达
    // ——useTerminalSession 恒注入）时放行 PTY：Ctrl+Shift+↑/↓ 部分程序用作选区/
    // 翻页，不拦截保原语义
    if (hit(event, 'terminalCmdPrev')) {
      if (onPrevCommandBlock) {
        event.preventDefault()
        onPrevCommandBlock()
        return false
      }
    }
    if (hit(event, 'terminalCmdNext')) {
      if (onNextCommandBlock) {
        event.preventDefault()
        onNextCommandBlock()
        return false
      }
    }
    return true
  })
}
