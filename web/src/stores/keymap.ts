import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { safeStorage } from '@/utils/storage'
import { useLockStore } from './lock'
import { notifyUserPrefsDirty } from './userPrefsLink'

// 键位自定义 store（P-20261002-28 布局域 MVP，P-20261003-111 扩展终端域，
// P-20261008-14 收口编辑器域）：
// 动作 → combo 查「默认表 + 用户覆盖」，消费方（useLayoutKeyboard / TerminalView /
// useTerminalKeys / MonacoEditor）按动作 id 读生效值。范围 = 单组合键可改绑的动作，
// 按 domain 分域：
// - global   布局链（useLayoutKeyboard）
// - terminal 终端域（TerminalView document 级 + useTerminalKeys xterm 焦点域）
// - editor   编辑器域（P-20261008-14）：Monaco 自定义动作（MonacoEditor 的
//   save-file / sc-bookmark.toggle、useEditorInlineEdit 的 sc-ask.inline-edit）
//   按注册表生效值 addAction、变更重注册（views/editor/editorKeymapBindings.ts）
// - notes    笔记面板域（P-20261107-5）：笔记面板聚焦时的保存/新建/重命名
//   （useNotesKeyboard document capture 监听 + 面板根节点包含判定——焦点在面板
//   外即不触发，与 editor/terminal 同为焦点域）
// 明确不在范围（诚实边界）：
// - Monaco 内建键（查找 Ctrl+F/替换 Ctrl+H/多光标 Ctrl+F/D、F12 转定义接管等）——
//   防破坏标准编辑体验，键位仍在静态清单（utils/keyInventory.ts）作冲突扫描面；
//   本注册表只管本项目自定义动作
// - Ctrl+1-9 数字直达 / Alt+1-9 终端标签直达 / Ctrl+Shift+1-9 终端 tab 切换——
//   捕获链消费的是「区间」而非单键，区间模板建模复杂度高于收益（同 MVP 边界）；
//   改绑其他动作到 Ctrl+数字 由 claimsCombo 优先放行（数字直达让位）
// - Esc 退出最大化 / ? 备忘单 / 裸 R——单键无修饰符，normalizeLayoutCombo 无法捕获
// - Alt+↑/↓ diff 导航——上/下成对键，单项 action 建模歧义
// - 锁定快捷键——已在 安全→锁定 分区独立改绑（useLockStore）

/** 键位作用域域：注册表分组 + 跨域冲突语义的判定轴（设置分区按域分组展示） */
export type KeymapDomain = 'global' | 'terminal' | 'editor' | 'notes'

