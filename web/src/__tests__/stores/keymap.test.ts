import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useKeymapStore, normalizeLayoutCombo, canonicalCombo, matchLayoutCombo,
  comboVariants, keycapParts, isReservedCombo, KEYMAP_ACTION_ORDER,
  KEYMAP_ACTION_DOMAIN, TERMINAL_DOC_ACTIONS,
} from '@/stores/keymap'
import { useLockStore } from '@/stores/lock'

// 键位自定义 store（P-20261002-28 布局域，P-20261003-111 终端域扩展）：
// 默认表 + localStorage 覆盖 + 域感知冲突检测 + 浏览器保留键黑名单 +
// meta≡ctrl 规范化匹配 + 移位字符变体匹配面

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    ...init,
  } as KeyboardEventInit)
}

const OVERRIDES_KEY = 'sc.keymapOverrides'

describe('normalizeLayoutCombo / canonicalCombo / matchLayoutCombo', () => {
  it('Ctrl+K → ctrl+k；无修饰符 / 纯 modifier → 空串', () => {
    expect(normalizeLayoutCombo(keyEvent({ key: 'k', ctrlKey: true }))).toBe('ctrl+k')
    expect(normalizeLayoutCombo(keyEvent({ key: 'k' }))).toBe('')
    expect(normalizeLayoutCombo(keyEvent({ key: 'Control', ctrlKey: true }))).toBe('')
    expect(normalizeLayoutCombo(keyEvent({ key: '' }))).toBe('')
  })

  it('meta 并入 ctrl（mac 上 Cmd/Cmd 等价，延续 isMod 既有语义）', () => {
    expect(normalizeLayoutCombo(keyEvent({ key: 'k', metaKey: true }))).toBe('ctrl+k')
    expect(normalizeLayoutCombo(keyEvent({ key: 'p', metaKey: true, shiftKey: true }))).toBe('ctrl+shift+p')
  })

  it('canonicalCombo 规范化别名与顺序', () => {
    expect(canonicalCombo('Meta + K')).toBe('ctrl+k')
    expect(canonicalCombo('SHIFT+CTRL+L')).toBe('ctrl+shift+l')
    expect(canonicalCombo('option+alt+T')).toBe('alt+t')
    expect(canonicalCombo('ctrl')).toBe('')   // 无主键
    expect(canonicalCombo('')).toBe('')
  })

  it('matchLayoutCombo：规范形全等；ctrl 与 meta 事件等价', () => {
    expect(matchLayoutCombo(keyEvent({ key: 'p', ctrlKey: true }), 'ctrl+p')).toBe(true)
    expect(matchLayoutCombo(keyEvent({ key: 'p', metaKey: true }), 'ctrl+p')).toBe(true)
    expect(matchLayoutCombo(keyEvent({ key: 'p', ctrlKey: true, shiftKey: true }), 'ctrl+p')).toBe(false)
    expect(matchLayoutCombo(keyEvent({ key: 'p', ctrlKey: true }), 'ctrl+shift+p')).toBe(false)
    expect(matchLayoutCombo(keyEvent({ key: 'p' }), '')).toBe(false)
  })

  it('comboVariants：移位字符变体集（终端域匹配面）——ctrl+= 命中 + / ctrl+shift+\\ 命中 |，字母键保持精确', () => {
    // 字号键：= 的移位字符 + 档（ctrl+shift+= 平台上报 '+'）与无 shift 移位字符档；
    // 纯 ±shift 变体不入集（终端域键位默认精确 shift 语义）
    expect(comboVariants('ctrl+=')).toEqual(['ctrl+=', 'ctrl++', 'ctrl+shift++'])
    expect(comboVariants('ctrl+-')).toEqual(['ctrl+-', 'ctrl+_', 'ctrl+shift+_'])
    // 分屏键：\ 的移位字符 |（Windows Chromium / Playwright 上报）
    expect(comboVariants('ctrl+shift+\\')).toEqual(['ctrl+shift+\\', 'ctrl+shift+|'])
    // 字母键：无移位字符映射，±shift 变体不入集（ctrl+f 不命中 ctrl+shift+f）
    expect(comboVariants('ctrl+f')).toEqual(['ctrl+f'])
    expect(comboVariants('ctrl+shift+h')).toEqual(['ctrl+shift+h'])
    expect(comboVariants('')).toEqual([])
    // 变体经 matchLayoutCombo 与事件对上：ctrl+shift+= 上报 '+' 命中 ctrl+= 的变体
    const variants = comboVariants('ctrl+=')
    expect(variants.some(v => matchLayoutCombo(keyEvent({ key: '+', ctrlKey: true, shiftKey: true }), v))).toBe(true)
    expect(variants.some(v => matchLayoutCombo(keyEvent({ key: '=', ctrlKey: true }), v))).toBe(true)
  })
})

