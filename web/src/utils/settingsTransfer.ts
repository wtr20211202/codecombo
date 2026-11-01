// 设置族配置导出/导入纯函数族（P-20261005-4）：多设备访问同一自托管实例是本
// 产品核心形态，而 font/keymap/locale/theme/通知本机偏好全在浏览器 localStorage
// （每设备各自为政，P-20261002-36 只解决同机多标签）——显式导出/导入是用户主导
// 的迁移包（blanket 自动同步是错误形态：缩放等合法的每设备差异存在，ui-zoom
// per-device 记忆同理不入包）。
//
// 硬纪律（提案红线）：
// - 导出只读白名单键（SECTION_DEFS 逐键枚举），绝不整包 dump localStorage——
//   防意外夹带令牌/凭据/主机信息等敏感项；
// - 应用侧只经各 store 既有 setter（消毒与响应性都经正门），不裸写 localStorage——
//   消毒链现成：keymap setBinding 规范化+保留键拒绝、locale setLocale 包存在性、
//   theme setTheme 注册表校验、dnd set 逐字段归一；font 经本模块 sanitizeFontPayload
//   后走 setSize/updateEditor（store 的 load 合并消毒不适用于逐 setter 链）；
// - 载荷带 schema 版本 + scSettings 家族标记（同 scCustomAgents/scUiState 惯例），
//   未知版本整体拒绝——分节值是各存储键的原样投影，跨版本键形状无法安全解释
//   （与 customAgentTransfer「版本只写不门禁」的取舍不同：那边字段可剥除，这边
//   值形状不可枚举，提案明确要求硬门禁）。
//
// 导出语义：只导出「偏离出厂默认的显式配置」——白名单键缺失 = 该项是默认值，
// 不入包（keymap 覆盖表/通知偏好本就只存非默认项；theme-settings 缺失 = OS 跟随，
// 导入端保持跟随语义不被冻结为具体主题）。

import {
  FONT_SETTINGS_KEY, AUTOSAVE_DELAY_MIN, AUTOSAVE_DELAY_MAX,
  sanitizeMonoFontName, LINE_HEIGHT_MULTIPLIERS, TERMINAL_CURSOR_STYLES,
  type FontSection, type EditorConfig, type UIFontFamily, type TerminalLigatures,
  type TerminalCursorStyle, type DiffPalette,
} from '../stores/font'
import {
  KEYMAP_OVERRIDES_STORAGE_KEY, KEYMAP_ACTION_ORDER, canonicalCombo, isReservedCombo,
  type KeymapAction,
} from '../stores/keymap'
import { THEME_SETTINGS_KEY } from '../stores/theme'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'
import { DND_STORAGE_KEY } from '../stores/dnd'
import { SOUND_STORAGE_KEY } from '../stores/sound'
import { NOTIFY_SIMPLE_STORAGE_KEY } from '../stores/notifySimple'
import { NOTIFY_SCROLL_READ_STORAGE_KEY } from '../stores/notifyScrollRead'

/** 导出文件 schema 版本：分节值形状变化时递增（导入端硬门禁） */
export const SETTINGS_TRANSFER_VERSION = 1

/** 设置分节：部分导入的勾选粒度（只迁键位不迁字号——每设备差异的精细控制） */
export type SettingsSectionKey = 'font' | 'keymap' | 'locale' | 'theme' | 'notify'

export const SETTINGS_SECTION_KEYS: readonly SettingsSectionKey[] = ['font', 'keymap', 'locale', 'theme', 'notify']

/** 字号合法区间（与设置页外观分区滑条 min=10/max=32 同口径） */
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 32

const FONT_SECTIONS: readonly FontSection[] = ['base', 'editor', 'terminal', 'diff', 'sidebar', 'bottom']

/** 编辑器布尔开关键（值非布尔丢弃，同 font store load 的布尔消毒口径） */
const EDITOR_BOOL_KEYS = ['insertSpaces', 'minimap', 'stickyScroll', 'formatOnSave', 'gitStatusTabs', 'bracketColor'] as const

/** 编辑器枚举键的合法值域（值域外丢弃） */
const EDITOR_ENUM_KEYS: Record<string, readonly string[]> = {
  wordWrap: ['on', 'off', 'wordWrapColumn'],
  renderWhitespace: ['none', 'selection', 'all'],
  autoSave: ['off', 'afterDelay'],
}

