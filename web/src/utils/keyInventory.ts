// 静态键清单（P-20261003-106）：键位自定义保存时的冲突扫描数据源。
//
// 同源注记：本清单镜像 scripts/check-keybindings.mjs 静态提取的「非 keymap 注册表」
// 键位（monaco/vendor 编辑器域、global 硬编码键、终端区间键）；审计脚本
// checkRuntimeInventory() 对本文件与实际注册做双向对账——清单条目失效或新注册键
// 未镜像都会在 npm run check 报 error，两表不会静默漂移。keymap 注册表动作（含
// P-20261003-111 起的终端域、P-20261008-14 起的编辑器域自定义动作）与锁定快捷键
// 不入本清单——store conflicts 已按域语义覆盖（见 useKeymapStore.conflicts），清单
// 只兜注册表外的硬编码键位面。
//
// 诚实边界：escape / ? / monitor 大屏裸 R / 审批 1/2/3 为单键无修饰符，
// normalizeLayoutCombo 捕获面之外永不撞键，审批单键作清单镜像保真（P-99 入表
// 惯例）、其余不镜像；terminal 的 ctrl++（= 的移位字符变体）是 keymap 注册表
// 字号键（terminalFontIn）的匹配面变体（comboVariants），不单独镜像。

import {
  canonicalCombo, KEYMAP_ACTION_DOMAIN, KEYMAP_ACTION_ORDER, TERMINAL_DOC_ACTIONS,
  type KeymapAction, type KeymapActionCombo,
} from '../stores/keymap'

/** 冲突作用域（i18n 标签见 keymap.invScope.*） */
export type ConflictScope = 'editor' | 'terminal' | 'global' | 'approval'

export interface StaticKeyEntry {
  /** 规范形 combo（canonicalCombo 幂等：canonicalCombo(combo) === combo） */
  combo: string
  scope: ConflictScope
  /** 功能名 i18n 键（keymap.inv.*，双语包同步维护） */
  labelKey: string
  /** i18n 插值参数（如数字直达的 {n}） */
  params?: Record<string, unknown>
  /** 撞键后果：focus = 聚焦域分层共存（对方聚焦时优先生效，其余场景本动作生效）；
   *  takeover = 本动作接管对方键位（数字直达 claimsCombo 让位 / 气泡链布局动作先于
   *  diff 导航判定——保存即覆盖，提案「保存将覆盖」语义的如实落点） */
  semantics: 'focus' | 'takeover'
}

/** 编辑器域：Monaco 内建默认键位 + 内建键位接管（P-20261008-14 起本项目自定义
 *  动作 save-file/sc-bookmark.toggle/sc-ask.inline-edit 已入 keymap 编辑器域注册表，
 *  由 store conflicts 按域语义覆盖不再入清单——同终端单组合键先例；清单只兜
 *  不改绑的 Monaco 内建键，继续作冲突扫描面，见 stores/keymap.ts 诚实边界） */
const EDITOR_ENTRIES: StaticKeyEntry[] = [
  { combo: 'ctrl+f', scope: 'editor', labelKey: 'keymap.inv.editorFind', semantics: 'focus' },
  { combo: 'ctrl+h', scope: 'editor', labelKey: 'keymap.inv.editorReplace', semantics: 'focus' },
  { combo: 'ctrl+d', scope: 'editor', labelKey: 'keymap.inv.editorMultiCursor', semantics: 'focus' },
  // 跨文件跳转键位接管（P-20261004-45，monacoProjectContext addAction）：f12 原生
  // 单键无修饰符本不在布局链捕获面，随 shift+f12 成对镜像保真
  { combo: 'f12', scope: 'editor', labelKey: 'keymap.inv.editorGotoDefinition', semantics: 'focus' },
  { combo: 'shift+f12', scope: 'editor', labelKey: 'keymap.inv.editorGotoReferences', semantics: 'focus' },
]

/** 终端域区间键（P-20261003-111 起终端单组合键入 keymap 注册表，此处只剩不可
 *  单键建模的区间族——Alt+1-9 切终端标签 / Ctrl+Shift+1-9 切终端 tab） */