describe('keycapParts / isReservedCombo', () => {
  it('规范 combo → 键帽数组', () => {
    expect(keycapParts('ctrl+shift+p')).toEqual(['Ctrl', 'Shift', 'P'])
    expect(keycapParts('ctrl+`')).toEqual(['Ctrl', '`'])
    expect(keycapParts('ctrl+alt+n')).toEqual(['Ctrl', 'Alt', 'N'])
    expect(keycapParts('ctrl+arrowdown')).toEqual(['Ctrl', '↓'])
    expect(keycapParts('meta+k')).toEqual(['Ctrl', 'K'])
  })

  it('浏览器保留键黑名单：ctrl+n/t/q、ctrl+shift+w 拒绝；ctrl+w 既有例外放行', () => {
    expect(isReservedCombo('ctrl+n')).toBe(true)
    expect(isReservedCombo('ctrl+shift+n')).toBe(true)
    expect(isReservedCombo('ctrl+t')).toBe(true)
    expect(isReservedCombo('meta+shift+t')).toBe(true)
    expect(isReservedCombo('ctrl+q')).toBe(true)
    expect(isReservedCombo('ctrl+shift+w')).toBe(true)
    // 本产品已拦截的既有例外：非 shift 的 ctrl+w 保留可绑
    expect(isReservedCombo('ctrl+w')).toBe(false)
    expect(isReservedCombo('ctrl+alt+p')).toBe(false)
    expect(isReservedCombo('')).toBe(false)
  })
})