// 动作注册表：键序即同域匹配优先序（同域撞键先注册者生效，后注册者标红警告）。
// useLayoutKeyboard 的旧硬编码判定顺序与此一致，改序不会改变默认行为；
// domain 是跨域冲突语义轴：同域同键按注册序判遮蔽，跨域同键按域分层消解
//（xterm 焦点域共存 / doc 级终端动作接管，见 conflicts）
export const KEYMAP_ACTIONS = [
  { id: 'toggleSidebar', default: 'ctrl+b', domain: 'global' },
  // 新建终端直达（P-20261002-38，对标 VS Code 新建终端 Ctrl+Shift+`）：注册序
  // 先于 toggleTerminal——后者 shiftTolerant 派生的 ±Shift 变体兜底命中
  // ctrl+shift+`，本动作须先匹配才能接管该键（改键后兜底语义不变）
  { id: 'newTerminal', default: 'ctrl+shift+`', domain: 'global' },
  { id: 'toggleTerminal', default: 'ctrl+`', domain: 'global' },
  // 端口预览面板直达（P-20261002-69，对标 VS Code markdown 预览 Ctrl+Shift+V）
  { id: 'previewToggle', default: 'ctrl+shift+v', domain: 'global' },
  { id: 'closeTab', default: 'ctrl+w', domain: 'global' },
  { id: 'cycleTab', default: 'ctrl+tab', domain: 'global' },
  // 编辑器标签线性切换（P-20261002-135，对标 VS Code Ctrl+PgUp/PgDn 上一/下一
  // 编辑器）：与 cycleTab（Ctrl+Tab 循环）按序浏览分工。上下成对方向键拆两动作
  //（同 navBack/navForward 先例），不设 shift 变体容差——Ctrl+Shift+PgUp/PgDn
  // 不在切换语义内（VS Code 同键位留给移动标签）
  { id: 'switchTabPrev', default: 'ctrl+pageup', domain: 'global' },
  { id: 'switchTabNext', default: 'ctrl+pagedown', domain: 'global' },
  // 键盘移动标签（P-20261005-201，Alt+Shift+←/→ 是浏览器/编辑器 tab 移动的成熟
  // 惯例——VS Code 无内建默认靠 Move Tab 扩展补同键位）：组内移动活跃标签，与
  // switchTabPrev/Next（切换不动序）语义分离。上下成对方向键拆两动作（同
  // navBack/navForward 先例）；Alt+Shift+方向键非浏览器保留组合、Monaco 内核与
  // 终端域（Ctrl+Shift+↑/↓ 命令块导航）均无占用，注册表冲突检测自动覆盖改绑撞键
  { id: 'moveTabPrev', default: 'alt+shift+arrowleft', domain: 'global' },
  { id: 'moveTabNext', default: 'alt+shift+arrowright', domain: 'global' },
  // 分屏键盘闭环（P-20261002-93，对标 VS Code split editor Ctrl+\）：Ctrl+1/2 被
  // 活动栏数字直达占用，Ctrl+\ / Ctrl+Shift+\ 是最自然的开合与切组对。switch 的
  // shiftedKeyTolerant 移位变体（真实键盘/Playwright 对 Shift+\ 报 '|'，见
  // SHIFTED_KEY_ALIASES）含 shift 不与 toggle 主键位重叠，
  // 注册序沿 newTerminal→toggleTerminal 先例：带 shift 键位在前
  { id: 'focusOtherGroup', default: 'ctrl+shift+\\', domain: 'global' },
  { id: 'toggleSplit', default: 'ctrl+\\', domain: 'global' },
  // 下方分屏/方向切换（P-20261005-230，VS Code orthogonal split 对称）：Ctrl+\
  // 与 Ctrl+Shift+\ 已被 toggleSplit/focusOtherGroup 占用，退避 Ctrl+Alt 家族
  // （navBack/saveAll 同款先例）；Monaco 内核与浏览器对该组合均无占用，注册表
  // 冲突检测（conflicts）自动覆盖改绑撞键
  { id: 'splitDown', default: 'ctrl+alt+\\', domain: 'global' },
  { id: 'reopenClosedTab', default: 'alt+shift+t', domain: 'global' },
  // 编辑器导航后退/前进（P-20261002-51，对标 VS Code Ctrl+Alt+←/→；裸 Alt+←/→
  // 是浏览器历史导航保留键无法拦截，退避多修饰组合，同 Alt+Shift+T 先例）
  { id: 'navBack', default: 'ctrl+alt+arrowleft', domain: 'global' },
  { id: 'navForward', default: 'ctrl+alt+arrowright', domain: 'global' },
  // 书签间跳转（P-20261004-102，JetBrains 上/下一个书签同位）：原书签提案
  //（P-20261002-131）预留的 Alt+PgUp/PgDn 经冲突实测不可用——Monaco 内核
  // scrollPageUp/Down 在 win/linux 把 Alt+PgUp/PgDn 绑作「整页滚动」（vendored
  // coreCommands.js win/linux primary，kbExpr textInputFocus，编辑器聚焦时拦截
  // + stopPropagation，布局链收不到，e2e 实证），Ctrl+Alt+PgUp/PgDn 在 Monaco/
  // 浏览器/本注册表三面均无占用。退避 Ctrl+Alt 家族（navBack/Forward、saveAll
  // 同款先例）；越界（无书签）由消费方 veto 放行
  { id: 'bookmarkPrev', default: 'ctrl+alt+pageup', domain: 'global' },
  { id: 'bookmarkNext', default: 'ctrl+alt+pagedown', domain: 'global' },
  { id: 'newUntitledDraft', default: 'ctrl+alt+n', domain: 'global' },
  // 全部保存（P-20261002-101，Ctrl+Alt+S）：Monaco 内 Ctrl+S 是编辑器域单文件保存
  //（不在布局键位链），此键走全局 saveAll 串联双组全部脏文件。Ctrl+Alt 家族与
  // newUntitledDraft 同款退避（Ctrl+S 由编辑器域占用）
  { id: 'saveAll', default: 'ctrl+alt+s', domain: 'global' },
  { id: 'commandPalette', default: 'ctrl+k', domain: 'global' },
  { id: 'openSettings', default: 'ctrl+,', domain: 'global' },
  { id: 'commandMode', default: 'ctrl+shift+p', domain: 'global' },
  { id: 'quickOpen', default: 'ctrl+p', domain: 'global' },
  { id: 'projectSearch', default: 'ctrl+shift+f', domain: 'global' },
  { id: 'outline', default: 'ctrl+shift+o', domain: 'global' },
  // 多剪贴板粘贴（P-20261002-149，JetBrains paste from history 同语义）：呼出
  // 剪贴板历史选择弹层。JetBrains 原键 Ctrl+Shift+V 已被 previewToggle 占用
  //（P-69 在先），退避为 Ctrl+Alt+V（同 Alt+Shift+T / Ctrl+Alt+N 退避先例），
  // 用户可在设置→快捷键改绑
  { id: 'clipHistoryPaste', default: 'ctrl+alt+v', domain: 'global' },
  // Markdown 模式循环（P-20261003-18，仅 .md 文件激活）：source→preview→split
  // 循环切换。VS Code markdown 预览键 Ctrl+Shift+V 已被 previewToggle 占用
  //（P-69 在先），退避同族 M 键（Markdown 首字母，无浏览器强占面），可改绑
  { id: 'mdModeCycle', default: 'ctrl+shift+m', domain: 'global' },

  // ---- 终端域动作（P-20261003-111，逐域渐进先行落地）----
  // 注册序在本域内即优先序；与全局域同键的默认（ctrl+shift+v 粘贴 × previewToggle、
  // ctrl+pageup/pagedown 循环切 tab × 标签线性切换等）是既有 focus 分层共存，
  // 跨域不按注册序判遮蔽（见 conflicts）。消费方分两档：
  //   doc  级 = TerminalView document 监听（键位全域生效，跨域撞键 takeover 语义，
  //           集合见 TERMINAL_DOC_ACTIONS）
  //   xterm 级 = useTerminalKeys customKeyEventHandler（仅终端聚焦时生效，跨域撞键
  //           focus 共存语义）
  { id: 'terminalHistory', default: 'ctrl+shift+h', domain: 'terminal' },
  // 片段面板（P-20261003-43）：与历史同域相邻键位（H→J），开此关彼与工具条按钮同源
  { id: 'terminalSnippet', default: 'ctrl+shift+j', domain: 'terminal' },
  // 字号三键：+ 为 = 的移位字符（匹配面含移位变体，见 comboVariants；canonicalCombo
  // 对尾缀 '+' 主键按 '+' 摘出解析，ctrl++ 同样可表示），以 ctrl+= 为规范主键位
  { id: 'terminalFontIn', default: 'ctrl+=', domain: 'terminal' },
  { id: 'terminalFontOut', default: 'ctrl+-', domain: 'terminal' },
  { id: 'terminalFontReset', default: 'ctrl+0', domain: 'terminal' },
  { id: 'terminalSearch', default: 'ctrl+f', domain: 'terminal' },
  // 复制主键位（xterm 焦点域、有选区时拦截）；Ctrl/Cmd+C 有选区复制是历史副键位，
  // 不入注册表维持硬编码（改绑主键位后副键位保留，见 useTerminalKeys）
  { id: 'terminalCopy', default: 'ctrl+shift+c', domain: 'terminal' },
  { id: 'terminalPaste', default: 'ctrl+shift+v', domain: 'terminal' },
  { id: 'terminalSplitH', default: 'ctrl+shift+\\', domain: 'terminal' },
  { id: 'terminalSplitV', default: 'ctrl+shift+-', domain: 'terminal' },
  // 关 pane：浏览器保留键（RESERVED_COMBOS）——默认即 ctrl+shift+w 可用，改绑离场
  // 放行、任何动作改绑到此键录入即拒（同锁定键域语义）
  { id: 'terminalClosePane', default: 'ctrl+shift+w', domain: 'terminal' },
  // pane 焦点切换（P-20261004-111，编辑器组 focusOtherGroup 同款对称）：分屏双
  // pane 键盘互切。Ctrl+Alt+- 与编辑器组键（ctrl+shift+\ / ctrl+\）区分、与字号
  // 减键 ctrl+- 错开，ctrl+alt 家族退避先例同 navBack/newUntitledDraft；单 pane
  // 时按键不拦截照旧转发 PTY（useTerminalKeys 消费侧按宿主裁决放行）——终端程
  // 序输入面 Ctrl+Alt+- 无 readline/shell 惯用绑定，罕见组合，吞键风险可忽略
  { id: 'termFocusOtherPane', default: 'ctrl+alt+-', domain: 'terminal' },
  // 循环切 tab（浏览器同键切 tab 惯例）：与 switchTabPrev/Next（编辑器标签）同键
  // 默认是焦点域分层共存——终端聚焦时 xterm 拦截链优先，其余场景布局链生效
  { id: 'terminalCyclePrev', default: 'ctrl+pageup', domain: 'terminal' },
  { id: 'terminalCycleNext', default: 'ctrl+pagedown', domain: 'terminal' },
  // 命令块跳过导航（P-20261003-269，对标 VS Code 终端命令导航 Ctrl+Shift+↑/↓）：
  // 长输出命令块间掠读——跳到上一/下一命令块起点（回显行）并滚动定位。无 shell
  // 集成会话无 C 帧锚点，按键零响应（降级现状，提案自身设计含降级）
  { id: 'terminalCmdPrev', default: 'ctrl+shift+arrowup', domain: 'terminal' },
  { id: 'terminalCmdNext', default: 'ctrl+shift+arrowdown', domain: 'terminal' },
  // 书签列表（P-20261004-16，doc 级——面板开关与历史/片段同族）：该会话
  // scrollback 书签浮层。对标 VS Code Bookmarks 扩展的默认 toggle 键 Ctrl+Alt+K；
  // 直觉键 Ctrl+Shift+B 是浏览器书签栏键、Ctrl+Alt+B 被 Monaco 内建书签占用
  // （静态清单 keyInventory 在案），退避同族（navBack/Forward 同款先例），用户可
  // 在设置→快捷键改绑
  { id: 'terminalBookmarkList', default: 'ctrl+alt+k', domain: 'terminal' },

  // ---- 编辑器域动作（P-20261008-14，改绑体系三域收口）----
  // Monaco 自定义动作键位入注册表：MonacoEditor 挂载按生效值 addAction、变更
  // 重注册（Monaco standalone 无运行时改绑 API，addAction 返回的 Disposable 是
  // 官方摘除面，重注册即改绑——见 views/editor/editorKeymapBindings.ts）。
  // 边界：Monaco 内建键（Ctrl+F/H/D 等）不改绑，静态清单 keyInventory 继续作
  // 冲突扫描面。与全局域同键默认（ctrl+k × commandPalette）是焦点域分层共存：
  // 编辑器聚焦且有选区时编辑器侧接管（Monaco 拦截 + 停传播），其余场景全局侧
  // 生效——默认态白名单共存不标红（同 ctrl+shift+v 先例），改绑侧提示见 conflicts
  // 单文件保存（Monaco 聚焦域，addAction save-file）：与全局 saveAll（Ctrl+Alt+S
  // 串联双组全部脏文件）分工同 keyInventory.ctrl+s 先例注记，Ctrl+S 内建占用
  //（编辑器域单文件保存）故 saveAll 退避 Ctrl+Alt 家族
  { id: 'editorSave', default: 'ctrl+s', domain: 'editor' },
  // 光标处切换书签（编辑器域书签族：跳转 bookmarkPrev/Next 已在全局域注册表，
  // 本动作是行内 toggle，addAction sc-bookmark.toggle + 右键菜单 9_scbookmark 组）
  { id: 'editorBookmarkToggle', default: 'ctrl+alt+b', domain: 'editor' },
  // 选区内联 AI 编辑（P-20261005-206 浮条，addAction sc-ask.inline-edit）：
  // precondition editorHasSelection——无选区不接管，放行 Monaco 内建 Ctrl+K
  // chord 前缀（既有行为零变化）；改绑后 precondition 语义不变（无选区不触发）
  { id: 'editorInlineEdit', default: 'ctrl+k', domain: 'editor' },

  // ---- 笔记面板域（P-20261107-5，笔记库独立化：快捷新建 + 快捷键保存命名）----
  // 消费方 useNotesKeyboard：document capture 相位监听，事件 target 在笔记面板
  // 根节点内才接管（焦点域——面板外按键零影响，面板未挂载即无监听）；接管后
  // stopImmediatePropagation，布局链不再收到。与编辑器域 editorSave 同为
  // ctrl+s 默认：两焦点域生效条件物理互斥（Monaco 聚焦 vs 笔记面板聚焦），
  // 同 editor×terminal 不标红口径。保存在笔记未命名且有内容时顺带弹命名框
  //（notepad「保存即命名」心智，取消即本会话不再追问）
  { id: 'notesSave', default: 'ctrl+s', domain: 'notes' },
  // 新建笔记：Ctrl+Alt+N 已被全局 newUntitledDraft 占用、Ctrl+N 是浏览器保留
  // 键，退避同族 M（Memo）——Ctrl+Alt+M 在 Monaco 内核/浏览器/本注册表三面
  // 均无占用
  { id: 'notesCreate', default: 'ctrl+alt+m', domain: 'notes' },
  // 重命名当前笔记：F2（VS Code rename 惯例）是单键无修饰、不在布局键捕获面
  //（normalizeLayoutCombo 要求 ≥1 修饰符），退避 Ctrl+Alt+R（三面无占用）
  { id: 'notesRename', default: 'ctrl+alt+r', domain: 'notes' },
] as const

