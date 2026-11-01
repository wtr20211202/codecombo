#!/usr/bin/env node
// check-icon-semantics.mjs —— 动作图标语义一致性静态门禁（P-20261022-1）
//
// 用法（web/ 内）：
//   npm run check:icon-semantics                    # 校验，基线外违规退出码 1
//   npm run check:icon-semantics -- --update-baseline  # 以当前违规重建基线（治理逃逸口）
//   node scripts/check-icon-semantics.mjs --self-test  # 解析/扫描夹具自检（不碰源码树）
//
// 动机：图标按钮在 14px 工具条上只能靠形状区分，但此前没有「动作 → 图标」唯一映射，
// 同一动作跨页面换图形（更多实心/描边、pull 用 Refresh/CloudDownload）、同一图形
// 承载多义（CloudDownload 四义、Sync 四义），轮换分享链接这类不可逆动作误点代价高。
// P-20261022-2 补齐导航面：rail/首页工具条的目的地图标（NAV_ICONS）此前不在登记面，
// git 分支 × 分享网络两枚「圆点+连线」图同屏 rail、首页两个目的地共用 HelpCircle、
// Speedometer 一图两目的地都是确定性冲突。本门禁把注册表（src/utils/actionIcons.ts）
// 作为唯一事实源：
//   R1 注册表契约：动作键唯一、不同动作不共用同一组件、禁用变体不得混入映射；
//   R2 图标分类完备：src 里每个 @vicons/ionicons5 导入名必须落在 ACTION_ICONS /
//      NAV_ICONS / NON_ACTION_ICONS / BRAND_NAV_ICONS，新增图标不登记即红；
//   R3 禁用变体：BANNED_ICON_VARIANTS 的导入名全局禁止（基线豁免存量）；
//   R4 动作标注：模板里 `data-icon-action="键"` 的 n-icon 必须恰含注册表指定的图标，
//      防止「键对了图形漂了」；标注数量下限防解析器失明；
//   R5 邻接冲突：同一 .vue 文件的两个 icon-only 按钮不得分别使用邻接冲突族里的不同
//      图形（带文字标签的按钮/菜单由文字消歧，不入此面；族表人工维护，不跑视觉相似度）。
//   R6 目的地 nav（P-20261022-2）：
//      R6a-1 rail 面板完整性——panels/registry.ts 每个 registerPanel 的 id 必须在
//           NAV_ICONS 登记同图（品牌组件按 BRAND_NAV_ICONS 豁免），缺登记/图形漂移
//           即失败（注册表对账，不可基线化）；
//      R6a-2 nav 标注——`data-icon-nav="键"` 的 n-icon 必须恰含 NAV_ICONS 指定图形；
//      R6a-3 nav 面完整性——文件内带 `data-nav-surface` 声明的面（首页工具条），其
//           icon-only 按钮的 ionicons 图标必须被本按钮内的 data-icon-nav 覆盖；
//      R6a-4 一图一目的地——NAV_ICONS 内同一图形对应两个键即失败；
//      R6b 禁配对——FORBIDDEN_ICON_PAIRS（感知相似度终审「必改」档）：rail 面板
//           图标集/NAV 值集含对内两枚 = 硬失败（不可基线化）；同一 .vue 文件导入
//           对内两枚 = 基线外失败。.ts 渲染函数层的共现由
//           scripts/icon-similarity-report.mjs 巡检（静态解析分不清文字消歧上下文，
//           菜单/命令项的合法共现不入静态面）。
//
// 审计面：src 下全部 .vue/.ts（排除测试文件与 __tests__）；模板解析只认
// <button>/<n-button>/<NButton> 的开闭标签，.ts 渲染函数层不在邻接面内（R4 标注仍
// 可覆盖 h() 场景之外的模板按钮）。已知边界：属性值里含 '>' 的极端写法会截断
// 开标签、多根条件渲染按钮按同一按钮内多图标处理——宁漏勿误。
//
// 基线 web/scripts/icon-semantics-baseline.json：键 = "规则|文件|细节"，值 = 豁免
// 理由。基线外新增即失败；命中消失的条目会提示 stale 以便修剪。注册表自身错误
// 不可基线化（R1 必须当轮修复）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const REGISTRY = path.join(SRC, 'utils', 'actionIcons.ts')
const PANELS = path.join(SRC, 'panels', 'registry.ts')
const BASELINE = path.join(root, 'scripts', 'icon-semantics-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')
const SELF_TEST = process.argv.includes('--self-test')

