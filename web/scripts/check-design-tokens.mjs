// check-design-tokens.mjs —— 设计令牌三轴（圆角/间距/字重）off-scale 硬编码审计
// 无 shebang：本文件被 src/__tests__/design-tokens.test.ts import；Node 25 + vite/rolldown
// 的 SSR 转换会把生成的 import 前置到 shebang 前触发 ParseError。npm script 始终经
// `node scripts/...` 调用，不依赖可执行位。
//
// 用法：
//   node scripts/check-design-tokens.mjs              # 只读报告（默认退出码 0，不阻断构建；npm run check:design-tokens）
//   node scripts/check-design-tokens.mjs --verbose    # 逐条打印 file:line 明细
//   node scripts/check-design-tokens.mjs --strict     # 存在 off-scale 命中时退出码 1（未来门禁转正用）
//   node scripts/check-design-tokens.mjs --self-test  # 扫描器自测（合成用例，不读仓库）
//
// 说明：
//   - 动机（P-20261019-8）：圆角曾 9 种、间距无 4/8/12/16 网格、字重与层级靠颜色，
//     治理成本随样式面增长。三轴令牌定义在 src/assets/main.css：--radius-sm/md/lg
//     = 4/6/10、--space-1..4 = 4/8/12/16、--fw-regular/medium/semibold = 400/500/600。
//   - 审计面 = src 下全部 .css 与 .vue 的 <style> 段（模板静态 style / :style 动态绑定 /
//     script 段不入面，与 check-motion / check-hardcoded-colors 同口径）。CSS 注释内
//     字样不计。
//   - 只审间距类属性（gap/row-gap/column-gap/padding*/margin*），不把 width/height/
//     font-size 等尺寸轴混入——那些是布局尺寸不是节奏刻度。
//   - 分类：
//       on-scale  = 已是 4/8/12/16（或字重 400/500/600），应令牌化为 var(--space-*)；
//       micro     = 1~3px 间距 / 1~2px 圆角：密集面板的刻意微间距与指示线，
//                   不判错、单独计数（渐进收敛面，见 docs/design/design-tokens.md）；
//       shape     = 50% / 999px / 0 等结构值：头像圆点、胶囊、复位，结构性豁免；
//       off-scale = 其余 5/6/7/10/12/13/14/18/20/24... 与字重 300/700/800：本报告主目标。
//   - 默认不阻断：本脚本刻意不挂进 npm run check 链；令牌定义漂移（main.css 缺 token
//     或数值不符）仍会退出 1——那是契约破坏而非存量债务。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const MAIN_CSS = path.join(SRC, 'assets', 'main.css')

const EXPECTED_TOKENS = {
  '--radius-sm': '4px',
  '--radius-md': '6px',
  '--radius-lg': '10px',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--fw-regular': '400',
  '--fw-medium': '500',
  '--fw-semibold': '600',
}

const RADIUS_SCALE = new Set(['4px', '6px', '10px'])
const SPACE_SCALE = new Set(['4px', '8px', '12px', '16px'])
const WEIGHT_SCALE = new Set(['400', '500', '600'])

// 结构性豁免：形状值不进刻度（50% 头像圆点、999px 胶囊、0 复位）
const SHAPE_VALUES = new Set(['0', '0px', '50%', '999px', '9999px'])
const RADIUS_MICRO = new Set(['1px', '2px'])
const SPACE_MICRO = new Set(['1px', '2px', '3px'])

const VERBOSE = process.argv.includes('--verbose')
const STRICT = process.argv.includes('--strict')
const SELF_TEST = process.argv.includes('--self-test')

// 高频面（P-20261019-8 首批落地域）：Git 面板 / 设置 / 活动栏 / 顶栏 / 状态栏。
// 报告按域分组，便于判断「令牌先落面」的进度。
const HOT_PREFIXES = [
  'src/views/git/',
  'src/components/git/',
  'src/components/settings/',
]
const HOT_FILES = new Set([
  'src/components/layout/ActivityBar.vue',
  'src/components/layout/TopBar.vue',
  'src/components/layout/StatusBar.vue',
])

function isHot(rel) {
  return HOT_PREFIXES.some((p) => rel.startsWith(p)) || HOT_FILES.has(rel)
}

// ---------- 文本处理：注释同长屏蔽（换行保留，行号不变） ----------
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function styleSpans(rel, text) {
  if (rel.endsWith('.css')) return [[0, text.length]]
  const spans = []
  const re = /<style[^>]*>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const close = text.indexOf('</style>', m.index)
    if (close === -1) break
    spans.push([m.index + m[0].length, close])
    re.lastIndex = close + 8
  }
  return spans
}

function walkStyleFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkStyleFiles(p, out)
    else if (/\.(vue|css)$/.test(e.name)) out.push(p)
  }
  return out
}