const TERMINAL_ENTRIES: StaticKeyEntry[] = [
  { combo: 'alt+1', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 1 }, semantics: 'focus' },
  { combo: 'alt+2', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 2 }, semantics: 'focus' },
  { combo: 'alt+3', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 3 }, semantics: 'focus' },
  { combo: 'alt+4', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 4 }, semantics: 'focus' },
  { combo: 'alt+5', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 5 }, semantics: 'focus' },
  { combo: 'alt+6', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 6 }, semantics: 'focus' },
  { combo: 'alt+7', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 7 }, semantics: 'focus' },
  { combo: 'alt+8', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 8 }, semantics: 'focus' },
  { combo: 'alt+9', scope: 'terminal', labelKey: 'keymap.inv.terminalTabN', params: { n: 9 }, semantics: 'focus' },
  { combo: 'ctrl+shift+1', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 1 }, semantics: 'focus' },
  { combo: 'ctrl+shift+2', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 2 }, semantics: 'focus' },
  { combo: 'ctrl+shift+3', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 3 }, semantics: 'focus' },
  { combo: 'ctrl+shift+4', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 4 }, semantics: 'focus' },
  { combo: 'ctrl+shift+5', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 5 }, semantics: 'focus' },
  { combo: 'ctrl+shift+6', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 6 }, semantics: 'focus' },
  { combo: 'ctrl+shift+7', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 7 }, semantics: 'focus' },
  { combo: 'ctrl+shift+8', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 8 }, semantics: 'focus' },
  { combo: 'ctrl+shift+9', scope: 'terminal', labelKey: 'keymap.inv.terminalTabSwitchN', params: { n: 9 }, semantics: 'focus' },
]

/** 全局硬编码键（useLayoutKeyboard，keymap 可改键 MVP 范围外）：数字直达经
 *  claimsCombo 让位、diff 导航在布局动作匹配落空后才判定——被改绑即被接管 */
const GLOBAL_HARDCODED_ENTRIES: StaticKeyEntry[] = [
  { combo: 'ctrl+1', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 1 }, semantics: 'takeover' },
  { combo: 'ctrl+2', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 2 }, semantics: 'takeover' },
  { combo: 'ctrl+3', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 3 }, semantics: 'takeover' },
  { combo: 'ctrl+4', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 4 }, semantics: 'takeover' },
  { combo: 'ctrl+5', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 5 }, semantics: 'takeover' },
  { combo: 'ctrl+6', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 6 }, semantics: 'takeover' },
  { combo: 'ctrl+7', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 7 }, semantics: 'takeover' },
  { combo: 'ctrl+8', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 8 }, semantics: 'takeover' },
  { combo: 'ctrl+9', scope: 'global', labelKey: 'keymap.inv.railDigitN', params: { n: 9 }, semantics: 'takeover' },
  // Ctrl/Cmd+Alt+1-9 工作区预设直达（P-20261004-49）：面板数字直达同捕获链的
  // Alt 修饰分支，让位/门控纪律同源（锁定键/keymap 占用放行、锁屏门控、越界放行）
  { combo: 'ctrl+alt+1', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 1 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+2', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 2 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+3', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 3 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+4', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 4 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+5', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 5 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+6', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 6 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+7', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 7 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+8', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 8 }, semantics: 'takeover' },
  { combo: 'ctrl+alt+9', scope: 'global', labelKey: 'keymap.inv.presetDigitN', params: { n: 9 }, semantics: 'takeover' },
  { combo: 'alt+arrowup', scope: 'global', labelKey: 'keymap.inv.diffNavUp', semantics: 'takeover' },
  { combo: 'alt+arrowdown', scope: 'global', labelKey: 'keymap.inv.diffNavDown', semantics: 'takeover' },
  // 审批键盘裁决（P-20261003-1，P-20261003-99 入审计面）：待裁决卡在屏时的
  // focus 域单键——与编辑器/终端互不争抢（卡片不在屏时监听不挂载）
  { combo: '1', scope: 'approval', labelKey: 'keymap.inv.approvalDigit', params: { n: 1 }, semantics: 'focus' },
  { combo: '2', scope: 'approval', labelKey: 'keymap.inv.approvalDigit', params: { n: 2 }, semantics: 'focus' },
  { combo: '3', scope: 'approval', labelKey: 'keymap.inv.approvalDigit', params: { n: 3 }, semantics: 'focus' },
]

/** 静态键清单全表（一行一条的字面量表——审计脚本按行正则对账，勿改回循环生成） */
export const STATIC_KEY_ENTRIES: ReadonlyArray<StaticKeyEntry> = [
  ...EDITOR_ENTRIES,
  ...TERMINAL_ENTRIES,
  ...GLOBAL_HARDCODED_ENTRIES,
]