export type KeymapAction = (typeof KEYMAP_ACTIONS)[number]['id']
export type KeymapActionCombo = Record<KeymapAction, string>

/** 注册表键序（供按序遍历，避免 Object.keys 顺序依赖） */
export const KEYMAP_ACTION_ORDER = KEYMAP_ACTIONS.map(a => a.id) as KeymapAction[]

/** 动作 → 作用域域（设置分区分组展示 + 跨域冲突语义判定） */
export const KEYMAP_ACTION_DOMAIN = Object.fromEntries(
  KEYMAP_ACTIONS.map(a => [a.id, a.domain]),
) as Record<KeymapAction, KeymapDomain>

/** 域展示序（设置→快捷键分组顺序；审批域入注册表时按序追加） */
export const KEYMAP_DOMAINS: readonly KeymapDomain[] = ['global', 'terminal', 'editor', 'notes']

/** doc 级终端动作：TerminalView document 监听消费、键位全域生效——跨域撞键是
 *  takeover 语义（终端域优先接管，全局侧让位），与 xterm 焦点域的共存语义相区分 */
export const TERMINAL_DOC_ACTIONS: ReadonlySet<KeymapAction> = new Set<KeymapAction>([
  'terminalHistory',
  'terminalSnippet',
  'terminalFontIn',
  'terminalFontOut',
  'terminalFontReset',
  'terminalBookmarkList',
])

