#!/usr/bin/env node
// check-hardcoded-fonts.mjs —— src 内 font-family / fontFamily 硬编码字体栈审计
//
// 用法：
//   node scripts/check-hardcoded-fonts.mjs                    # 校验，白名单外新增硬编码字体退出码 1（存量债务按基线豁免）
//   node scripts/check-hardcoded-fonts.mjs --update-baseline  # 以当前全部命中重写基线（治理流程专用）
//
// 说明：
//   - 动机（P-20261004-43）：--font-mono（assets/base.css）是精心排序的跨平台等宽栈
//     （JetBrains Mono→…→Consolas→monospace），DiffViewer/GitManageModal 等面的硬编码
//     Consolas 优先栈绕过 token——装了 JetBrains Mono 的用户在对应面看不到自己的字体，
//     Windows 无该字体用户回退劣于 token；门禁与 check-hardcoded-colors 同族防再欠债
//   - 扫描 src 下全部 .vue/.ts/.tsx 的 font-family: / fontFamily[:=] 声明值（行级提取，
//     \b 锚定防连写标识符误锚）；.css 不扫：assets/base.css 为 token 定义本体、
//     styles/terminal-effects.css 为字体选择器联动装饰特效，属注册表面而非欠债
//   - 合法豁免（结构性，不进基线）：
//     ① src/terminal-themes/index.ts 整文件——XTERM_FONT_STACKS 字体注册表，选项即字体直写
//     ② src/components/crash/CrashFallback.vue 整文件——崩溃回退页零依赖特例（同 check-hardcoded-colors P-26）
//   - 声明值合法性按 token 分析：通用关键字（monospace/sans-serif/system-ui 等 CSS 通用族）、
//     var(--font-mono…) token 引用、JS 动态表达式（点分路径 x.y / 函数调用）合法；带引号
//     字体字面量或裸字体名（Consolas/Menlo 等非通用词）即命中。裸 monospace 关键字不算
//     硬编码（通用族而非具体字体，同 colors 门禁不审 currentColor 的关键字/字面量之分）
//   - CSS 注释 /* */ 与 HTML 注释 <!-- --> 内字样不计；已知边界：// 行注释提及
//     font-family 字样会命中（视作文档性欠债提示）、跨行声明值只看到首行（首字体必在
//     首行，实际欠债不会漏报）
//   - 存量债务记入 hardcoded-fonts-baseline.json（键 = 文件|声明值，值 = 豁免理由），
//     白名单外新增即判失败防回潮；基线条目已无命中时提示移除（治理收敛）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const BASELINE = path.join(root, 'scripts', 'hardcoded-fonts-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

// 结构性豁免：字体注册表（数据本体，选项即字体直写）与零依赖崩溃回退页
const WHITELIST_FILES = new Set([
  'src/terminal-themes/index.ts',
  'src/components/crash/CrashFallback.vue',
])

// 声明锚：CSS font-family: 与 JS fontFamily 对象键/赋值（\b 防 myFontFamily 之类连写误锚）
const DECL_RE = /\bfont-family\s*:|\bfontFamily\s*[:=]/gi

// CSS 通用字体族与继承关键字——非具体字体字面量，不入审计
const GENERIC = new Set([
  'monospace', 'sans-serif', 'serif', 'cursive', 'fantasy', 'system-ui',
  'ui-monospace', 'ui-serif', 'ui-rounded', 'math', 'emoji', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer',
])

// JS 动态表达式 token：点分路径（themeStore.currentFontStack）或含调用的表达式
const DYNAMIC_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/

// ---------- 同长屏蔽：把注释 span 用空格填掉（换行保留，行号不变） ----------
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let pos = 0
  for (const [s, e] of ranges) {
    if (s < pos) continue // 重叠 span 跳过已屏蔽段
    out += text.slice(pos, s) + text.slice(s, e).replace(/[^\n]/g, ' ')
    pos = e
  }
  return out + text.slice(pos)
}

function commentRanges(text) {
  const ranges = []
  const push = (re) => {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length])
  }
  push(/\/\*[\s\S]*?\*\//g) // CSS/JS 块注释
  push(/<!--[\s\S]*?-->/g) // HTML 注释
  return ranges
}

function stripQuotePair(v) {
  if (v.length >= 2) {
    const q = v[0]
    if ((q === "'" || q === '"') && v[v.length - 1] === q) return v.slice(1, -1).trim()
  }
  return v
}

// 声明值提取：声明锚后逐字符走，跟踪引号态，非引号内的 `;`（CSS 声明终止）与 `}`
// （样式块/对象字面量边界）即截断。`"` 的角色二义（JS 字符串引号 vs 模板 style 属性
// 闭合引号），双策略消歧：先按 JS 字面量解读（`"` 进出引号态），引号未闭合或结果含
// 游离 `"` 时回退为属性边界解读（`"` 即截断）。已知边界：style='…' 单引号属性包裹
// （本仓模板无此写法）会把闭合 ' 当引号对开启
function extractRaw(line, from, dqBreaks) {
  let v = ''
  let q = null
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (q !== null) {
      if (c === q) q = null
    } else if (c === ';' || c === '}') {
      break
    } else if (c === "'") {
      q = "'"
    } else if (c === '"') {
      if (dqBreaks) break
      q = '"'
    }
    v += c
  }
  return { v, unclosed: q !== null }
}

