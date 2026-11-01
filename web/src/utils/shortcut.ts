// 快捷键解析与匹配工具：用户配置的 combo 字符串与 KeyboardEvent 互转
//
// combo 格式：'ctrl+shift+l' / 'meta+k' / 'alt+shift+f1'
// - modifier 别名：ctrl=control, cmd=meta=command=mod, alt=option
// - 主键 key 全部小写（如 'l'、'f1'、'enter'、'arrowdown'）
// - 不区分大小写，空格容错

// 修饰符识别集合（不区分大小写）
const CTRL_ALIASES = new Set(['ctrl', 'control'])
const META_ALIASES = new Set(['meta', 'cmd', 'command', 'mod'])
const ALT_ALIASES = new Set(['alt', 'option'])
const SHIFT_ALIASES = new Set(['shift'])

// 单独按下时不算快捷键（避免误绑定纯 modifier 事件）
const MODIFIER_KEY_NAMES = new Set(['control', 'shift', 'alt', 'meta', 'option', 'cmd', 'command'])

export interface ParsedShortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string  // 主键，统一小写
}

/**
 * 解析 combo 字符串为结构化对象
 * @example 'ctrl+shift+l' → { ctrl: true, shift: true, alt: false, meta: false, key: 'l' }
 */
export function parseShortcut(combo: string): ParsedShortcut {
  const result: ParsedShortcut = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  if (!combo) return result

  // 拆分为 token，去除空格、空 token
  const tokens = combo
    .toLowerCase()
    .split('+')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  // 最后一个 token 默认为主键
  const mainKey = tokens.length > 0 ? tokens[tokens.length - 1]! : ''

  // 修饰符遍历所有 token（除最后一个之外，但若最后一个也是 modifier 则视为无效主键）
  for (const tok of tokens) {
    if (CTRL_ALIASES.has(tok)) result.ctrl = true
    else if (META_ALIASES.has(tok)) result.meta = true
    else if (ALT_ALIASES.has(tok)) result.alt = true
    else if (SHIFT_ALIASES.has(tok)) result.shift = true
  }

  // 主键仅在非 modifier 时才记录
  if (!CTRL_ALIASES.has(mainKey) && !META_ALIASES.has(mainKey) &&
      !ALT_ALIASES.has(mainKey) && !SHIFT_ALIASES.has(mainKey)) {
    result.key = mainKey
  }

  return result
}

/**
 * KeyboardEvent → combo 字符串
 * - 忽略单独 modifier 按下（ctrl/shift/alt/meta 单独 → 返回 ''）
 * - 无修饰符的单字符按下也返回 ''（避免误绑定）
 * @example { ctrlKey, shiftKey, key: 'L' } → 'ctrl+shift+l'
 */
export function eventToShortcut(e: KeyboardEvent): string {
  const keyLower = (e.key || '').toLowerCase()

  // 单独 modifier 不视为有效组合
  if (!keyLower || MODIFIER_KEY_NAMES.has(keyLower)) return ''

  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  // 至少有一个修饰符才视为合法组合（避免单个字母触发绑定）
  if (parts.length === 0) return ''

  parts.push(keyLower)
  return parts.join('+')
}

/**
 * 判断 KeyboardEvent 是否匹配 combo
 * - 空 combo 永远不匹配（防误触发）
 * - 修饰符和主键必须精确匹配
 */
export function matchShortcut(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false
  const parsed = parseShortcut(combo)
  if (!parsed.key) return false

  return (
    e.ctrlKey === parsed.ctrl &&
    e.metaKey === parsed.meta &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift &&
    (e.key || '').toLowerCase() === parsed.key
  )
}