const MIN_ACTIONS = 35
const MIN_NAV = 15
const MIN_NON_ACTION = 80
const MIN_FAMILIES = 3
const MIN_ANNOTATIONS = 10

// ---------- 文本工具 ----------
function lineAt(text, pos) {
  return text.slice(0, pos).split('\n').length
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

function templateOf(text) {
  const m = text.match(/<template(?:\s[^>]*)?>([\s\S]*)<\/template>/)
  return m ? m[1] : ''
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '')
}

// ---------- 注册表解析（零依赖文本解析；文件头注记要求保持可解析格式） ----------
function extractBracedBlock(text, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*as const`)
  const m = text.match(re)
  return m ? m[1] : null
}

function extractArrayBlock(text, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`)
  const m = text.match(re)
  return m ? m[1] : null
}

export function parseRegistry(text) {
  const actionBody = extractBracedBlock(text, 'ACTION_ICONS')
  const bannedBody = extractBracedBlock(text, 'BANNED_ICON_VARIANTS')
  const familyBody = extractBracedBlock(text, 'ADJACENCY_FAMILIES')
  const nonActionBody = extractArrayBlock(text, 'NON_ACTION_ICONS')
  if (actionBody === null || bannedBody === null || familyBody === null || nonActionBody === null) {
    return { error: '注册表结构不可解析（要求 export const XXX = { ... } as const / [ ... ] as const）' }
  }

  const actions = {}
  for (const m of actionBody.matchAll(/^\s*'([^']+)'\s*:\s*([A-Za-z0-9_]+)\s*,/gm)) {
    if (actions[m[1]]) return { error: `动作键重复：${m[1]}` }
    actions[m[1]] = m[2]
  }

  const banned = new Set()
  for (const m of bannedBody.matchAll(/^\s*'?([A-Za-z0-9]+)'?\s*:\s*'/gm)) banned.add(m[1])

  const families = {}
  for (const m of familyBody.matchAll(/'([^']+)'\s*:\s*\[([^\]]*)\]/g)) {
    families[m[1]] = [...m[2].matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1])
  }

  const nonAction = new Set()
  for (const m of nonActionBody.matchAll(/'([A-Za-z0-9]+)'/g)) nonAction.add(m[1])

  // NAV_ICONS / BRAND_NAV_ICONS / FORBIDDEN_ICON_PAIRS 为 P-20261022-2 新增段；
  // 老格式基线上缺失时按空处理（R6 相关规则自然空转，不阻塞其他轴）
  const nav = {}
  const navBody = extractBracedBlock(text, 'NAV_ICONS')
  if (navBody !== null) {
    for (const m of navBody.matchAll(/^\s*'([^']+)'\s*:\s*([A-Za-z0-9_]+)\s*,/gm)) {
      if (nav[m[1]]) return { error: `目的地键重复：${m[1]}` }
      nav[m[1]] = m[2]
    }
  }
  const brandNav = new Set()
  const brandBody = extractArrayBlock(text, 'BRAND_NAV_ICONS')
  if (brandBody !== null) {
    for (const m of brandBody.matchAll(/'([A-Za-z0-9_]+)'/g)) brandNav.add(m[1])
  }
  const forbiddenPairs = []
  const pairsBody = extractArrayBlock(text, 'FORBIDDEN_ICON_PAIRS')
  if (pairsBody !== null) {
    for (const m of pairsBody.matchAll(/\[\s*'([A-Za-z0-9]+)'\s*,\s*'([A-Za-z0-9]+)'\s*\]/g)) {
      forbiddenPairs.push([m[1], m[2]])
    }
  }

  return { actions, banned, families, nonAction, nav, brandNav, forbiddenPairs }
}

/** panels/registry.ts 的 registerPanel 块 → {id, group, icon}（icon 可能是品牌组件） */
export function parsePanels(text) {
  const panels = []
  for (const m of text.matchAll(/registerPanel\(\{([\s\S]*?)\n\}\)/g)) {
    const body = m[1]
    const id = body.match(/\bid: '([^']+)'/)?.[1]
    const group = body.match(/\bgroup: '(rail-top|bottom-tab)'/)?.[1]
    const icon = body.match(/\bicon: ([A-Za-z0-9_]+)/)?.[1]
    if (id && group && icon) panels.push({ id, group, icon })
  }
  return panels
}