/** 单键节：节值 = 该存储键解析值原样（font/keymap 是对象，locale/theme 是字符串）；
 *  多键节（notify）：节值 = { field: 解析值 } */
interface SectionDef {
  key: SettingsSectionKey
  single: boolean
  entries: Array<{ storageKey: string; field?: string }>
}

/** 白名单（单一事实源）：导出按此枚举读取，导入只认这些分节键 */
const SECTION_DEFS: readonly SectionDef[] = [
  { key: 'font', single: true, entries: [{ storageKey: FONT_SETTINGS_KEY }] },
  { key: 'keymap', single: true, entries: [{ storageKey: KEYMAP_OVERRIDES_STORAGE_KEY }] },
  { key: 'locale', single: true, entries: [{ storageKey: LOCALE_STORAGE_KEY }] },
  { key: 'theme', single: true, entries: [{ storageKey: THEME_SETTINGS_KEY }] },
  { key: 'notify', single: false, entries: [
    { storageKey: DND_STORAGE_KEY, field: 'dnd' },
    { storageKey: SOUND_STORAGE_KEY, field: 'sound' },
    { storageKey: NOTIFY_SIMPLE_STORAGE_KEY, field: 'simple' },
    { storageKey: NOTIFY_SCROLL_READ_STORAGE_KEY, field: 'scrollRead' },
  ] },
]

// ---- 导出 ------------------------------------------------------------------

export interface SettingsExportPayload {
  /** 家族标记（导入端凭标记识别，同 scCustomAgents/scUiState 惯例） */
  scSettings: number
  version: number
  exportedAt: string
  sections: Partial<Record<SettingsSectionKey, unknown>>
}

/** 存储读取缝（生产传 safeStorage.getItem，测试注入内存表） */
export type StorageReader = (key: string) => string | null

/** 通知偏好三开关的存储编码是 '0'/'1' 哨兵（缺 key = 默认开/关），解析为布尔 */
function parseStored(storageKey: string, raw: string): unknown {
  if (storageKey === SOUND_STORAGE_KEY) return raw !== '0'
  if (storageKey === NOTIFY_SIMPLE_STORAGE_KEY) return raw === '1'
  if (storageKey === NOTIFY_SCROLL_READ_STORAGE_KEY) return raw === '1'
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 聚合白名单键现值为导出载荷；全部键缺失（= 全默认）时 sections 为空对象，
 *  由调用方决定是否按「无可导出」提示（WorkspaceBackup.empty 同款交互） */
export function buildSettingsExportPayload(read: StorageReader, now = new Date()): SettingsExportPayload {
  const sections: Partial<Record<SettingsSectionKey, unknown>> = {}
  for (const def of SECTION_DEFS) {
    if (def.single) {
      const raw = read(def.entries[0]!.storageKey)
      if (raw === null || raw === '') continue
      const v = parseStored(def.entries[0]!.storageKey, raw)
      // locale/theme 是裸字符串存储（JSON.parse 后仍为字符串）；脏值原样入包，
      // 应用端 setLocale/setTheme 的注册表校验会拒绝
      sections[def.key] = v
    } else {
      const sectionValue: Record<string, unknown> = {}
      for (const e of def.entries) {
        const raw = read(e.storageKey)
        if (raw === null || raw === '') continue
        sectionValue[e.field ?? e.storageKey] = parseStored(e.storageKey, raw)
      }
      if (Object.keys(sectionValue).length > 0) sections[def.key] = sectionValue
    }
  }
  return {
    scSettings: SETTINGS_TRANSFER_VERSION,
    version: SETTINGS_TRANSFER_VERSION,
    exportedAt: now.toISOString(),
    sections,
  }
}

// ---- 导入解析 ---------------------------------------------------------------

export type SettingsImportParseResult =
  | { ok: true; sections: Partial<Record<SettingsSectionKey, unknown>>; exportedAt: string }
  | { ok: false; reason: 'format' | 'version' }

/** 解析导入文件：包裹格式校验 + 版本硬门禁 + 分节键白名单过滤（未知分节剥除） */
export function parseSettingsImport(raw: unknown): SettingsImportParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'format' }
  const o = raw as Record<string, unknown>
  if (!o.scSettings) return { ok: false, reason: 'format' }
  if (o.version !== SETTINGS_TRANSFER_VERSION) return { ok: false, reason: 'version' }
  if (!o.sections || typeof o.sections !== 'object' || Array.isArray(o.sections)) {
    return { ok: false, reason: 'format' }
  }
  const rawSections = o.sections as Record<string, unknown>
  const sections: Partial<Record<SettingsSectionKey, unknown>> = {}
  for (const key of SETTINGS_SECTION_KEYS) {
    const v = rawSections[key]
    if (v !== undefined && v !== null) sections[key] = v
  }
  return { ok: true, sections, exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '' }
}

