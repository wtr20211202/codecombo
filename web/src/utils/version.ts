// 语义化版本比较（"0.1.0-beta.1" 形态）：candidate 是否严格新于 current。
// 规则对齐 semver：主/次/补丁按数字逐段比较；预发布版低于正式版，
// 预发布段逐段比较（数字段按数值、数字段 < 字符串段、字符串段按字典序）。
// 任一版本无法解析为「主.次.补丁」形态时返回 false——视为版本未知，
// 宁可漏提示也不误报"有更新"

interface ParsedVersion {
  core: number[]
  prerelease: string[]
  valid: boolean
}

function parseVersion(v: string): ParsedVersion {
  const invalid: ParsedVersion = { core: [], prerelease: [], valid: false }
  if (typeof v !== 'string' || !v.trim()) return invalid
  const s = v.trim().replace(/^v/i, '')
  const [main = '', pre = ''] = s.split('-')
  const core = main.split('.').map(seg => (/^\d+$/.test(seg) ? parseInt(seg, 10) : NaN))
  if (main.length === 0 || core.length > 3 || core.some(n => Number.isNaN(n))) return invalid
  while (core.length < 3) core.push(0)
  const prerelease = pre ? pre.split('.').filter(Boolean) : []
  return { core, prerelease, valid: true }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1  // 无预发布（正式版）> 有预发布
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const sa = a[i]
    const sb = b[i]
    if (sa === undefined) return -1  // 段数少的一方更小
    if (sb === undefined) return 1
    const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : null
    const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : null
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1
    } else if (na !== null) {
      return -1  // 数字段 < 字符串段
    } else if (nb !== null) {
      return 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}

/** 版本是否为预发布版（semver 带 -prerelease 段，如 0.21-alpha.2）。
 *  解析失败按稳定版处理——过滤场景下宁可多展示也不静默吞掉版本 */
export function isPrereleaseVersion(v: string): boolean {
  const p = parseVersion(v)
  return p.valid && p.prerelease.length > 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseVersion(candidate)
  const cur = parseVersion(current)
  if (!c.valid || !cur.valid) return false
  // core 已补齐三位，解构默认值仅为满足索引访问的 undefined 检查
  const [c0 = 0, c1 = 0, c2 = 0] = c.core
  const [k0 = 0, k1 = 0, k2 = 0] = cur.core
  if (c0 !== k0) return c0 > k0
  if (c1 !== k1) return c1 > k1
  if (c2 !== k2) return c2 > k2
  return comparePrerelease(c.prerelease, cur.prerelease) > 0
}