function declValue(line, from) {
  const post = (raw) => stripQuotePair(raw.replace(/[,\s>]+$/, '').trim())
  const js = extractRaw(line, from, false)
  const v = post(js.v)
  if (!js.unclosed && !v.includes('"')) return v
  return post(extractRaw(line, from, true).v)
}

// 单 token 合法性：通用关键字 / var() 引用 / JS 动态表达式
function tokenOk(raw) {
  const t = stripQuotePair(raw.trim())
  if (t === '') return true
  if (t.startsWith('var(')) return true
  if (GENERIC.has(t.toLowerCase())) return true
  if (DYNAMIC_RE.test(t) || t.includes('(')) return true
  return false
}

// 值级裁决：null = 合法（全 token 通过），否则返回命中值（空白规整后作基线键）
function judgeValue(value) {
  if (value === '') return null
  if (value.startsWith('var(')) return null
  const bad = value.split(',').filter((t) => !tokenOk(t))
  return bad.length > 0 ? value.replace(/\s+/g, ' ') : null
}

// ---------- 主流程 ----------
function walkSources(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSources(p))
    else if (e.isFile() && /\.tsx?$|\.vue$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walkSources(SRC)
const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).entries
  : {}
const hitsByKey = new Map() // key -> { rel, match, count, line, sample }

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (WHITELIST_FILES.has(rel)) continue
  const text = fs.readFileSync(file, 'utf-8')
  const noComment = blankRanges(text, commentRanges(text))
  const lines = noComment.split('\n')
  const originLines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    DECL_RE.lastIndex = 0
    let m
    while ((m = DECL_RE.exec(lines[i])) !== null) {
      const hit = judgeValue(declValue(lines[i], m.index + m[0].length))
      if (hit === null) continue
      const key = `${rel}|${hit}`
      if (!hitsByKey.has(key)) {
        hitsByKey.set(key, {
          rel,
          match: hit,
          count: 0,
          line: i + 1,
          sample: (originLines[i] || '').trim(),
        })
      }
      hitsByKey.get(key).count++
    }
  }
}

// ---------- 与基线比对 ----------
const rows = [] // { level: fail|exempt|stale, rel, match, count, line, sample, reason }
for (const [key, hit] of hitsByKey) {
  const reason = baseline[key]
  if (reason === undefined) rows.push({ level: 'fail', key, ...hit })
  else rows.push({ level: 'exempt', key, reason, ...hit })
}
for (const [key, reason] of Object.entries(baseline)) {
  if (!hitsByKey.has(key)) rows.push({ level: 'stale', key, reason, count: 0 })
}

// ---------- 输出与退出码 ----------
const ICON = { fail: '✗', exempt: '○', stale: '↑' }
for (const r of rows) {
  const [rel, match] = r.key.split('|') // stale 行无命中数据，文件/字面量从键还原
  const loc = r.line ? `${r.rel}:${r.line}` : rel
  const detail = r.level === 'stale' ? '已无命中，建议从基线移除' : `×${r.count} ${r.sample}`
  console.log(`${ICON[r.level]} [${r.level.padEnd(6)}] ${loc.padEnd(58)} ${match.padEnd(34)} ${detail}`)
  if (r.reason) console.log(`           豁免理由：${r.reason}`)
}
const fails = rows.filter((r) => r.level === 'fail')
console.log(`\n审计 ${files.length} 个源文件（.vue/.ts/.tsx 声明值）：命中 ${hitsByKey.size} 类，` +
  `基线豁免 ${rows.filter((r) => r.level === 'exempt').length}，已达标待移除 ${rows.filter((r) => r.level === 'stale').length}，` +
  `白名单外新增 ${fails.length}`)

if (UPDATE_BASELINE) {
  const doc = {
    _comment: '硬编码字体基线：存量直写豁免清单。键 = "文件|声明值"，值 = 豁免理由' +
      '（terminal-themes 注册表与 CrashFallback 零依赖回退为结构性白名单不在此列）；' +
      '治理替换为 var(--font-mono) 后删除对应条目。重建：npm run check:fonts -- --update-baseline',
    entries: Object.fromEntries(rows
      .filter((r) => r.level !== 'stale')
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => [r.key, r.reason ?? '存量豁免（待治理：替换为 var(--font-mono) 或补充豁免理由）'])),
  }
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
  console.log(`基线已重写：${path.relative(root, BASELINE)}（${Object.keys(doc.entries).length} 条）`)
} else if (fails.length > 0) {
  console.error('存在白名单外新增硬编码字体（防回潮），请替换为 var(--font-mono) 等 token 或更新基线并说明理由')
  process.exit(1)
}