/** 出厂默认表（与用户覆盖合并前的基线；keyInventory.test 默认撞键白名单守卫用） */
export const KEYMAP_DEFAULTS: KeymapActionCombo = Object.fromEntries(
  KEYMAP_ACTIONS.map(a => [a.id, a.default]),
) as KeymapActionCombo

// localStorage key：用户覆盖表（仅存 ≠ 默认的项），JSON 序列化
const OVERRIDES_KEY = 'sc.keymapOverrides'
// key 导出（同 dnd.ts DND_STORAGE_KEY 惯例）：设置导出/导入（utils/settingsTransfer
// 白名单）与 e2e 播种 import 常量，避免字面量散落导致漂移
export const KEYMAP_OVERRIDES_STORAGE_KEY = OVERRIDES_KEY

// ---- 组合键规范化与匹配 ----------------------------------------------------
//
// 布局键位的 meta ≡ ctrl 语义：useLayoutKeyboard 旧实现用 `isMod = ctrlKey ||
// metaKey` 判定（mac 上 Cmd/Ctrl 均可触发），matchShortcut 则对 ctrl/meta 精确
// 区分。为不回归 mac 双键可用性，布局键统一「归一化到 ctrl 规范形」存储与匹配：
// 捕获时 meta 归并为 ctrl，匹配时事件同样归并后做字符串全等。