// ---- 分节投影与差异摘要（预览「各节条数 + 与本机不同 N 项」） ----------------
//
// 每节值 → 扁平「设置项 → 值」投影（只收形状合法的项）；导出侧与「本机现值」
// 走同一投影函数（组件用 store 现值装配同名结构传入），计数口径天然对称。
// 投影值为原始类型或 JSON 串（数组如 dnd.except 序列化后比较），!== 全等即可判差异。

export interface SanitizedFontPayload {
  sizes: Partial<Record<FontSection, number>>
  editor: Partial<EditorConfig>
  uiFont?: UIFontFamily
  terminalLigatures?: TerminalLigatures
  /** 自定义等宽字体名（P-20261005-227）：经 sanitizeMonoFontName 消毒，空串剥除
   *  （缺省项不触碰本机值——导入空名不覆盖本机已设名字） */
  monoFontName?: string
  /** 光标形态/闪烁（P-20261005-212）：形态只收三档合法值、闪烁只收布尔
   *  （值域外丢弃，缺省项不触碰本机值——与 store load 消毒同口径） */
  cursorStyle?: TerminalCursorStyle
  cursorBlink?: boolean
  /** diff 色板档（P-20261006-5）：值域外剥除（缺省项不触碰本机值） */
  diffPalette?: DiffPalette
}

function clampFontSize(n: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}

/** font 节值消毒（合并默认交给 store：消毒结果只含合法项，缺省项不触碰本机值）。
 *  逐字段类型/值域检查后产出可安全进 setter 的载荷——autoSaveDelayMs 钳制沿用
 *  font store 的 [MIN, MAX] 常量（应用端 setAutoSaveDelay 还会再钳一次，双保险） */
export function sanitizeFontPayload(value: unknown): SanitizedFontPayload {
  const out: SanitizedFontPayload = { sizes: {}, editor: {} }
  if (!value || typeof value !== 'object') return out
  const o = value as Record<string, unknown>
  if (o.sizes && typeof o.sizes === 'object' && !Array.isArray(o.sizes)) {
    const sizes = o.sizes as Record<string, unknown>
    for (const section of FONT_SECTIONS) {
      const n = Number(sizes[section])
      if (Number.isFinite(n)) out.sizes[section] = clampFontSize(n)
    }
  }
  if (o.editor && typeof o.editor === 'object' && !Array.isArray(o.editor)) {
    const e = o.editor as Record<string, unknown>
    const tab = Number(e.tabSize)
    if (Number.isFinite(tab)) out.editor.tabSize = Math.min(16, Math.max(1, Math.round(tab)))
    const delay = Number(e.autoSaveDelayMs)
    if (Number.isFinite(delay)) {
      out.editor.autoSaveDelayMs = Math.min(AUTOSAVE_DELAY_MAX, Math.max(AUTOSAVE_DELAY_MIN, Math.round(delay)))
    }
    // 行高倍率（P-20261006-7）：只收合法档位，档位外丢弃（缺省项不触碰本机值）
    const mult = Number(e.lineHeightMultiplier)
    if (LINE_HEIGHT_MULTIPLIERS.includes(mult)) out.editor.lineHeightMultiplier = mult
    for (const k of EDITOR_BOOL_KEYS) {
      if (typeof e[k] === 'boolean') out.editor[k] = e[k] as never
    }
    for (const [k, values] of Object.entries(EDITOR_ENUM_KEYS)) {
      if (values.includes(e[k] as string)) out.editor[k as keyof EditorConfig] = e[k] as never
    }
  }
  if (o.uiFont === 'brand' || o.uiFont === 'system') out.uiFont = o.uiFont
  if (o.terminalLigatures === 'on' || o.terminalLigatures === 'off') out.terminalLigatures = o.terminalLigatures
  // 光标偏好（P-20261005-212）：档位外样式/非布尔闪烁丢弃（缺省项不触碰本机值）
  if (TERMINAL_CURSOR_STYLES.includes(o.cursorStyle as TerminalCursorStyle)) {
    out.cursorStyle = o.cursorStyle as TerminalCursorStyle
  }
  if (typeof o.cursorBlink === 'boolean') out.cursorBlink = o.cursorBlink
  // diff 色板档（P-20261006-5）：值域外剥除，缺省项不触碰本机值
  if (o.diffPalette === 'standard' || o.diffPalette === 'colorblind') out.diffPalette = o.diffPalette
  // 自定义等宽字体名（P-20261005-227）：消毒后非空才入包（缺省项不触碰本机值）
  const monoName = sanitizeMonoFontName(o.monoFontName)
  if (monoName) out.monoFontName = monoName
  return out
}