// 注册表契约（R1 + R6a-4 一图一目的地 + 计数下限防解析失明）
function validateRegistry(reg, iconPackage) {
  const errors = []
  const actionEntries = Object.entries(reg.actions)
  if (actionEntries.length < MIN_ACTIONS) {
    errors.push(`ACTION_ICONS 仅解析到 ${actionEntries.length} 个动作（下限 ${MIN_ACTIONS}）——解析器失明或注册表被截断`)
  }
  if (reg.nonAction.size < MIN_NON_ACTION) {
    errors.push(`NON_ACTION_ICONS 仅解析到 ${reg.nonAction.size} 个图标（下限 ${MIN_NON_ACTION}）`)
  }
  if (Object.keys(reg.families).length < MIN_FAMILIES) {
    errors.push(`ADJACENCY_FAMILIES 仅解析到 ${Object.keys(reg.families).length} 个族（下限 ${MIN_FAMILIES}）`)
  }
  if (reg.banned.size === 0) errors.push('BANNED_ICON_VARIANTS 为空——禁用变体清单丢失')

  const iconOwner = new Map()
  for (const [key, icon] of actionEntries) {
    if (!/^(common|git|share|chat|claude|notify|nav)\.[a-z][A-Za-z0-9]*$/.test(key)) {
      errors.push(`动作键 ${key} 不符合 域.动作 命名`)
    }
    if (!iconPackage[icon]) errors.push(`动作 ${key} 的图标 ${icon} 不是 @vicons/ionicons5 导出`)
    if (reg.banned.has(icon)) errors.push(`动作 ${key} 使用了禁用变体 ${icon}`)
    if (iconOwner.has(icon)) errors.push(`不同动作共用同一图标 ${icon}：${iconOwner.get(icon)} 与 ${key}`)
    else iconOwner.set(icon, key)
  }
  for (const [family, icons] of Object.entries(reg.families)) {
    if (icons.length < 2) errors.push(`邻接族 ${family} 少于两枚图标`)
    for (const name of icons) {
      if (!iconPackage[name]) errors.push(`邻接族 ${family} 的 ${name} 不是 @vicons/ionicons5 导出`)
    }
  }
  for (const name of reg.nonAction) {
    if (!iconPackage[name]) errors.push(`非动作图标 ${name} 不是 @vicons/ionicons5 导出`)
    if (iconOwner.has(name)) errors.push(`非动作图标 ${name} 与动作 ${iconOwner.get(name)} 重叠，应从非动作清单移除`)
  }
  for (const name of reg.banned) {
    if (!iconPackage[name]) errors.push(`禁用变体 ${name} 不是 @vicons/ionicons5 导出（拼写错误）`)
  }

  // R6a-4：一图一目的地（动作段与 nav 段同图允许，见 NAV_ICONS 头注）
  const navEntries = Object.entries(reg.nav)
  if (navEntries.length < MIN_NAV) {
    errors.push(`NAV_ICONS 仅解析到 ${navEntries.length} 个目的地（下限 ${MIN_NAV}）——解析器失明或 nav 段被截断`)
  }
  const navOwner = new Map()
  for (const [key, icon] of navEntries) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      errors.push(`目的地键 ${key} 不符合平铺 kebab id 命名`)
    }
    if (!iconPackage[icon]) errors.push(`目的地 ${key} 的图标 ${icon} 不是 @vicons/ionicons5 导出`)
    if (reg.banned.has(icon)) errors.push(`目的地 ${key} 使用了禁用变体 ${icon}`)
    if (navOwner.has(icon)) errors.push(`一图两目的地：${icon} 同时登记 ${navOwner.get(icon)} 与 ${key}`)
    else navOwner.set(icon, key)
  }
  // 禁配对清单本身的结构校验
  for (const [a, b] of reg.forbiddenPairs) {
    if (!iconPackage[a] || !iconPackage[b]) errors.push(`禁配对 ${a} × ${b} 含非 @vicons/ionicons5 导出（拼写错误）`)
    if (a === b) errors.push(`禁配对 ${a} × ${b} 两端相同——同图两目的地应走 R6a-4 而非禁配对`)
  }
  const seenPair = new Set(reg.forbiddenPairs.map(([a, b]) => [a, b].sort().join('|')))
  if (seenPair.size !== reg.forbiddenPairs.length) errors.push('禁配对清单存在重复对（含 a/b 交换）')
  return errors
}

/**
 * R6a-1：rail 面板 ↔ NAV_ICONS 对账。返回硬错误列表（不可基线化——两份注册表
 * 漂移说明有人加了面板没登记目的地，修复成本一行）。
 */