/** 修饰符单键（无主键）不算有效组合 */
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'option', 'cmd', 'command'])

/**
 * KeyboardEvent → 布局键规范 combo（meta 并入 ctrl；无修饰符或纯 modifier → ''）
 * @example Ctrl/Cmd+Alt+N 按下 → 'ctrl+alt+n'
 */
export function normalizeLayoutCombo(e: KeyboardEvent): string {
  const key = (e.key || '').toLowerCase()
  if (!key || MODIFIER_KEYS.has(key)) return ''
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  // 布局键位一律要求 ≥1 个修饰符（同 eventToShortcut 口径，防单字母误绑）
  if (parts.length === 0) return ''
  parts.push(key)
  return parts.join('+')
}

/**
 * combo 字符串 → 布局键规范形（meta→ctrl、去空格、统一小写）；
 * 空串/无法解析出主键 → ''。存储读取与冲突比对统一走这里。
 * 主键 '+' 会被按位 split 吞掉（'ctrl++'.split('+') 无主键段）：先探尾缀 '+'
 * 摘出主键（同审计脚本 canon 口径，P-20261003-111 终端域移位字符变体面需要）
 */
export function canonicalCombo(combo: string): string {
  if (!combo) return ''
  let key = ''
  let c = combo.toLowerCase()
  if (c.endsWith('+')) {
    key = '+'
    c = c.slice(0, -1)
  }
  const mods: string[] = []
  for (const tok of c.split('+').map(s => s.trim()).filter(Boolean)) {
    if (tok === 'ctrl' || tok === 'control' || tok === 'meta' || tok === 'cmd' || tok === 'command' || tok === 'mod') mods.push('ctrl')
    else if (tok === 'alt' || tok === 'option') mods.push('alt')
    else if (tok === 'shift') mods.push('shift')
    else if (!MODIFIER_KEYS.has(tok)) key = tok
  }
  if (!key) return ''
  // 规范修饰符序：ctrl < alt < shift（去重）
  const ordered = [mods.includes('ctrl') ? 'ctrl' : '', mods.includes('alt') ? 'alt' : '', mods.includes('shift') ? 'shift' : ''].filter(Boolean)
  ordered.push(key)
  return ordered.join('+')
}

