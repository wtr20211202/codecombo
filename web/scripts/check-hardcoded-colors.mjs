#!/usr/bin/env node
// check-hardcoded-colors.mjs —— vue 样式内硬编码颜色（hex/rgb(a)/hsl(a) 直写）审计
//
// 用法：
//   node scripts/check-hardcoded-colors.mjs                    # 校验，白名单外新增硬编码退出码 1（存量债务按基线豁免）
//   node scripts/check-hardcoded-colors.mjs --update-baseline  # 以当前全部命中重写基线（治理流程专用）
//
// 说明：
//   - 动机（P-20261003-11）：浅色主题落地后（62895a6 双轨化）浅色用户成为一等公民，
//     绕过主题变量的硬编码色在浅色下刺眼或不可读（深色残留边框/阴影/文字色），应收敛到 var(--*) 体系
//   - 扫描 src 下全部 .vue 的 <style> 段与模板静态 style="..." 属性值；
//     script 段与 :style 动态绑定属逻辑域不入审计
//   - 合法豁免（结构性，不进基线）：
//     ① src/components/crash/CrashFallback.vue 整文件——崩溃回退页须在主题 CSS 缺失时独立成立（P-26 零依赖特例）
//     ② var(--x, <fallback>) 参数内的默认值——仅变量缺失时兜底，非直写
//   - CSS 注释 /* */ 与 HTML 注释 <!-- --> 内的颜色字样不计（文档性提及非样式）
//   - 存量债务记入 hardcoded-colors-baseline.json（键 = 文件|颜色字面量，值 = 豁免理由），
//     白名单外新增即判失败防回潮；基线条目已无命中时提示移除（治理收敛）
//   - 不扫 .css：src/styles/terminal-effects.css 为 CRT 装饰特效、views/layout.css 为全局布局，
//     属后续治理批次扩展面
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const BASELINE = path.join(root, 'scripts', 'hardcoded-colors-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

// 零依赖回退特例：CrashFallback 渲染时主题 CSS 可能整体缺失，静态色是生存前提
const WHITELIST_FILES = new Set(['src/components/crash/CrashFallback.vue'])

// 颜色字面量：3~8 位 hex / rgb(a) / hsl(a)（大小写不敏感；具名色与 color-mix 内的 var 引用不在此列）
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^()]*\)/gi

// ---------- 同长屏蔽：把不需审计的 span 用空格填掉（换行保留，行号不变） ----------
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let pos = 0
  for (const [s, e] of ranges) {
    if (s < pos) continue // 重叠 span（嵌套注释等）跳过已屏蔽段
    out += text.slice(pos, s) + text.slice(s, e).replace(/[^\n]/g, ' ')
    pos = e
  }
  return out + text.slice(pos)
}

// regex 全文扫描收集 span；balanced=true 时从首个 '(' 起括号配平延展到闭括号
function collectRanges(re, text, balanced = false) {
  const ranges = []
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    let s = m.index
    let e = m.index + m[0].length
    if (balanced) {
      const open = text.indexOf('(', s)
      let depth = 1
      let i = open + 1
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') {
          depth--
          if (depth === 0) break
        }
      }
      e = Math.min(i + 1, text.length)
    }
    ranges.push([s, e])
    re.lastIndex = e
  }
  return ranges
}

// ---------- 段落定位（在屏蔽后的文本上做，位置与原文一致） ----------
function styleBlockRanges(text) {
  const ranges = []
  const re = /<style[^>]*>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const close = text.indexOf('</style>', m.index)
    if (close === -1) break
    ranges.push([m.index + m[0].length, close])
    re.lastIndex = close + 8
  }
  return ranges
}

// 模板静态 style 属性值（(?<=\s) 排除 :style 动态绑定）；在已屏蔽注释的模板上匹配
function styleAttrRanges(text) {
  const ranges = []
  const re = /(?<=\s)style=(["'])([\s\S]*?)\1/g
  let m
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index + m[0].indexOf(m[1]) + 1, m.index + m[0].length - 1])
  }
  return ranges
}

function inRanges(ranges, pos) {
  return ranges.some(([s, e]) => pos >= s && pos < e)
}

// ---------- 主流程 ----------
function walkVueFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkVueFiles(p))
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walkVueFiles(SRC)
const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).entries
  : {}
const hitsByKey = new Map() // key -> { rel, match, count, line, sample, inStyle }

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (WHITELIST_FILES.has(rel)) continue
  const text = fs.readFileSync(file, 'utf-8')
  // 第一轮屏蔽：CSS 块注释 + HTML 注释
  const commentRanges = [
    ...collectRanges(/\/\*[\s\S]*?\*\//g, text),
    ...collectRanges(/<!--[\s\S]*?-->/g, text),
  ]
  const noComment = blankRanges(text, commentRanges)
  // 第二轮屏蔽：var(...) 参数（fallback 默认值豁免）
  const shielded = blankRanges(noComment, collectRanges(/var\(/g, noComment, true))
  const styleBlocks = styleBlockRanges(shielded)
  const styleAttrs = styleAttrRanges(shielded)
  const lineAt = (pos) => text.slice(0, pos).split('\n').length
  COLOR_RE.lastIndex = 0
  let m
  while ((m = COLOR_RE.exec(shielded)) !== null) {
    const inStyle = inRanges(styleBlocks, m.index)
    const inAttr = !inStyle && inRanges(styleAttrs, m.index)
    if (!inStyle && !inAttr) continue // 模板文本/script 段：不入审计
    const match = m[0].replace(/\s+/g, ' ')
    const key = `${rel}|${match}`
    const line = lineAt(m.index)
    if (!hitsByKey.has(key)) {
      hitsByKey.set(key, {
        rel,
        match,
        count: 0,
        line,
        sample: (text.split('\n')[line - 1] || '').trim(),
      })
    }
    hitsByKey.get(key).count++
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
  console.log(`${ICON[r.level]} [${r.level.padEnd(6)}] ${loc.padEnd(58)} ${match.padEnd(26)} ${detail}`)
  if (r.reason) console.log(`           豁免理由：${r.reason}`)
}
const fails = rows.filter((r) => r.level === 'fail')
console.log(`\n审计 ${files.length} 个 vue（样式段 + 静态 style 属性）：命中 ${hitsByKey.size} 类，` +
  `基线豁免 ${rows.filter((r) => r.level === 'exempt').length}，已达标待移除 ${rows.filter((r) => r.level === 'stale').length}，` +
  `白名单外新增 ${fails.length}`)

if (UPDATE_BASELINE) {
  const doc = {
    _comment: 'vue 样式硬编码颜色基线：存量直写豁免清单。键 = "文件|颜色字面量"，值 = 豁免理由' +
      '（CrashFallback 零依赖回退与 var() fallback 参数为结构性豁免不在此列）；' +
      '治理替换为主题变量后删除对应条目。重建：npm run check:hardcoded-colors -- --update-baseline',
    entries: Object.fromEntries(rows
      .filter((r) => r.level !== 'stale')
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => [r.key, r.reason ?? '存量豁免（待治理：替换为主题变量或补充豁免理由）'])),
  }
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
  console.log(`基线已重写：${path.relative(root, BASELINE)}（${Object.keys(doc.entries).length} 条）`)
} else if (fails.length > 0) {
  console.error('存在白名单外新增硬编码颜色（防回潮），请替换为主题变量或更新基线并说明理由')
  process.exit(1)
}