describe('useKeymapStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('默认表：51 个动作各就位（28 布局 + 17 终端域 + 3 编辑器域 + 3 笔记面板域），含 P-24 草稿键、P-51 导航后退/前进键、P-38 新建终端键、P-93 分屏键、P-20261005-230 下方分屏键、P-101 全部保存键、P-135 标签线性切换键、P-149 多剪贴板粘贴键、P-20261003-18 Markdown 模式循环键、P-20261003-111 终端域键、P-20261003-269 命令块导航键、P-20261004-16 书签列表键、P-20261004-102 书签间跳转键、P-20261004-111 pane 焦点切换键、P-20261005-201 键盘移动标签键、P-20261008-14 编辑器域键与 P-20261107-5 笔记面板域键', () => {
    const store = useKeymapStore()
    expect(KEYMAP_ACTION_ORDER).toHaveLength(51)
    expect(store.combos.commandPalette).toBe('ctrl+k')
    expect(store.combos.quickOpen).toBe('ctrl+p')
    expect(store.combos.toggleSidebar).toBe('ctrl+b')
    expect(store.combos.newTerminal).toBe('ctrl+shift+`')
    expect(store.combos.toggleTerminal).toBe('ctrl+`')
    expect(store.combos.previewToggle).toBe('ctrl+shift+v')
    expect(store.combos.closeTab).toBe('ctrl+w')
    expect(store.combos.cycleTab).toBe('ctrl+tab')
    expect(store.combos.switchTabPrev).toBe('ctrl+pageup')
    expect(store.combos.switchTabNext).toBe('ctrl+pagedown')
    // 键盘移动标签（P-20261005-201）：Alt+Shift+←/→ 与切换键（Ctrl+PgUp/PgDn）、
    // 导航键（Ctrl+Alt+←/→）修饰域互异，注册表内零冲突
    expect(store.combos.moveTabPrev).toBe('alt+shift+arrowleft')
    expect(store.combos.moveTabNext).toBe('alt+shift+arrowright')
    expect(store.conflicts.moveTabPrev).toBeNull()
    expect(store.conflicts.moveTabNext).toBeNull()
    expect(store.combos.toggleSplit).toBe('ctrl+\\')
    expect(store.combos.focusOtherGroup).toBe('ctrl+shift+\\')
    // 下方分屏/方向切换（P-20261005-230）：Ctrl+Alt 家族退避（Ctrl+\、Ctrl+Shift+\
    // 已被同族占用），与 Monaco 内核/浏览器/注册表全部既有键位零冲突
    expect(store.combos.splitDown).toBe('ctrl+alt+\\')
    expect(store.conflicts.splitDown).toBeNull()
    expect(store.combos.newUntitledDraft).toBe('ctrl+alt+n')
    expect(store.combos.saveAll).toBe('ctrl+alt+s')
    expect(store.combos.reopenClosedTab).toBe('alt+shift+t')
    expect(store.combos.navBack).toBe('ctrl+alt+arrowleft')
    expect(store.combos.navForward).toBe('ctrl+alt+arrowright')
    expect(store.combos.commandMode).toBe('ctrl+shift+p')
    expect(store.combos.projectSearch).toBe('ctrl+shift+f')
    expect(store.combos.outline).toBe('ctrl+shift+o')
    expect(store.combos.openSettings).toBe('ctrl+,')
    // 多剪贴板粘贴（P-20261002-149）：JetBrains 原键 ctrl+shift+v 已被
    // previewToggle 占用，默认退避 ctrl+alt+v；同键的终端域粘贴是跨域分层共存非冲突
    expect(store.combos.clipHistoryPaste).toBe('ctrl+alt+v')
    expect(store.conflicts.clipHistoryPaste).toBeNull()
    // Markdown 模式循环（P-20261003-18）：ctrl+shift+m 与既有键位零冲突
    expect(store.combos.mdModeCycle).toBe('ctrl+shift+m')
    expect(store.conflicts.mdModeCycle).toBeNull()
    // 书签间跳转（P-20261004-102）：原书签提案预留的 Alt+PgUp/PgDn 与 Monaco 内核
    // scrollPageUp/Down（win/linux primary，编辑器聚焦拦截）撞键，退避
    // Ctrl+Alt+PgUp/PgDn（navBack 家族先例）——与 switchTabPrev/Next
    // （Ctrl+PgUp/PgDn）、终端域循环切 tab 修饰域不同，注册表内零冲突
    expect(store.combos.bookmarkPrev).toBe('ctrl+alt+pageup')
    expect(store.combos.bookmarkNext).toBe('ctrl+alt+pagedown')
    expect(store.conflicts.bookmarkPrev).toBeNull()
    expect(store.conflicts.bookmarkNext).toBeNull()
    // 终端域（P-20261003-111）：doc 级面板/字号键 + xterm 级搜索/复制粘贴/分屏/关 pane/循环切 tab
    expect(store.combos.terminalHistory).toBe('ctrl+shift+h')
    expect(store.combos.terminalSnippet).toBe('ctrl+shift+j')
    expect(store.combos.terminalFontIn).toBe('ctrl+=')
    expect(store.combos.terminalFontOut).toBe('ctrl+-')
    expect(store.combos.terminalFontReset).toBe('ctrl+0')
    expect(store.combos.terminalSearch).toBe('ctrl+f')
    expect(store.combos.terminalCopy).toBe('ctrl+shift+c')
    expect(store.combos.terminalPaste).toBe('ctrl+shift+v')
    expect(store.combos.terminalSplitH).toBe('ctrl+shift+\\')
    expect(store.combos.terminalSplitV).toBe('ctrl+shift+-')
    expect(store.combos.terminalClosePane).toBe('ctrl+shift+w')
    expect(store.combos.terminalCyclePrev).toBe('ctrl+pageup')
    expect(store.combos.terminalCycleNext).toBe('ctrl+pagedown')
    // 命令块跳过导航（P-20261003-269）：VS Code 终端命令导航同款默认键，零冲突
    expect(store.combos.terminalCmdPrev).toBe('ctrl+shift+arrowup')
    expect(store.combos.terminalCmdNext).toBe('ctrl+shift+arrowdown')
    expect(store.conflicts.terminalCmdPrev).toBeNull()
    expect(store.conflicts.terminalCmdNext).toBeNull()
    // 书签列表（P-20261004-16）：历史/片段同族面板键（doc 级），对标 VS Code
    // Bookmarks 扩展默认键，退避 Ctrl+Alt+B（Monaco 内建书签占用）零冲突
    expect(store.combos.terminalBookmarkList).toBe('ctrl+alt+k')
    expect(store.conflicts.terminalBookmarkList).toBeNull()
    // pane 焦点切换（P-20261004-111）：编辑器组 focusOtherGroup 的终端对称，
    // Ctrl+Alt+- 与字号减键 ctrl+- 错开，零冲突
    expect(store.combos.termFocusOtherPane).toBe('ctrl+alt+-')
    expect(store.conflicts.termFocusOtherPane).toBeNull()
    // 编辑器域（P-20261008-14）：Monaco 自定义动作入注册表——保存/书签 toggle/
    // 选区内联 AI 编辑；ctrl+k 与全局 commandPalette 同键默认是焦点域分层共存
    //（白名单不标红），ctrl+s / ctrl+alt+b 与既有注册表键位零冲突
    expect(store.combos.editorSave).toBe('ctrl+s')
    expect(store.combos.editorBookmarkToggle).toBe('ctrl+alt+b')
    expect(store.combos.editorInlineEdit).toBe('ctrl+k')
    expect(store.conflicts.editorSave).toBeNull()
    expect(store.conflicts.editorBookmarkToggle).toBeNull()
    expect(store.conflicts.editorInlineEdit).toBeNull()
    expect(store.conflicts.commandPalette).toBeNull()
    // 域标注：17 终端域动作全部 domain='terminal'，3 编辑器域动作 domain='editor'，
    // 其余 global
    const terminalIds = KEYMAP_ACTION_ORDER.filter(id => KEYMAP_ACTION_DOMAIN[id] === 'terminal')
    expect(terminalIds).toHaveLength(17)
    for (const id of terminalIds) {
      expect(TERMINAL_DOC_ACTIONS.has(id) || ['terminalSearch', 'terminalCopy', 'terminalPaste', 'terminalSplitH', 'terminalSplitV', 'terminalClosePane', 'termFocusOtherPane', 'terminalCyclePrev', 'terminalCycleNext', 'terminalCmdPrev', 'terminalCmdNext', 'terminalBookmarkList'].includes(id)).toBe(true)
    }
    expect(KEYMAP_ACTION_ORDER.filter(id => KEYMAP_ACTION_DOMAIN[id] === 'editor')).toEqual(['editorSave', 'editorBookmarkToggle', 'editorInlineEdit'])
    // 笔记面板域（P-20261107-5）：保存/新建/重命名三键；ctrl+s 与编辑器域
    // editorSave 同默认是焦点域分层共存（Monaco 聚焦 vs 笔记面板聚焦，生效条件
    // 物理互斥），注册表内不标红——同 editor×terminal 口径
    expect(KEYMAP_ACTION_ORDER.filter(id => KEYMAP_ACTION_DOMAIN[id] === 'notes')).toEqual(['notesSave', 'notesCreate', 'notesRename'])
    expect(store.combos.notesSave).toBe('ctrl+s')
    expect(store.combos.notesCreate).toBe('ctrl+alt+m')
    expect(store.combos.notesRename).toBe('ctrl+alt+r')
    expect(store.conflicts.notesSave).toBeNull()
    expect(store.conflicts.notesCreate).toBeNull()
    expect(store.conflicts.notesRename).toBeNull()
  })

  it('分屏键位匹配：移位字符变体（Shift+\\ 报 |）经别名命中；两键位互不误吞', () => {
    const store = useKeymapStore()
    // 真实键盘/Playwright 对 Shift+\ 上报移位字符 '|'（US 布局），主键位直接匹配不中
    expect(matchLayoutCombo(keyEvent({ key: '|', ctrlKey: true, shiftKey: true }), store.combos.focusOtherGroup)).toBe(false)
    expect(matchLayoutCombo(keyEvent({ key: '\\', ctrlKey: true, shiftKey: true }), store.combos.focusOtherGroup)).toBe(true)
    expect(matchLayoutCombo(keyEvent({ key: '|', ctrlKey: true, shiftKey: true }), 'ctrl+shift+|')).toBe(true)
    // Ctrl+\（无 shift）命中 toggleSplit，且不误吞 shift 变体
    expect(matchLayoutCombo(keyEvent({ key: '\\', ctrlKey: true }), store.combos.toggleSplit)).toBe(true)
    expect(matchLayoutCombo(keyEvent({ key: '|', ctrlKey: true, shiftKey: true }), store.combos.toggleSplit)).toBe(false)
  })

  it('setBinding 覆盖默认并持久化 localStorage（safeStorage 直写 JSON）', () => {
    const store = useKeymapStore()
    expect(store.setBinding('quickOpen', 'Ctrl + Alt + P')).toBe('ok')
    expect(store.combos.quickOpen).toBe('ctrl+alt+p')
    expect(store.overrides.quickOpen).toBe('ctrl+alt+p')
    expect(JSON.parse(localStorage.getItem(OVERRIDES_KEY)!)).toEqual({ quickOpen: 'ctrl+alt+p' })
    // 其他动作不受影响
    expect(store.combos.commandPalette).toBe('ctrl+k')
  })

  it('meta 事件捕获归一化为 ctrl 规范形存储', () => {
    const store = useKeymapStore()
    expect(store.setBinding('quickOpen', normalizeLayoutCombo(keyEvent({ key: 'p', metaKey: true, altKey: true })))).toBe('ok')
    expect(store.combos.quickOpen).toBe('ctrl+alt+p')
  })

  it('改绑回默认值 = 恢复默认（删覆盖并清空持久化）', () => {
    const store = useKeymapStore()
    store.setBinding('quickOpen', 'ctrl+alt+p')
    expect(localStorage.getItem(OVERRIDES_KEY)).not.toBeNull()
    store.setBinding('quickOpen', 'ctrl+p')
    expect(store.combos.quickOpen).toBe('ctrl+p')
    expect(store.overrides.quickOpen).toBeUndefined()
    expect(localStorage.getItem(OVERRIDES_KEY)).toBeNull()
  })

  it('浏览器保留键拒绝且不落盘；无效组合拒绝', () => {
    const store = useKeymapStore()
    expect(store.setBinding('quickOpen', 'ctrl+t')).toBe('reserved')
    expect(store.combos.quickOpen).toBe('ctrl+p')
    expect(localStorage.getItem(OVERRIDES_KEY)).toBeNull()
    expect(store.setBinding('quickOpen', 'shift')).toBe('invalid')
  })

  it('resetBinding / resetAll 恢复默认', () => {
    const store = useKeymapStore()
    store.setBinding('quickOpen', 'ctrl+alt+p')
    store.setBinding('outline', 'ctrl+alt+u')
    store.resetBinding('quickOpen')
    expect(store.combos.quickOpen).toBe('ctrl+p')
    expect(store.combos.outline).toBe('ctrl+alt+u')
    store.resetAll()
    expect(store.combos.outline).toBe('ctrl+shift+o')
    expect(localStorage.getItem(OVERRIDES_KEY)).toBeNull()
  })

  it('启动时读取持久化覆盖（含脏数据防御：非法动作/保留键丢弃）', () => {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify({
      quickOpen: 'ctrl+alt+p',
      bogusAction: 'ctrl+x',
      closeTab: 'ctrl+t',   // 保留键历史脏数据 → 回默认
    }))
    const store = useKeymapStore()
    expect(store.combos.quickOpen).toBe('ctrl+alt+p')
    expect(store.combos.closeTab).toBe('ctrl+w')
    expect(store.overrides.bogusAction).toBeUndefined()
  })

  it('损坏的持久化 JSON 不致命（回默认表）', () => {
    localStorage.setItem(OVERRIDES_KEY, '{broken json')
    const store = useKeymapStore()
    expect(store.combos.quickOpen).toBe('ctrl+p')
  })

  it('claimsCombo：默认不占数字键；quickOpen 改绑 ctrl+3 后占住（数字直达让位）；终端域键位默认照常占住', () => {
    const store = useKeymapStore()
    expect(store.claimsCombo(keyEvent({ key: '3', ctrlKey: true }))).toBe(false)
    // 默认键位照常占住（含终端域：ctrl+shift+h 历史 / ctrl+0 字号重置）
    expect(store.claimsCombo(keyEvent({ key: 'p', ctrlKey: true }))).toBe(true)
    expect(store.claimsCombo(keyEvent({ key: 'h', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(store.claimsCombo(keyEvent({ key: '0', ctrlKey: true }))).toBe(true)
    store.setBinding('quickOpen', 'ctrl+3')
    expect(store.claimsCombo(keyEvent({ key: '3', ctrlKey: true }))).toBe(true)
    // shift/alt 变体不算（数字直达链只在无 shift/alt 时介入）
    expect(store.claimsCombo(keyEvent({ key: '3', ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('docClaimsCombo：仅 doc 级终端动作命中，且 terminalDocActive 在场才生效', () => {
    const store = useKeymapStore()
    store.terminalDocActive = true
    // doc 级（历史/字号）命中
    expect(store.docClaimsCombo(keyEvent({ key: 'h', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(store.docClaimsCombo(keyEvent({ key: '0', ctrlKey: true }))).toBe(true)
    // xterm 焦点域动作（粘贴）不经 doc 让位链——它只在终端聚焦时由 xterm 拦截
    expect(store.docClaimsCombo(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(false)
    // 布局键位不命中
    expect(store.docClaimsCombo(keyEvent({ key: 'b', ctrlKey: true }))).toBe(false)
    // 宿主不在场（面板切 git/console 分区）：布局链照常接管
    store.terminalDocActive = false
    expect(store.docClaimsCombo(keyEvent({ key: 'h', ctrlKey: true, shiftKey: true }))).toBe(false)
    // 改绑 doc 动作到布局键位后，让位判定跟随新键位
    store.terminalDocActive = true
    store.setBinding('terminalHistory', 'ctrl+alt+b')
    expect(store.docClaimsCombo(keyEvent({ key: 'b', ctrlKey: true, altKey: true }))).toBe(true)
    expect(store.docClaimsCombo(keyEvent({ key: 'h', ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('冲突检测：同 combo 动作组内注册序靠后者被遮蔽（other=先到者）', () => {
    const store = useKeymapStore()
    expect(store.conflicts.quickOpen).toBeNull()
    // quickOpen 在注册表中晚于 commandPalette
    store.setBinding('quickOpen', 'ctrl+k')
    expect(store.conflicts.commandPalette).toBeNull()
    expect(store.conflicts.quickOpen).toEqual({ kind: 'action', other: 'commandPalette' })
  })

  it('冲突检测：与锁定快捷键撞键 → kind=lock（锁定优先级最高）', () => {
    const lockStore = useLockStore()
    lockStore.setLockShortcut('ctrl+shift+l')
    const store = useKeymapStore()
    store.setBinding('projectSearch', 'ctrl+shift+l')
    expect(store.conflicts.projectSearch).toEqual({ kind: 'lock' })
    // 恢复默认后冲突消失
    store.resetBinding('projectSearch')
    expect(store.conflicts.projectSearch).toBeNull()
  })

  it('跨域冲突（P-20261003-111）：默认同键双默认是分层共存不标红（ctrl+shift+v / ctrl+pageup）', () => {
    const store = useKeymapStore()
    // previewToggle（global）× terminalPaste（terminal xterm 域）同键默认共存
    expect(store.conflicts.previewToggle).toBeNull()
    expect(store.conflicts.terminalPaste).toBeNull()
    // switchTabPrev（global）× terminalCyclePrev（terminal xterm 域）同键默认共存
    expect(store.conflicts.switchTabPrev).toBeNull()
    expect(store.conflicts.terminalCyclePrev).toBeNull()
  })

  it('跨域冲突：doc 级终端动作接管语义——全局侧让位标红（无论谁改绑），终端侧不标', () => {
    const store = useKeymapStore()
    // 全局动作改绑到 doc 级终端键：全局侧被接管标红
    store.setBinding('toggleSidebar', 'ctrl+shift+h')
    expect(store.conflicts.toggleSidebar).toEqual({ kind: 'action', other: 'terminalHistory', cross: 'takeover' })
    expect(store.conflicts.terminalHistory).toBeNull()
    store.resetAll()
    // 反向：doc 级终端动作改绑到全局键位——终端域优先，全局侧同样标红
    store.setBinding('terminalHistory', 'ctrl+b')
    expect(store.conflicts.toggleSidebar).toEqual({ kind: 'action', other: 'terminalHistory', cross: 'takeover' })
    expect(store.conflicts.terminalHistory).toBeNull()
  })

  it('跨域冲突：xterm 焦点域动作与全局动作——任一侧改绑才提示 focus 共存，方向随改绑侧', () => {
    const store = useKeymapStore()
    // 全局动作改绑到终端焦点域键：全局侧提示共存
    store.setBinding('toggleSidebar', 'ctrl+shift+v')
    expect(store.conflicts.toggleSidebar).toEqual({ kind: 'action', other: 'terminalPaste', cross: 'focus' })
    expect(store.conflicts.terminalPaste).toBeNull()
    store.resetAll()
    // 终端焦点域动作改绑到全局键位：终端侧提示共存
    store.setBinding('terminalSearch', 'ctrl+b')
    expect(store.conflicts.terminalSearch).toEqual({ kind: 'action', other: 'toggleSidebar', cross: 'focus' })
    expect(store.conflicts.toggleSidebar).toBeNull()
  })

  it('跨域冲突（P-20261008-14）：编辑器域动作与全局动作——默认同键（ctrl+k × commandPalette）白名单不标红，任一侧改绑才提示 focus 共存，方向随改绑侧', () => {
    const store = useKeymapStore()
    // 默认态：editorInlineEdit ctrl+k × commandPalette ctrl+k 焦点域分层共存不标
    expect(store.conflicts.editorInlineEdit).toBeNull()
    expect(store.conflicts.commandPalette).toBeNull()
    // 全局动作改绑到编辑器域键：全局侧提示共存（编辑器聚焦时对方优先）
    store.setBinding('toggleSidebar', 'ctrl+s')
    expect(store.conflicts.toggleSidebar).toEqual({ kind: 'action', other: 'editorSave', cross: 'focus' })
    expect(store.conflicts.editorSave).toBeNull()
    store.resetAll()
    // 编辑器域动作改绑到全局键位：编辑器侧提示共存
    store.setBinding('editorSave', 'ctrl+b')
    expect(store.conflicts.editorSave).toEqual({ kind: 'action', other: 'toggleSidebar', cross: 'focus' })
    expect(store.conflicts.toggleSidebar).toBeNull()
    store.resetAll()
    // 编辑器域同域冲突：注册序遮蔽语义与全局/终端域一致（editorSave 先于
    // editorBookmarkToggle，后者改绑到 ctrl+s 被遮蔽标红）
    store.setBinding('editorBookmarkToggle', 'ctrl+s')
    expect(store.conflicts.editorBookmarkToggle).toEqual({ kind: 'action', other: 'editorSave' })
    expect(store.conflicts.editorSave).toBeNull()
  })

  it('终端域同域冲突：注册序靠后者被遮蔽（terminalSearch 注册先于 terminalCopy，占用其键位后对方标红）', () => {
    const store = useKeymapStore()
    expect(KEYMAP_ACTION_ORDER.indexOf('terminalSearch')).toBeLessThan(KEYMAP_ACTION_ORDER.indexOf('terminalCopy'))
    // terminalSearch（注册序靠前）改绑到 terminalCopy 的 ctrl+shift+c：保存后对方被遮蔽
    store.setBinding('terminalSearch', 'ctrl+shift+c')
    expect(store.conflicts.terminalSearch).toBeNull()
    expect(store.conflicts.terminalCopy).toEqual({ kind: 'action', other: 'terminalSearch' })
  })

  it('无冲突时不产生任何冲突项', () => {
    const store = useKeymapStore()
    for (const id of KEYMAP_ACTION_ORDER) {
      expect(store.conflicts[id]).toBeNull()
    }
  })
})