/** 事件是否命中布局键 combo（双方均按规范形比较） */
export function matchLayoutCombo(e: KeyboardEvent, combo: string): boolean {
  const canonical = canonicalCombo(combo)
  return !!canonical && normalizeLayoutCombo(e) === canonical
}

// ---- 组合键变体（移位字符容差） ----------------------------------------------
//
// 真实键盘/Playwright 对部分 Shift 组合上报「移位字符」而非物理键（Windows
// Chromium Shift+` 报 '~'、Shift+\ 报 '|'、Shift+= 报 '+'、Shift+- 报 '_'），
// 归一化全等匹配下需对带 shift 的键位显式并检移位变体。映射表全局共享：
// 布局链（useLayoutKeyboard matchesAction）与终端域（useTerminalKeys/TerminalView
// 的 comboVariants 匹配）同源，新增移位字符键在此补充

/** 主键的 Shift 字符映射（US 布局物理键 → 移位字符） */
export const SHIFTED_KEY_ALIASES: Readonly<Record<string, string>> = {
  '`': '~',
  '\\': '|',
  '=': '+',
  '-': '_',
}

/** bound combo 的 ±Shift 变体（'ctrl+tab' → 'ctrl+shift+tab'；已含 shift → ''） */
export function withShiftVariant(combo: string): string {
  const canonical = canonicalCombo(combo)
  if (!canonical || canonical.includes('shift')) return ''
  const idx = canonical.lastIndexOf('+')
  return `${canonical.slice(0, idx)}+shift+${canonical.slice(idx + 1)}`
}

/** 主键的移位字符变体（'ctrl+shift+\\' → 'ctrl+shift+|'）：带 shift 的键位在部分
 *  平台按移位字符上报，主键无映射时返回 '' */
export function withShiftedKey(combo: string): string {
  const canonical = canonicalCombo(combo)
  if (!canonical) return ''
  const idx = canonical.lastIndexOf('+')
  const shifted = SHIFTED_KEY_ALIASES[canonical.slice(idx + 1)]
  return shifted ? `${canonical.slice(0, idx + 1)}${shifted}` : ''
}

/**
 * combo 的运行时可命中变体集（P-20261003-111 终端域匹配面）：
 *   - 规范形本体
 *   - 主键移位字符形（'ctrl+shift+\\' → 'ctrl+shift+|'）
 *   - ±Shift 变体的移位字符形（'ctrl+=' → 'ctrl+shift+=' → 'ctrl+shift++'，
 *     字号键「= / + 同义」的旧匹配惯例在改键后跟随新键位派生）
 * 不含纯 ±Shift 变体——终端域键位默认是精确 shift 语义（'ctrl+f' 不命中
 * 'ctrl+shift+f'），仅移位字符是同物理键的平台上报差异
 */
export function comboVariants(combo: string): string[] {
  const canonical = canonicalCombo(combo)
  if (!canonical) return []
  const out = new Set<string>([canonical])
  const shifted = withShiftedKey(canonical)
  if (shifted) out.add(shifted)
  const withShift = withShiftVariant(canonical)
  if (withShift) {
    const shiftedShift = withShiftedKey(withShift)
    if (shiftedShift) out.add(shiftedShift)
  }
  return [...out]
}

// ---- 浏览器保留键黑名单（录入时拦截） --------------------------------------
//
// Chrome 无法 preventDefault 拦截的导航类组合，改绑会让动作永远不触发；
// ctrl+w 是本产品启动即拦截的既有例外（历史行为），保留可绑。
// 规范形即覆盖 ctrl/meta 两种修饰键（mac 上 meta 归并为 ctrl）。
export const RESERVED_COMBOS: ReadonlySet<string> = new Set([
  'ctrl+n', 'ctrl+shift+n',       // 新建窗口 / 隐身窗口
  'ctrl+t', 'ctrl+shift+t',       // 新建标签 / 重开关闭标签
  'ctrl+q', 'ctrl+shift+q',       // 退出浏览器
  'ctrl+shift+w',                 // 关闭窗口（非 shift 的 ctrl+w 为既有产品例外）
])

export function isReservedCombo(combo: string): boolean {
  const canonical = canonicalCombo(combo)
  return !!canonical && RESERVED_COMBOS.has(canonical)
}

// ---- 展示：规范 combo → 键帽数组 -------------------------------------------
//
// 'ctrl+shift+p' → ['Ctrl', 'Shift', 'P']；与 ShortcutsHelp 的 <kbd> 行、
// 设置分区改键行共用（平台修饰键标签维持现状全局统称 Ctrl，同现有备忘单）

const KEYCAP_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Esc',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
}