/** 冲突提示：动作撞键（同域注册序 / 跨域分层语义）/ 锁定快捷键 / 静态清单条目 */
export interface BindingConflict {
  kind: 'action' | 'lock' | 'static'
  /** kind=action：撞键的另一动作 id */
  other?: KeymapAction
  /** kind=action：true = 本动作注册序更早（或 doc 级终端动作接管语义），保存后对方
   *  被遮蔽（「保存将覆盖」）；false = 本动作被对方遮蔽（按键时对方优先） */
  takesOver?: boolean
  /** kind=action 跨域标注（P-20261003-111）：takeover = doc 级终端动作全局接管；
   *  focus = xterm 焦点域共存（终端聚焦时终端侧优先）。缺省 = 同域注册序冲突 */
  cross?: 'takeover' | 'focus'
  /** kind=static：静态清单条目（作用域 + 功能名 + 后果语义） */
  entry?: StaticKeyEntry
}

/**
 * 保存时冲突扫描（P-20261003-106 核心，P-20261003-111 域感知扩展，P-20261008-14
 * 编辑器域扩展）：把 action 改绑到 combo 前，扫布局注册表（同表其他动作）、锁定
 * 快捷键与静态键清单。全部条目并列返回（一键可同时撞多域，如 ctrl+shift+v 同时
 * 撞 previewToggle 与终端粘贴），由调用方逐条渲染警示。纯函数：combos 与
 * lockShortcut 由调用方传入，便于单测。
 *
 * 同域撞键按注册序判遮蔽；跨域撞键按域语义（与 useKeymapStore.conflicts 同口径）：
 * doc 级终端动作 × 全局动作 = document 全局监听、终端域优先接管（takesOver 按动作
 * 所在域定）；其余跨域组合（xterm 焦点域 × 全局 / 编辑器 Monaco 聚焦域 × 全局 /
 * doc 级 × 编辑器）= 焦点域分层共存（cross: 'focus'——聚焦/在场侧优先，Monaco 侧
 * 依赖拦截 + 停传播），无遮蔽生死，仅提示生效条件。
 */
export function findBindingConflicts(
  action: KeymapAction,
  combo: string,
  combos: KeymapActionCombo,
  lockShortcut: string,
): BindingConflict[] {
  const canonical = canonicalCombo(combo)
  if (!canonical) return []
  const out: BindingConflict[] = []
  const actionIdx = KEYMAP_ACTION_ORDER.indexOf(action)
  const actionDomain = KEYMAP_ACTION_DOMAIN[action]
  for (const id of KEYMAP_ACTION_ORDER) {
    if (id === action || combos[id] !== canonical) continue
    if (KEYMAP_ACTION_DOMAIN[id] === actionDomain) {
      out.push({ kind: 'action', other: id, takesOver: KEYMAP_ACTION_ORDER.indexOf(id) > actionIdx })
      continue
    }
    const otherDomain = KEYMAP_ACTION_DOMAIN[id]
    const selfDoc = actionDomain === 'terminal' && TERMINAL_DOC_ACTIONS.has(action)
    const otherDoc = otherDomain === 'terminal' && TERMINAL_DOC_ACTIONS.has(id)
    if ((selfDoc && otherDomain === 'global') || (otherDoc && actionDomain === 'global')) {
      // doc 级终端动作接管：终端域侧永远生效，全局侧被遮蔽（方向按本动作所在域定）
      out.push({ kind: 'action', other: id, takesOver: selfDoc, cross: 'takeover' })
    } else {
      // 焦点域（xterm 级 / 编辑器聚焦域）分层共存：聚焦侧优先、其余场景全局侧生效，
      // 无遮蔽生死，仅提示生效条件（编辑器域 P-20261008-14 起同享此语义）
      out.push({ kind: 'action', other: id, cross: 'focus' })
    }
  }
  const lock = canonicalCombo(lockShortcut || '')
  if (lock && lock === canonical) out.push({ kind: 'lock' })
  for (const entry of STATIC_KEY_ENTRIES) {
    if (entry.combo === canonical) out.push({ kind: 'static', entry })
  }
  return out
}

/** 生效键位的静态清单撞键（键位列表标红用）：仅对用户改绑过的键有意义——默认键位
 *  与终端等域的既有同键共存是审计白名单内的分层消解，不该标红 */
export function staticConflictsForCombo(combo: string): StaticKeyEntry[] {
  const canonical = canonicalCombo(combo)
  if (!canonical) return []
  return STATIC_KEY_ENTRIES.filter(e => e.combo === canonical)
}