export function validatePanelNav(reg, panels) {
  const errors = []
  for (const p of panels) {
    if (reg.brandNav.has(p.icon)) continue // 品牌图标豁免（独占图形零混淆面）
    const navIcon = reg.nav[p.id]
    if (navIcon === undefined) {
      errors.push(`面板 ${p.id}（${p.group}）未在 NAV_ICONS 登记（键 '${p.id}'）`)
    } else if (navIcon !== p.icon) {
      errors.push(`面板 ${p.id} 的图标 ${p.icon} 与 NAV_ICONS['${p.id}'] = ${navIcon} 不一致`)
    }
  }
  return errors
}

/** R6b 禁配对：rail/NAV 注册面是否同时含对内两枚（硬失败，不可基线化） */
export function findForbiddenRailPairs(reg, panels) {
  const railIcons = new Set(panels.map((p) => p.icon))
  for (const v of Object.values(reg.nav)) railIcons.add(v)
  const violations = []
  for (const [a, b] of reg.forbiddenPairs) {
    if (railIcons.has(a) && railIcons.has(b)) {
      violations.push(`禁配对 ${a} × ${b} 同时出现在 rail 面板/NAV 注册面`)
    }
  }
  return violations
}

// ---------- 源码扫描 ----------
function walkSource(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      walkSource(abs, out)
    } else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(abs)
    }
  }
  return out
}

function collectIconImports(text) {
  const imports = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]@vicons\/ionicons5['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const body = m[1]
    const bodyStart = m.index + m[0].indexOf(body)
    const clean = body.replace(/\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '))
    let offset = 0
    for (const raw of clean.split(',')) {
      const name = raw.replace(/\s+as\s+/g, ' ').trim().split(/\s+/).pop()
      if (name && /^[A-Za-z0-9]+$/.test(name)) {
        imports.push({ name, line: lineAt(text, bodyStart + offset + Math.max(0, raw.indexOf(name))) })
      }
      offset += raw.length + 1
    }
  }
  return imports
}

function iconsInside(fragment, importedNames) {
  const found = []
  for (const name of importedNames) {
    if (new RegExp(`\\b${name}\\b`).test(fragment)) found.push(name)
  }
  return found
}

/**
 * 扫描单个文件文本，返回命中列表（纯函数，--self-test 直测）。
 * 命中形状：{ rule, file, line, detail, msg }
 */