// ---------- 扫描核心：返回命中列表（纯函数，供 --self-test 复用） ----------
// 命中形状：{ rel, line, prop, value, axis, kind: 'on-scale'|'micro'|'shape'|'off-scale' }
function scanText(text, rel = 'synthetic.vue') {
  const clean = blankComments(text)
  const hits = []
  const lineAt = (pos) => clean.slice(0, pos).split('\n').length
  for (const [s, e] of styleSpans(rel, clean)) {
    const seg = clean.slice(s, e)
    const declRe = /(?<![\w-])(border-radius|gap|row-gap|column-gap|padding(?:-top|-right|-bottom|-left)?|margin(?:-top|-right|-bottom|-left)?|font-weight)\s*:\s*([^;{}]+)/g
    let d
    while ((d = declRe.exec(seg)) !== null) {
      const prop = d[1]
      const value = d[2].trim()
      const line = lineAt(s + d.index)
      if (prop === 'font-weight') {
        const numeric = value.match(/^-?\d+(?:\.\d+)?$/)
        if (numeric) {
          const v = numeric[0]
          const kind = WEIGHT_SCALE.has(v) ? 'on-scale' : 'off-scale'
          hits.push({ rel, line, prop, value, axis: 'weight', kind })
        } else if (/^(bold|bolder|lighter|normal)$/i.test(value)) {
          hits.push({ rel, line, prop, value, axis: 'weight', kind: 'off-scale' })
        }
        continue
      }
      const isRadius = prop === 'border-radius'
      const scale = isRadius ? RADIUS_SCALE : SPACE_SCALE
      // 百分比圆角（50%/100%）是头像/圆点的结构形状，px 正则抓不到，单列 shape
      if (isRadius && /(?:^|\s)(?:50|100)%/.test(value)) {
        hits.push({ rel, line, prop, value: '50%/100%', axis: 'radius', kind: 'shape' })
      }
      for (const m of value.matchAll(/(?<![\w.-])(-?\d+(?:\.\d+)?)px/g)) {
        const v = `${m[1]}px`
        let kind
        if (SHAPE_VALUES.has(v)) kind = 'shape'
        else if (scale.has(v)) kind = 'on-scale'
        else if (isRadius && RADIUS_MICRO.has(v)) kind = 'micro'
        else if (!isRadius && SPACE_MICRO.has(v)) kind = 'micro'
        else kind = 'off-scale'
        hits.push({ rel, line, prop, value: v, axis: isRadius ? 'radius' : 'space', kind })
      }
    }
  }
  return hits
}

function parseTokenDefinitions(text) {
  const out = {}
  for (const name of Object.keys(EXPECTED_TOKENS)) {
    const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;{}]+);`)
    const m = text.match(re)
    out[name] = m ? m[1].trim() : null
  }
  return out
}

function validateTokens(defs) {
  const errors = []
  for (const [name, expected] of Object.entries(EXPECTED_TOKENS)) {
    if (defs[name] === null) errors.push(`缺少令牌 ${name}（main.css :root）`)
    else if (defs[name] !== expected) errors.push(`${name} = ${defs[name]}，期望 ${expected}`)
  }
  return errors
}

// ---------- 自测：扫描器行为锁定（合成用例，零仓库依赖） ----------
function selfTest() {
  const cases = [
    ['border-radius: 4px;', 1, 0, 0], // on-scale
    ['border-radius: 8px;', 0, 0, 1], // off-scale
    ['border-radius: 50%;', 0, 0, 0], // shape
    ['border-radius: 2px;', 0, 1, 0], // micro
    ['border-radius: 3px;', 0, 0, 1], // 3px 圆角属收敛目标（微间距豁免只到 2px）
    ['gap: 4px;', 1, 0, 0],
    ['padding: 4px 8px;', 2, 0, 0],
    ['padding: 6px 10px;', 0, 0, 2],
    ['margin: 0 4px;', 1, 0, 0], // 0 是 shape，只计 4px
    ['margin: 0 2px;', 0, 1, 0],
    ['font-weight: 600;', 1, 0, 0],
    ['font-weight: 700;', 0, 0, 1],
    ['font-weight: bold;', 0, 0, 1],
    ['/* border-radius: 8px; */ border-radius: 4px;', 1, 0, 0], // 注释不计
    ['width: 6px; height: 4px;', 0, 0, 0], // 非间距/圆角属性不入面
  ]
  let failed = 0
  cases.forEach(([css, onScale, micro, off], i) => {
    const hits = scanText(`<style>${css}</style>`)
    const got = {
      on: hits.filter((h) => h.kind === 'on-scale').length,
      micro: hits.filter((h) => h.kind === 'micro').length,
      off: hits.filter((h) => h.kind === 'off-scale').length,
    }
    const ok = got.on === onScale && got.micro === micro && got.off === off
    if (!ok) {
      failed++
      console.error(`  ✗ #${i + 1} ${css} → on=${got.on} micro=${got.micro} off=${got.off}，期望 on=${onScale} micro=${micro} off=${off}`)
    }
  })
  const defs = parseTokenDefinitions(`
    :root { --radius-sm: 4px; --radius-md: 6px; --radius-lg: 10px;
      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
      --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; }`)
  const tokenErrors = validateTokens(defs)
  if (tokenErrors.length > 0) {
    failed++
    console.error(`  ✗ 令牌解析失败：${tokenErrors.join('; ')}`)
  }
  if (failed === 0) console.log(`[design-tokens:self-test] ${cases.length + 1}/${cases.length + 1} 通过`)
  else console.error(`[design-tokens:self-test] ${failed} 项失败`)
  process.exitCode = failed === 0 ? 0 : 1
}

