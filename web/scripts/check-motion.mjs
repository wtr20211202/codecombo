#!/usr/bin/env node
// check-motion.mjs —— transition 裸时长（ms/s 字面量）审计（P-20261007-16 动效 token 门禁）
//
// 用法：
//   node scripts/check-motion.mjs                    # 校验，白名单外新增裸时长退出码 1（存量按基线豁免）
//   node scripts/check-motion.mjs --update-baseline  # 以当前全部命中重写基线（治理流程专用）
//
// 说明：
//   - 动机（P-20261007-16）：动效时长曾 9 种值并存（0.08~0.4s），同产品 hover/面板/浮层三种速度
//     ——收敛为 base.css 三档 token --motion-fast/base/slow（+ --ease-standard/emphasized 缓动词汇表），
//     transition 声明里的 duration 一律 var() 引用；本门禁防裸值回潮（与 check-hardcoded-colors 同族治理）
//   - 审计面：src 下全部 .vue 的 <style> 段 + 全部 .css；模板静态 style 属性当前零存量，
//     出现时同样命中（transition 字面量在属性值内即报）——script 段与 :style 动态绑定不入审计
//   - 合法豁免（结构性，不进基线）：
//     ① InstanceSwitchOverlay.vue / LockScreenOverlay.vue 整文件——P-20261011-1 遮罩闪烁防御
//       调优面：时长与 coarse 减半规则、<Transition :duration> JS 钉兜底成对，token 化需整链双改
//   - 功能性时长（非装饰节奏）走基线豁免并写理由：reduced-motion kill switch（0.01ms）、
//     autofill 背景过渡抑制（99999s）、进度条 width 跟手（与数据节奏同步）、boot 遮罩防御链
//   - CSS 注释 /* */ 内的时长字样不计（文档性提及非样式）
//   - 只审 transition / transition-duration 的值：animation/keyframes 时长（呼吸/抖动/shimmer）
//     多为功能性节奏不入面；transition-delay 无存量且延迟属编排语义，不入面
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const BASELINE = path.join(root, 'scripts', 'motion-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

// P-20261011-1 遮罩防御调优面：整文件豁免（时长/减半/JS 钉三链成对，逐处拆开改必失配）
const WHITELIST_FILES = new Set([
  'src/components/instance/InstanceSwitchOverlay.vue',
  'src/components/lock/LockScreenOverlay.vue',
])

// transition / transition-duration 声明值（到 ; 或 } 止，含跨行）；(?:-duration)? 使
// transition-property/delay 等兄弟属性不误入（名字后随 \s*: 校验）
const DECL_RE = /(?<![\w-])transition(?:-duration)?\s*:\s*([^;{}]*)/g
// duration 字面量：带 s/ms 后缀（.3s 前导点形态也完整捕获；cubic-bezier 系数无后缀不命中；
// var()/calc() 内无带后缀数字）
const DURATION_RE = /(?:\d+\.?\d*|\.\d+)m?s\b/g

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

function collectRanges(re, text) {
  const ranges = []
  let m
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

// ---------- 段落定位 ----------
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

// ---------- 主流程 ----------
function walkStyleFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkStyleFiles(p, out)
    else if (/\.(vue|css)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walkStyleFiles(SRC)
const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).entries
  : {}
const hitsByKey = new Map() // key -> { rel, match, count, line, sample }

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (WHITELIST_FILES.has(rel)) continue
  const text = fs.readFileSync(file, 'utf-8')
  const noComment = blankRanges(text, collectRanges(/\/\*[\s\S]*?\*\//g, text))
  const spans = rel.endsWith('.css')
    ? [[0, noComment.length]]
    : styleBlockRanges(noComment)
  const lineAt = (pos) => text.slice(0, pos).split('\n').length
  for (const [s, e] of spans) {
    const seg = noComment.slice(s, e)
    DECL_RE.lastIndex = 0
    let d
    while ((d = DECL_RE.exec(seg)) !== null) {
      const value = d[1]
      DURATION_RE.lastIndex = 0
      let m
      while ((m = DURATION_RE.exec(value)) !== null) {
        const match = m[0]
        const key = `${rel}|${match}`
        const line = lineAt(s + d.index + m.index)
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
  }
}

// ---------- 与基线比对 ----------
const rows = [] // { level: fail|exempt|stale, key, ...hit, reason }
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
  console.log(`${ICON[r.level]} [${r.level.padEnd(6)}] ${loc.padEnd(58)} ${match.padEnd(10)} ${detail}`)
  if (r.reason) console.log(`           豁免理由：${r.reason}`)
}
const fails = rows.filter((r) => r.level === 'fail')
console.log(`\n审计 ${files.length} 个样式文件（vue style 段 + css）：命中 ${hitsByKey.size} 类，` +
  `基线豁免 ${rows.filter((r) => r.level === 'exempt').length}，已达标待移除 ${rows.filter((r) => r.level === 'stale').length}，` +
  `白名单外新增 ${fails.length}`)

if (UPDATE_BASELINE) {
  const doc = {
    _comment: 'transition 裸时长基线（P-20261007-16 动效 token 门禁）：功能性时长豁免清单。' +
      '键 = "文件|时长字面量"，值 = 豁免理由（P-20261011-1 遮罩防御调优面为整文件结构性豁免不在此列）；' +
      '装饰性时长一律收敛 var(--motion-fast/base/slow) 后删除对应条目。' +
      '重建：npm run check:motion -- --update-baseline',
    entries: Object.fromEntries(rows
      .filter((r) => r.level !== 'stale')
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => [r.key, r.reason ?? '存量豁免（待治理：收敛到 motion token 或补充豁免理由）'])),
  }
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
  console.log(`基线已重写：${path.relative(root, BASELINE)}（${Object.keys(doc.entries).length} 条）`)
} else if (fails.length > 0) {
  console.error('存在白名单外新增 transition 裸时长（防回潮），请收敛到 var(--motion-*) 三档 token 或更新基线并说明理由')
  process.exit(1)
}