export function scanSource(text, file, reg) {
  const hits = []
  const imports = collectIconImports(text)
  if (imports.length === 0) return hits
  const importedNames = new Set(imports.map((i) => i.name))
  const actionIcons = new Set(Object.values(reg.actions))
  const navIcons = new Set(Object.values(reg.nav))
  const classified = new Set([...actionIcons, ...navIcons, ...reg.nonAction, ...reg.brandNav])

  // R2/R3：禁用变体 + 未分类图标（按导入名，行号取首次导入）
  const seen = new Set()
  for (const { name, line } of imports) {
    if (seen.has(name)) continue
    seen.add(name)
    if (reg.banned.has(name)) {
      hits.push({ rule: 'banned', file, line, detail: name, msg: `使用了禁用图标变体 ${name}` })
      continue
    }
    if (!classified.has(name)) {
      hits.push({
        rule: 'unclassified', file, line, detail: name,
        msg: `图标 ${name} 未分类：动作图标请登记 ACTION_ICONS，目的地图标请登记 NAV_ICONS，装饰性图标请登记 NON_ACTION_ICONS`,
      })
    }
  }

  // R6b（文件面）：禁配对两端不得在同一 .vue 文件共现（菜单/命令项等带文字场景
  // 在 .ts 渲染函数层，由 icon-similarity-report 巡检，不入此静态面）
  if (file.endsWith('.vue')) {
    for (const [a, b] of reg.forbiddenPairs) {
      if (importedNames.has(a) && importedNames.has(b)) {
        hits.push({
          rule: 'forbidden-pair', file, line: imports.find((i) => i.name === a)?.line ?? 1,
          detail: `${a}|${b}`,
          msg: `禁配对 ${a} × ${b} 在同一文件共现（感知相似度终审必改档，见 docs/design/icon-semantics.md）`,
        })
      }
    }
  }

  const tpl = stripHtmlComments(templateOf(text))
  if (!tpl) return hits

  // R4（动作）/ R6a-2（目的地）：标注与注册表对账
  const annotationRe = /<(n-icon|NIcon)\b([^>]*)>([\s\S]*?)<\/\1>/g
  let am
  while ((am = annotationRe.exec(tpl)) !== null) {
    const attrs = am[2]
    const line = lineAt(text, text.indexOf(am[0]))
    const action = attrs.match(/\bdata-icon-action="([^"]+)"/)
    const navKey = attrs.match(/\bdata-icon-nav="([^"]+)"/)
    if (action) {
      const key = action[1]
      const expected = reg.actions[key]
      if (!expected) {
        hits.push({ rule: 'action-key', file, line, detail: key, msg: `data-icon-action="${key}" 没有对应的注册表动作键` })
      } else {
        const icons = iconsInside(am[3], importedNames)
        if (icons.length !== 1 || icons[0] !== expected) {
          hits.push({
            rule: 'action-icon', file, line, detail: key,
            msg: `动作 ${key} 应使用 ${expected}，实际标注块内为 ${icons.length ? icons.join('/') : '（无已知图标）'}`,
          })
        }
      }
    }
    if (navKey) {
      const key = navKey[1]
      const expected = reg.nav[key]
      if (!expected) {
        hits.push({ rule: 'nav-key', file, line, detail: key, msg: `data-icon-nav="${key}" 没有对应的 NAV_ICONS 目的地键` })
      } else {
        const icons = iconsInside(am[3], importedNames)
        if (icons.length !== 1 || icons[0] !== expected) {
          hits.push({
            rule: 'nav-icon', file, line, detail: key,
            msg: `目的地 ${key} 应使用 ${expected}，实际标注块内为 ${icons.length ? icons.join('/') : '（无已知图标）'}`,
          })
        }
      }
    }
  }

  // R6a-3：data-nav-surface 声明面（如首页工具条）内，icon-only 按钮的 ionicons
  // 图标必须被本按钮内的 data-icon-nav 覆盖（品牌组件不在 importedNames，天然豁免）
  if (/\bdata-nav-surface="/.test(tpl)) {
    const buttonRe = /<(n-button|NButton|button)\b([^>]*)>([\s\S]*?)<\/\1>/g
    let sm
    while ((sm = buttonRe.exec(tpl)) !== null) {
      const inner = sm[3]
      const textContent = stripTags(stripHtmlComments(inner)).replace(/\s+/g, '')
      if (textContent.length > 0) continue // 有文字 → 文字承担消歧
      const icons = iconsInside(inner, importedNames)
      if (icons.length === 0) continue // 纯 loading 圈等
      const navAnnotated = [...inner.matchAll(/\bdata-icon-nav="([^"]+)"/g)].map((m) => reg.nav[m[1]]).filter(Boolean)
      if (!icons.every((icon) => navAnnotated.includes(icon))) {
        hits.push({
          rule: 'nav-surface', file, line: lineAt(text, text.indexOf(sm[0])),
          detail: icons.join('/'),
          msg: `data-nav-surface 面内 icon-only 按钮的图标 ${icons.join('/')} 未被 data-icon-nav 登记（目的地登记见 NAV_ICONS）`,
        })
      }
    }
  }

  // R5：同一文件 icon-only 按钮的邻接冲突族
  const buttons = []
  const buttonRe = /<(n-button|NButton|button)\b[^>]*>([\s\S]*?)<\/\1>/g
  let bm
  while ((bm = buttonRe.exec(tpl)) !== null) {
    const inner = bm[2]
    const textContent = stripTags(stripHtmlComments(inner)).replace(/\s+/g, '')
    if (textContent.length > 0) continue // 有文字 → 文字承担消歧
    const icons = iconsInside(inner, importedNames)
    if (icons.length === 0) continue // 纯 loading 圈等
    buttons.push({ icons, line: lineAt(text, text.indexOf(bm[0])) })
  }
  for (const [family, familyIcons] of Object.entries(reg.families)) {
    const matching = buttons
      .map((b) => b.icons.filter((i) => familyIcons.includes(i)))
      .filter((arr) => arr.length > 0)
    const distinct = new Set(matching.flat())
    if (matching.length >= 2 && distinct.size >= 2) {
      hits.push({
        rule: 'adjacency', file, line: buttons[0].line, detail: family,
        msg: `同一文件 icon-only 按钮出现邻接族 ${family} 的不同图形：${[...distinct].join(' / ')}`,
      })
    }
  }
  return hits
}

// ---------- 基线 ----------
function hitKey(hit) {
  return `${hit.rule}|${hit.file}|${hit.detail}`
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'))
    return parsed && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {}
  } catch (err) {
    console.error(`[icon-semantics] 基线无法解析：${err.message}`)
    process.exit(2)
  }
}