function main() {
  if (SELF_TEST) {
    selfTest()
    return
  }

  const mainText = fs.readFileSync(MAIN_CSS, 'utf-8')
  const defs = parseTokenDefinitions(mainText)
  const tokenErrors = validateTokens(defs)
  if (tokenErrors.length > 0) {
    console.error('[design-tokens] 令牌契约破坏：')
    for (const err of tokenErrors) console.error(`  - ${err}`)
    process.exitCode = 1
    return
  }
  console.log(
    '[design-tokens] 令牌定义 ✓ '
    + `radius ${defs['--radius-sm']}/${defs['--radius-md']}/${defs['--radius-lg']} · `
    + `space ${defs['--space-1']}/${defs['--space-2']}/${defs['--space-3']}/${defs['--space-4']} · `
    + `fw ${defs['--fw-regular']}/${defs['--fw-medium']}/${defs['--fw-semibold']}`,
  )

  const files = walkStyleFiles(SRC)
  const all = []
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    all.push(...scanText(fs.readFileSync(file, 'utf-8'), rel))
  }

  const byKind = { 'on-scale': 0, micro: 0, shape: 0, 'off-scale': 0 }
  const byAxis = { radius: 0, space: 0, weight: 0 }
  const offValues = new Map() // `${axis}:${value}` -> count
  const hot = { total: 0, off: 0, on: 0 }
  for (const hit of all) {
    byKind[hit.kind]++
    if (hit.kind === 'off-scale') {
      byAxis[hit.axis]++
      const key = `${hit.axis}:${hit.value}`
      offValues.set(key, (offValues.get(key) ?? 0) + 1)
    }
    if (isHot(hit.rel)) {
      hot.total++
      if (hit.kind === 'off-scale') hot.off++
      if (hit.kind === 'on-scale') hot.on++
    }
  }

  console.log(
    `[design-tokens] 扫描 ${files.length} 个样式文件：on-scale ${byKind['on-scale']} · `
    + `micro ${byKind.micro} · shape ${byKind.shape} · off-scale ${byKind['off-scale']}`,
  )
  console.log(
    `[design-tokens] off-scale 分轴：radius ${byAxis.radius} · space ${byAxis.space} · fw ${byAxis.weight}`,
  )
  console.log(
    `[design-tokens] 高频面（Git/设置/活动栏/顶栏）：可令牌化 on-scale ${hot.on} · `
    + `off-scale ${hot.off}（共 ${hot.total} 处命中）`,
  )

  const top = [...offValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  if (top.length > 0) {
    console.log('[design-tokens] off-scale 高频值：')
    for (const [key, count] of top) {
      const [axis, value] = key.split(':')
      console.log(`  ${axis.padEnd(6)} ${value.padEnd(7)} ×${count}`)
    }
  }

  if (VERBOSE) {
    console.log('[design-tokens] 明细（仅 off-scale）：')
    for (const hit of all) {
      if (hit.kind !== 'off-scale') continue
      console.log(`  ${hit.rel}:${hit.line}  ${hit.prop}: ${hit.value}  [${hit.axis}]`)
    }
  } else {
    console.log('[design-tokens] 逐条明细：node scripts/check-design-tokens.mjs --verbose')
  }

  if (STRICT && byKind['off-scale'] > 0) {
    console.error(`[design-tokens] --strict：仍有 ${byKind['off-scale']} 处 off-scale 硬编码`)
    process.exitCode = 1
  }
}

// 单测可 import 纯函数：仅直接执行（node scripts/...）时跑 CLI 主流程，
// 被 import 时不产生读盘/退出码副作用。
export { EXPECTED_TOKENS, parseTokenDefinitions, scanText, validateTokens }

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) main()