export function keycapParts(combo: string): string[] {
  return canonicalCombo(combo)
    .split('+')
    .filter(Boolean)
    .map(part => KEYCAP_LABELS[part]
      ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
}

// ---- store ------------------------------------------------------------------

/** 键位冲突信息：与同域动作撞键（注册序靠后者不生效）、与锁定快捷键撞键（锁定
 *  优先级最高）或跨域同键（P-20261003-111 域分层语义，见 cross；P-20261008-14 起
 *  编辑器域入注册表同享 focus 共存语义） */
export interface KeymapConflict {
  kind: 'action' | 'lock'
  /** kind=action 时：生效的另一动作 id */
  other?: KeymapAction
  /** 跨域同键标注：takeover = doc 级终端动作全局接管（全局侧不生效，无论谁改绑）；
   *  focus = 焦点域分层共存（terminal xterm 级 / editor Monaco 聚焦域——聚焦侧
   *  优先〔editor 侧依赖 Monaco 拦截 + 停传播〕，其余场景全局侧生效）。
   *  缺省 = 同域注册序冲突 */
  cross?: 'takeover' | 'focus'
}

export type SetBindingResult = 'ok' | 'reserved' | 'invalid'

export const useKeymapStore = defineStore('keymap', () => {
  // 用户覆盖表：仅存 ≠ 默认的规范 combo（默认值变更/新增动作自动流经默认表）
  const overrides = ref<Partial<Record<KeymapAction, string>>>(readOverrides())

  function readOverrides(): Partial<Record<KeymapAction, string>> {
    try {
      const raw = safeStorage.getItem(OVERRIDES_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Partial<Record<KeymapAction, string>>
      if (!parsed || typeof parsed !== 'object') return {}
      // 只收合法动作 id + 规范化 combo（防手改存储注入脏数据）
      const result: Partial<Record<KeymapAction, string>> = {}
      for (const id of KEYMAP_ACTION_ORDER) {
        const canonical = canonicalCombo(parsed[id] || '')
        // 保留键历史脏数据不生效（缺省回默认）
        if (canonical && !isReservedCombo(canonical)) result[id] = canonical
      }
      return result
    } catch {
      return {}
    }
  }

  function persist(): void {
    const raw = JSON.stringify(overrides.value)
    if (Object.keys(overrides.value).length > 0) {
      safeStorage.setItem(OVERRIDES_KEY, raw)
    } else {
      safeStorage.removeItem(OVERRIDES_KEY)
    }
    // 服务端漫游双写（P-20261007-1）：localStorage 镜像照旧，上云编排经
    // userPrefsLink 脏标记交给 userPrefs store（防抖合并为一次 PUT）
    notifyUserPrefsDirty()
  }

  /**
   * 整表替换用户覆盖（P-20261007-1 服务端漫游应用入口）：远端 userPrefs 的
   * keymap 段应用到本机。逐项规范化 + 保留键拒绝（与 readOverrides/setBinding
   * 同口径），非法项丢弃 = 回落默认；经 persist 落镜像并触发上云
   * （applyRemote 的抑制窗口内不回环）
   */
  function replaceAll(next: Partial<Record<KeymapAction, string>>): void {
    const clean: Partial<Record<KeymapAction, string>> = {}
    for (const id of KEYMAP_ACTION_ORDER) {
      const canonical = canonicalCombo(next[id] || '')
      if (canonical && !isReservedCombo(canonical)) clean[id] = canonical
    }
    overrides.value = clean
    persist()
  }

  /** 生效键位表（默认 + 覆盖合并），keymap 消费方统一读这里 */
  const combos = computed<KeymapActionCombo>(() => {
    const merged = { ...KEYMAP_DEFAULTS }
    for (const id of KEYMAP_ACTION_ORDER) {
      const override = overrides.value[id]
      if (override) merged[id] = override
    }
    return merged
  })

  /**
   * 改绑动作：combo 规范化后写入并持久化；等于默认值时等价于恢复默认（删覆盖）。
   * 浏览器保留键拒绝（调用方提示，不落盘）
   */
  function setBinding(action: KeymapAction, combo: string): SetBindingResult {
    const canonical = canonicalCombo(combo)
    if (!canonical) return 'invalid'
    if (isReservedCombo(canonical)) return 'reserved'
    if (canonical === KEYMAP_DEFAULTS[action]) {
      delete overrides.value[action]
    } else {
      overrides.value[action] = canonical
    }
    persist()
    return 'ok'
  }

  /** 恢复单个动作默认键位 */
  function resetBinding(action: KeymapAction): void {
    delete overrides.value[action]
    persist()
  }

  /** 全部恢复默认（清空覆盖表） */
  function resetAll(): void {
    overrides.value = {}
    persist()
  }

  /** 事件是否命中任一布局键位（数字直达捕获链让位判断用） */
  function claimsCombo(e: KeyboardEvent): boolean {
    const combo = normalizeLayoutCombo(e)
    if (!combo) return false
    return KEYMAP_ACTION_ORDER.some(id => combos.value[id] === combo)
  }

  // doc 级终端动作的宿主在场标志：TerminalView（BottomPanel v-if 挂载）onMounted
  // 置位 / onBeforeUnmount 复位。useLayoutKeyboard 的让位判定只在终端域监听真实
  // 在场时生效——面板切到 git/console 等分区时 doc 级键位无消费方，布局链照常接管
  const terminalDocActive = ref(false)

  /** 事件是否命中任一 doc 级终端动作（useLayoutKeyboard 布局链让位判断用）：
   *  doc 级键位跨域撞键是 takeover 语义（终端域优先），布局链命中即整体让位，
   *  由 TerminalView 消费（保存时警示已按 takeover 语义告知） */
  function docClaimsCombo(e: KeyboardEvent): boolean {
    if (!terminalDocActive.value) return false
    const combo = normalizeLayoutCombo(e)
    if (!combo) return false
    for (const id of TERMINAL_DOC_ACTIONS) {
      if (combos.value[id] === combo) return true
    }
    return false
  }

  // 冲突表（P-20261003-111 域感知，P-20261008-14 编辑器域扩展，P-20261107-5
  // 笔记面板域扩展）：
  // - 同域同 combo：注册序靠后者被靠前者遮蔽（键序即优先序）
  // - 跨域同 combo：域分层消解，不按注册序——doc 级终端动作（document 全局监听）
  //   撞全局动作时全局侧让位（takeover，无论谁改绑都成立，按域位置定生死）；焦点域
  //   动作（terminal xterm 级 / editor Monaco 聚焦域 / notes 笔记面板聚焦域）与全局
  //   动作是共存（聚焦侧优先，其余场景全局侧生效），默认态的同键双默认
  //   （ctrl+shift+v / ctrl+k 等白名单）是既有审计共存，任一侧改绑才提示。诚实
  //   边界：焦点域两两之间（editor × terminal / editor × notes〔ctrl+s 双默认〕/
  //   editor × doc 级）同键不在此标——生效条件物理互斥（Monaco 聚焦 vs 终端
  //   聚焦/在场 vs 笔记面板聚焦），保存时警示（keyInventory findBindingConflicts）
  //   已按 focus 提示，行内不重复标红
  // - 与锁定快捷键撞键时全部动作被遮蔽（useLayoutKeyboard 先判锁定）
  const conflicts = computed<Record<KeymapAction, KeymapConflict | null>>(() => {
    const result = Object.fromEntries(KEYMAP_ACTION_ORDER.map(id => [id, null])) as Record<KeymapAction, KeymapConflict | null>
    const firstOwner = new Map<string, KeymapAction>()
    for (const id of KEYMAP_ACTION_ORDER) {
      const k = `${KEYMAP_ACTION_DOMAIN[id]}|${combos.value[id]}`
      const owner = firstOwner.get(k)
      if (owner) {
        result[id] = { kind: 'action', other: owner }
      } else {
        firstOwner.set(k, id)
      }
    }
    for (const id of KEYMAP_ACTION_ORDER) {
      const domain = KEYMAP_ACTION_DOMAIN[id]
      if (domain === 'global') continue
      const combo = combos.value[id]
      const counterpart = KEYMAP_ACTION_ORDER.find(g => KEYMAP_ACTION_DOMAIN[g] === 'global' && combos.value[g] === combo)
      if (!counterpart) continue
      if (domain === 'terminal' && TERMINAL_DOC_ACTIONS.has(id)) {
        if (result[counterpart] === null) result[counterpart] = { kind: 'action', other: id, cross: 'takeover' }
      } else if (overrides.value[id] || overrides.value[counterpart]) {
        // 默认态双默认同键不标（白名单共存）；改绑侧提示共存影响
        if (overrides.value[counterpart] && result[counterpart] === null) result[counterpart] = { kind: 'action', other: id, cross: 'focus' }
        if (overrides.value[id] && result[id] === null) result[id] = { kind: 'action', other: counterpart, cross: 'focus' }
      }
    }
    const lockCombo = canonicalCombo(useLockStore().lockShortcut)
    if (lockCombo) {
      for (const id of KEYMAP_ACTION_ORDER) {
        if (combos.value[id] === lockCombo) {
          result[id] = { kind: 'lock' }
        }
      }
    }
    return result
  })

  return {
    overrides,
    combos,
    conflicts,
    terminalDocActive,
    setBinding,
    resetBinding,
    resetAll,
    replaceAll,
    claimsCombo,
    docClaimsCombo,
  }
})