function writeBaseline(entries) {
  const header = {
    _comment: '动作图标语义基线（P-20261022-1）：键 = "规则|文件|细节"，值 = 豁免理由。'
      + '基线外新增即 check:icon-semantics 退码 1；修复后请删除对应条目。重建：npm run check:icon-semantics -- --update-baseline',
    entries,
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(header, null, 2)}\n`)
}

// ---------- 自检 ----------
function selfTest() {
  let failed = 0
  let checks = 0
  const assert = (label, cond) => {
    checks++
    if (!cond) {
      failed++
      console.error(`  ✗ ${label}`)
    }
  }

  const regText = `
export const ACTION_ICONS = {
  'common.more': EllipsisHorizontalOutline,
  'common.refresh': RefreshOutline,
} as const
export const NAV_ICONS = {
  'git': GitBranchOutline,
  'share-manager': ShareSocialOutline,
  'home': HomeOutline,
  'files': FakeIconA,
  'todos': FakeIconB,
  'notes': FakeIconC,
  'stream': FakeIconD,
  'env': FakeIconE,
  'terminal': FakeIconF,
  'preview': FakeIconG,
  'problems': FakeIconH,
  'console': FakeIconI,
  'settings': FakeIconJ,
  'theme': FakeIconK,
  'lock': FakeIconL,
} as const
export const BRAND_NAV_ICONS = [
  'DshIcon',
] as const
export const FORBIDDEN_ICON_PAIRS = [
  ['GitBranchOutline', 'ShareSocialOutline'],
] as const
export const BANNED_ICON_VARIANTS = {
  EllipsisHorizontal: 'why',
  SyncOutline: 'why',
} as const
export const ADJACENCY_FAMILIES = {
  'more-dots': ['EllipsisHorizontal', 'EllipsisHorizontalOutline'],
  'refresh-ring': ['RefreshOutline', 'SyncOutline'],
} as const
export const NON_ACTION_ICONS = [
  'SearchOutline',
] as const
`
  const reg = parseRegistry(regText)
  assert('注册表四段可解析', !reg.error && Object.keys(reg.actions).length === 2)
  assert('禁用清单解析', reg.banned?.has('SyncOutline') === true)
  assert('邻接族解析', reg.families?.['refresh-ring']?.length === 2)
  assert('非动作清单解析', reg.nonAction?.has('SearchOutline') === true)
  assert('nav 段解析', reg.nav?.['share-manager'] === 'ShareSocialOutline')
  assert('禁配对解析', reg.forbiddenPairs?.length === 1 && reg.forbiddenPairs[0][0] === 'GitBranchOutline')
  assert('品牌豁免解析', reg.brandNav?.has('DshIcon') === true)

  // R6 夹具的 ionicons 替身（validateRegistry 需要包导出表；Fake* 凑 nav 下限）
  const iconPkg = {
    EllipsisHorizontalOutline: {}, RefreshOutline: {}, GitBranchOutline: {},
    ShareSocialOutline: {}, HomeOutline: {}, SearchOutline: {},
    FakeIconA: {}, FakeIconB: {}, FakeIconC: {}, FakeIconD: {}, FakeIconE: {},
    FakeIconF: {}, FakeIconG: {}, FakeIconH: {}, FakeIconI: {}, FakeIconJ: {},
    FakeIconK: {}, FakeIconL: {},
  }
  const contractErrors = validateRegistry(reg, iconPkg)
  assert('契约夹具无 nav 专项错误', !contractErrors.some((e) => e.includes('一图两目的地') || e.includes('kebab') || e.includes('目的地键') || e.includes('NAV_ICONS 仅解析到')))
  const dupNavReg = parseRegistry(regText.replace(`  'home': HomeOutline,`, `  'home': HomeOutline,\n  'home-alt': HomeOutline,`))
  assert('一图两目的地命中', validateRegistry(dupNavReg, iconPkg).some((e) => e.includes('一图两目的地')))
  const badKeyReg = parseRegistry(regText.replace(`  'home': HomeOutline,`, `  'Home': HomeOutline,`))
  assert('nav 键命名命中', validateRegistry(badKeyReg, iconPkg).some((e) => e.includes('kebab')))

  const panels = [
    { id: 'git', group: 'rail-top', icon: 'GitBranchOutline' },
    { id: 'dsh-console', group: 'rail-top', icon: 'DshIcon' },
    { id: 'ghost-panel', group: 'rail-top', icon: 'HomeOutline' },
    { id: 'home', group: 'bottom-tab', icon: 'GitBranchOutline' },
  ]
  assert('面板未登记 NAV 命中', validatePanelNav(reg, panels).some((e) => e.includes('ghost-panel')))
  assert('面板图形漂移命中', validatePanelNav(reg, panels).some((e) => e.includes("'home'") && e.includes('不一致')))
  assert('品牌面板豁免对账', !validatePanelNav(reg, panels).some((e) => e.includes('dsh-console')))
  assert('rail 禁配对命中', findForbiddenRailPairs(reg, panels).length === 1)

  const good = `
<script setup>
import { EllipsisHorizontalOutline } from '@vicons/ionicons5'
</script>
<template>
  <n-icon data-icon-action="common.more"><EllipsisHorizontalOutline /></n-icon>
</template>`
  assert('合规标注零命中', scanSource(good, 'good.vue', reg).length === 0)

  const banned = `import { EllipsisHorizontal } from '@vicons/ionicons5'
<template><n-icon><EllipsisHorizontal /></n-icon></template>`
  assert('禁用变体命中', scanSource(banned, 'banned.vue', reg).some((h) => h.rule === 'banned'))

  const unknown = `import { CopyOutline } from '@vicons/ionicons5'
<template><n-icon><CopyOutline /></n-icon></template>`
  assert('未分类图标命中', scanSource(unknown, 'unknown.vue', reg).some((h) => h.rule === 'unclassified'))
  assert('缺省动作键命中', scanSource(
    `import { EllipsisHorizontalOutline } from '@vicons/ionicons5'
<template><n-icon data-icon-action="common.nope"><EllipsisHorizontalOutline /></n-icon></template>`,
    'key.vue', reg,
  ).some((h) => h.rule === 'action-key'))
  assert('标注图形漂移命中', scanSource(
    `import { EllipsisHorizontalOutline, SearchOutline } from '@vicons/ionicons5'
<template><n-icon data-icon-action="common.more"><SearchOutline /></n-icon></template>`,
    'drift.vue', reg,
  ).some((h) => h.rule === 'action-icon'))

  const adjacency = `import { RefreshOutline, SyncOutline } from '@vicons/ionicons5'
<template>
  <button title="a"><n-icon><RefreshOutline /></n-icon></button>
  <button title="b"><n-icon><SyncOutline /></n-icon></button>
</template>`
  assert('邻接冲突命中', scanSource(adjacency, 'adj.vue', reg).some((h) => h.rule === 'adjacency'))

  const labeled = `import { RefreshOutline, SyncOutline } from '@vicons/ionicons5'
<template>
  <button title="a"><n-icon><RefreshOutline /></n-icon><span>刷新</span></button>
  <button title="b"><n-icon><SyncOutline /></n-icon><span>同步</span></button>
</template>`
  assert('带文字按钮不判邻接', !scanSource(labeled, 'labeled.vue', reg).some((h) => h.rule === 'adjacency'))

  // R6a-2/R6a-3/R6b 夹具（P-20261022-2）
  assert('nav 标注图形漂移命中', scanSource(
    `import { GitBranchOutline } from '@vicons/ionicons5'
<template><n-icon data-icon-nav="git"><ShareSocialOutline /></n-icon></template>`,
    'navdrift.vue', reg,
  ).some((h) => h.rule === 'nav-icon'))
  assert('nav 键缺失命中', scanSource(
    `import { HomeOutline } from '@vicons/ionicons5'
<template><n-icon data-icon-nav="nope"><HomeOutline /></n-icon></template>`,
    'navkey.vue', reg,
  ).some((h) => h.rule === 'nav-key'))
  assert('nav 面内未登记命中', scanSource(
    `import { GitBranchOutline } from '@vicons/ionicons5'
<template><div data-nav-surface="x">
  <button title="a"><n-icon><GitBranchOutline /></n-icon></button>
</div></template>`,
    'surface.vue', reg,
  ).some((h) => h.rule === 'nav-surface'))
  assert('nav 面合规零命中', !scanSource(
    `import { GitBranchOutline } from '@vicons/ionicons5'
<template><div data-nav-surface="x">
  <button title="a"><n-icon data-icon-nav="git"><GitBranchOutline /></n-icon></button>
</div></template>`,
    'surfaceok.vue', reg,
  ).some((h) => h.rule === 'nav-surface'))
  const pairSrc = `import { GitBranchOutline, ShareSocialOutline } from '@vicons/ionicons5'
<template><n-icon><GitBranchOutline /></n-icon></template>`
  assert('禁配对同 vue 文件命中', scanSource(pairSrc, 'pair.vue', reg).some((h) => h.rule === 'forbidden-pair'))
  assert('禁配对 ts 文件不判（报告工具巡检面）', !scanSource(pairSrc, 'pair.ts', reg).some((h) => h.rule === 'forbidden-pair'))

  console.log(failed === 0
    ? `[icon-semantics:self-test] ${checks}/${checks} 通过`
    : `[icon-semantics:self-test] ${failed}/${checks} 项失败`)
  process.exitCode = failed === 0 ? 0 : 1
}

async function main() {
  if (SELF_TEST) {
    selfTest()
    return
  }

  if (!fs.existsSync(REGISTRY)) {
    console.error(`[icon-semantics] 注册表不存在：${REGISTRY}`)
    process.exit(1)
  }
  const reg = parseRegistry(fs.readFileSync(REGISTRY, 'utf-8'))
  if (reg.error) {
    console.error(`[icon-semantics] ${reg.error}`)
    process.exit(1)
  }

  const iconPackage = await import('@vicons/ionicons5')
  const registryErrors = validateRegistry(reg, iconPackage)
  // R6a-1 / R6b-rail：两份注册表（panels ↔ NAV / 禁配对面）的对账，同为不可基线化
  if (fs.existsSync(PANELS)) {
    const panels = parsePanels(fs.readFileSync(PANELS, 'utf-8'))
    registryErrors.push(...validatePanelNav(reg, panels))
    registryErrors.push(...findForbiddenRailPairs(reg, panels))
  }
  if (registryErrors.length > 0) {
    console.error('[icon-semantics] 注册表契约破坏（不可基线化）：')
    for (const err of registryErrors) console.error(`  - ${err}`)
    process.exit(1)
  }

  const files = walkSource(SRC)
  const hits = []
  let annotationCount = 0
  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf-8')
    annotationCount += (text.match(/\bdata-icon-action="/g) || []).length
    const rel = path.relative(root, abs).split(path.sep).join('/')
    hits.push(...scanSource(text, rel, reg))
  }
  if (annotationCount < MIN_ANNOTATIONS) {
    hits.push({
      rule: 'coverage', file: 'src', line: 1, detail: 'annotations',
      msg: `data-icon-action 标注仅 ${annotationCount} 处（下限 ${MIN_ANNOTATIONS}）——动作标注面失明或首批替换回退`,
    })
  }

  if (UPDATE_BASELINE) {
    const previous = readBaseline()
    const entries = {}
    for (const hit of hits) {
      const key = hitKey(hit)
      entries[key] = previous[key] || '存量豁免（P-20261022-1 落地基线，待渐进收编）'
    }
    writeBaseline(entries)
    console.log(`[icon-semantics] 基线已重建：${Object.keys(entries).length} 条`)
    return
  }

  const baseline = readBaseline()
  const failures = hits.filter((h) => !(hitKey(h) in baseline))
  const hitKeys = new Set(hits.map(hitKey))
  const stale = Object.keys(baseline).filter((key) => !hitKeys.has(key))

  console.log(
    `[icon-semantics] ${Object.keys(reg.actions).length} 动作 / ${Object.keys(reg.nav).length} 目的地 / `
    + `${reg.nonAction.size} 非动作图标 / `
    + `${Object.keys(reg.families).length} 邻接族 / ${reg.forbiddenPairs.length} 禁配对 / `
    + `${files.length} 文件 / ${annotationCount} 处动作标注`,
  )
  if (stale.length > 0) {
    console.warn(`[icon-semantics] 基线有 ${stale.length} 条 stale（命中已消失，可删除）：`)
    for (const key of stale) console.warn(`  - ${key}`)
  }
  if (failures.length > 0) {
    console.error(`[icon-semantics] ${failures.length} 处违规（基线外）：`)
    for (const hit of failures) {
      console.error(`  - ${hit.file}:${hit.line} [${hit.rule}] ${hit.msg}`)
    }
    console.error('修复后重跑；确属存量的治理逃逸口：npm run check:icon-semantics -- --update-baseline')
    process.exitCode = 1
    return
  }
  console.log('[icon-semantics] OK：基线外零违规')
}

if (!SELF_TEST) {
  main().catch((err) => {
    console.error(`[icon-semantics] 执行失败：${err?.stack || err}`)
    process.exit(1)
  })
} else {
  selfTest()
}