function fontSectionItems(value: unknown): Record<string, unknown> {
  const items: Record<string, unknown> = {}
  const s = sanitizeFontPayload(value)
  for (const [k, v] of Object.entries(s.sizes)) items[`sizes.${k}`] = v
  for (const [k, v] of Object.entries(s.editor)) items[`editor.${k}`] = v
  if (s.uiFont) items.uiFont = s.uiFont
  if (s.terminalLigatures) items.terminalLigatures = s.terminalLigatures
  if (s.monoFontName) items.monoFontName = s.monoFontName
  if (s.cursorStyle) items.cursorStyle = s.cursorStyle
  if (s.cursorBlink !== undefined) items.cursorBlink = s.cursorBlink
  if (s.diffPalette) items.diffPalette = s.diffPalette
  return items
}

function keymapSectionItems(value: unknown): Record<string, unknown> {
  const items: Record<string, unknown> = {}
  if (!value || typeof value !== 'object') return items
  const o = value as Record<string, unknown>
  for (const id of KEYMAP_ACTION_ORDER) {
    const combo = typeof o[id] === 'string' ? o[id] as string : ''
    // 只收合法动作 id + 规范化后非保留键的组合（与 keymap store readOverrides 同口径）
    const canonical = canonicalCombo(combo)
    if (canonical && !isReservedCombo(canonical)) items[id as KeymapAction] = canonical
  }
  return items
}

function notifySectionItems(value: unknown): Record<string, unknown> {
  const items: Record<string, unknown> = {}
  if (!value || typeof value !== 'object') return items
  const o = value as Record<string, unknown>
  if (o.dnd && typeof o.dnd === 'object' && !Array.isArray(o.dnd)) {
    const dnd = o.dnd as Record<string, unknown>
    if ('enabled' in dnd) items['dnd.enabled'] = dnd.enabled === true
    if (typeof dnd.start === 'string' && dnd.start) items['dnd.start'] = dnd.start
    if (typeof dnd.end === 'string' && dnd.end) items['dnd.end'] = dnd.end
    if (Array.isArray(dnd.except)) items['dnd.except'] = JSON.stringify(dnd.except)
    if ('exceptError' in dnd) items['dnd.exceptError'] = dnd.exceptError !== false
  }
  if (typeof o.sound === 'boolean') items.sound = o.sound
  if (typeof o.simple === 'boolean') items.simple = o.simple
  if (typeof o.scrollRead === 'boolean') items.scrollRead = o.scrollRead
  return items
}

/** 分节值 → 扁平设置项投影（条数/差异摘要的计数面，导入值与本机现值共用） */
export function sectionItems(key: SettingsSectionKey, value: unknown): Record<string, unknown> {
  if (key === 'font') return fontSectionItems(value)
  if (key === 'keymap') return keymapSectionItems(value)
  if (key === 'locale') return typeof value === 'string' && value ? { locale: value } : {}
  if (key === 'theme') return typeof value === 'string' && value ? { theme: value } : {}
  return notifySectionItems(value)
}

/** 差异计数：incoming 项在本机缺失或值不等即计一项（O(n)，项数为设置项量级） */
export function countSectionDiffs(incoming: Record<string, unknown>, current: Record<string, unknown>): number {
  let n = 0
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in current) || current[k] !== v) n++
  }
  return n
}
