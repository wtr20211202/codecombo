#!/usr/bin/env node
// icon-similarity-report.mjs —— 图标感知相似度全量排查工具（P-20261022-2）
//
// 用法（web/ 内，按需手跑，不入 check 链——依赖 Playwright 渲染，属开发环境工具）：
//   node scripts/icon-similarity-report.mjs                # 全量两两对比，报告落
//                                                          # <repoRoot>/.goal-enhance/icon-similarity-<date>.md
//   node scripts/icon-similarity-report.mjs --min 0.8      # 自定观察档下限（默认 0.70）
//   node scripts/icon-similarity-report.mjs --json         # 机读 JSON 打到 stdout（不落盘）
//
// 动机：check-icon-semantics 的邻接族（R5）是人工维护的小集合，明确不做视觉相似度
// 启发式——相似对只能靠用户撞上（P-20261022-2：git 面板与分享管理在 20px 深色 rail
// 上同属「圆点+连线」族）。本工具把「动作注册表 + 目的地 nav 注册表 + 面板注册表 +
// 首页工具条」的全部 ionicons 图标批量渲染为规范化位图，两两算归一化互相关（NCC），
// 输出「图标对 / 相似度 / 各自承载的动作与目的地 / 共现面」，供人工终审分档：
//   ≥0.85 高危（必改 / 豁免登记）/ 0.70~0.85 观察（挂起复核）。
//
// 已知边界（为什么必须人工终审）：
//   ① ionicons5 Outline 族共享圆环语法，圆形图标天然 NCC 偏高——高危档不自动等于必改；
//   ② NCC 对抗锯齿/描边粗细敏感，是形状相似度启发式而非「人眼难辨」判定；
//   ③ 「同语法不同布局」的风格相似对（如实测：git 分支 × 分享网络两枚「圆点+连线」
//      图，像素/墨量分布相关均 <0.5）超出像素启发式的可达范围——该类只能靠人工
//      审查与用户反馈发现，回潮由 R6b 静态禁配对清单（FORBIDDEN_ICON_PAIRS）兜住；
//   ④ 共现面只标注静态可达的同屏（rail/首页工具条/TopBar/同文件），运行期互斥视图
//      （如仪表盘与分享管理互斥收开）的先后同屏由人工终审补充裁量。
// 排查结论的人工分档落 docs/design/icon-semantics.md「感知相似度禁配对」节；
// 门禁只消费其中的静态禁配对清单（FORBIDDEN_ICON_PAIRS），不依赖本工具。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(WEB_ROOT, '..')
const SRC = path.join(WEB_ROOT, 'src')
const REGISTRY_FILE = path.join(SRC, 'utils', 'actionIcons.ts')
const PANELS_FILE = path.join(SRC, 'panels', 'registry.ts')
const HOME_VIEW_FILE = path.join(SRC, 'views', 'home', 'HomeView.vue')
const TOPBAR_FILE = path.join(SRC, 'components', 'layout', 'TopBar.vue')

const args = process.argv.slice(2)
const JSON_OUT = args.includes('--json')
const minIdx = args.indexOf('--min')
const WATCH_MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : 0.7
const HIGH_MIN = 0.85
// 位图边长：默认 20px（rail/工具条实际渲染尺寸——感知相似度以用户所见为准）；
// SIM_BITMAP 环境变量可提高超采样做形状细节取证（如 SIM_BITMAP=80）
const BITMAP = Number(process.env.SIM_BITMAP) || 20

// ---------- 文本解析（与 check-icon-semantics.mjs 同风格的零依赖解析） ----------
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

function parseRegistryFile(text) {
  const out = { actions: {}, nav: {}, nonAction: new Set() }
  const actionBody = extractBracedBlock(text, 'ACTION_ICONS')
  const navBody = extractBracedBlock(text, 'NAV_ICONS')
  const nonActionBody = extractArrayBlock(text, 'NON_ACTION_ICONS')
  if (actionBody === null || nonActionBody === null) {
    console.error('[icon-similarity] actionIcons.ts 结构不可解析')
    process.exit(2)
  }
  for (const m of actionBody.matchAll(/^\s*'([^']+)'\s*:\s*([A-Za-z0-9_]+)\s*,/gm)) out.actions[m[1]] = m[2]
  // NAV_ICONS 是 P-20261022-2 新增段：老基线上不存在时按空表处理（报告照常产出）
  if (navBody !== null) {
    for (const m of navBody.matchAll(/^\s*'([^']+)'\s*:\s*([A-Za-z0-9_]+)\s*,/gm)) out.nav[m[1]] = m[2]
  }
  for (const m of nonActionBody.matchAll(/'([A-Za-z0-9]+)'/g)) out.nonAction.add(m[1])
  return out
}

/** panels/registry.ts 的 registerPanel 块 → {id, group, icon}（icon 可能是品牌组件） */
function parsePanels(text) {
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
  const names = new Set()
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]@vicons\/ionicons5['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    // 行尾注释（如 `SettingsOutline,   // vscode`）按空格抹掉，防注释词混入图标名
    const clean = m[1].replace(/\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '))
    for (const raw of clean.split(',')) {
      const name = raw.replace(/\s+as\s+/g, ' ').trim().split(/\s+/).pop()
      if (name && /^[A-Za-z0-9]+$/.test(name)) names.add(name)
    }
  }
  return names
}

// ---------- 渲染：SSR 出 SVG → 页内 canvas 光栅化为灰度位图 ----------
async function renderBitmaps(iconNames, ionicons) {
  const { createSSRApp, h } = await import('vue')
  const { renderToString } = await import('vue/server-renderer')
  const { chromium } = await import('@playwright/test')

  const cells = []
  for (const name of iconNames) {
    const html = await renderToString(createSSRApp({ render: () => h(ionicons[name]) }))
    cells.push({ name, html })
  }
  const body = cells
    .map((c) => `<div class="cell" data-icon="${c.name}">${c.html}</div>`)
    .join('\n')
  const page = await chromium.launch().then((b) => b.newPage())
  try {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      .cell { display: none; }
    </style></head><body>${body}</body></html>`)
    return await page.evaluate(async ({ size }) => {
      const out = []
      for (const cell of document.querySelectorAll('.cell')) {
        const svg = cell.querySelector('svg')
        if (!svg) continue
        // 独立 SVG 里 currentColor 回落黑色，显式钉白；黑底白线与深色 rail 观感同向
        svg.setAttribute('width', String(size))
        svg.setAttribute('height', String(size))
        svg.setAttribute('style', 'color:#fff')
        const img = new Image()
        const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = () => reject(new Error(`svg 渲染失败: ${cell.dataset.icon}`))
          img.src = src
        })
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, size, size)
        ctx.drawImage(img, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data
        const gray = new Array(size * size)
        for (let i = 0; i < gray.length; i++) {
          gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
        }
        out.push({ icon: cell.dataset.icon, gray })
      }
      return out
    }, { size: BITMAP })
  } finally {
    await page.context().browser().close()
  }
}

/** 归一化互相关（NCC）：亮度/对比度不变量，[-1,1]；零方差（空白位图）按 0 处理 */
function ncc(a, b) {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

// ---------- 报告 ----------
function bandOf(score) {
  if (score >= HIGH_MIN) return '高危'
  if (score >= WATCH_MIN) return '观察'
  return null
}

async function main() {
  const ionicons = await import('@vicons/ionicons5')
  const known = new Set(Object.keys(ionicons))

  const reg = parseRegistryFile(fs.readFileSync(REGISTRY_FILE, 'utf-8'))
  const panels = parsePanels(fs.readFileSync(PANELS_FILE, 'utf-8'))
  const homeToolbar = collectIconImports(fs.readFileSync(HOME_VIEW_FILE, 'utf-8'))
  const topbar = collectIconImports(fs.readFileSync(TOPBAR_FILE, 'utf-8'))

  // 每文件导入面（同文件共现判定）
  const fileImports = new Map()
  for (const abs of walkSource(SRC)) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/')
    fileImports.set(rel, collectIconImports(fs.readFileSync(abs, 'utf-8')))
  }

  // 图标 → 承载面反查
  const iconActions = new Map()
  for (const [key, icon] of Object.entries(reg.actions)) {
    if (!iconActions.has(icon)) iconActions.set(icon, [])
    iconActions.get(icon).push(key)
  }
  const iconNavs = new Map()
  for (const [key, icon] of Object.entries(reg.nav)) {
    if (!iconNavs.has(icon)) iconNavs.set(icon, [])
    iconNavs.get(icon).push(key)
  }
  const iconPanels = new Map()
  for (const p of panels) {
    if (!iconPanels.has(p.icon)) iconPanels.set(p.icon, [])
    iconPanels.get(p.icon).push({ id: p.id, rail: p.group === 'rail-top' })
  }
  const iconFiles = new Map()
  for (const [rel, names] of fileImports) {
    for (const name of names) {
      if (!iconFiles.has(name)) iconFiles.set(name, [])
      iconFiles.get(name).push(rel)
    }
  }

  // 渲染全集 = src 实际导入的全部 ionicons 名（能在屏上出现的才需要排查）
  const allNames = [...new Set([...fileImports.values()].flatMap((s) => [...s]))].filter((n) => known.has(n)).sort()
  const brandIcons = [...new Set([...fileImports.values()].flatMap((s) => [...s]))].filter((n) => !known.has(n))

  // 进度日志走 stderr：--json 时 stdout 保持纯 JSON 可管道消费
  process.stderr.write(`[icon-similarity] 渲染 ${allNames.length} 枚 ionicons 图标（另 ${brandIcons.length} 枚品牌图标不入位图：${brandIcons.join(', ') || '无'}）…\n`)
  const bitmaps = await renderBitmaps(allNames, ionicons)
  if (bitmaps.length !== allNames.length) {
    console.error(`[icon-similarity] 渲染数量不符：${bitmaps.length}/${allNames.length}`)
    process.exit(2)
  }

  // 两两 NCC
  const pairs = []
  for (let i = 0; i < bitmaps.length; i++) {
    for (let j = i + 1; j < bitmaps.length; j++) {
      const score = ncc(bitmaps[i].gray, bitmaps[j].gray)
      if (score >= WATCH_MIN) pairs.push({ a: bitmaps[i].icon, b: bitmaps[j].icon, score })
    }
  }
  pairs.sort((x, y) => y.score - x.score)

  const rel = (name) => {
    const parts = []
    const acts = iconActions.get(name) || []
    const navs = iconNavs.get(name) || []
    if (acts.length > 0) parts.push(`动作 ${acts.join('/')}`)
    if (navs.length > 0) parts.push(`目的地 ${navs.join('/')}`)
    const panelsUse = iconPanels.get(name) || []
    if (panelsUse.length > 0) {
      parts.push(`面板 ${[...new Set(panelsUse.map((p) => p.id))].map((id) => `${id}(${panelsUse.filter((p) => p.id === id).some((p) => p.rail) ? 'rail+bottom' : 'bottom'})`).join('/')}`)
    }
    if (reg.nonAction.has(name) && parts.length === 0) parts.push('非动作（装饰）')
    if (parts.length === 0) parts.push('未登记引用')
    return parts.join('；')
  }
  const cooccurrence = (a, b) => {
    const notes = []
    const railTop = new Set(panels.filter((p) => p.group === 'rail-top').map((p) => p.icon))
    if (railTop.has(a) && railTop.has(b)) notes.push('rail 同屏')
    if (homeToolbar.has(a) && homeToolbar.has(b)) notes.push('首页工具条同屏')
    if (topbar.has(a) && topbar.has(b)) notes.push('TopBar 同屏')
    const fa = new Set(iconFiles.get(a) || [])
    const common = [...(iconFiles.get(b) || [])].filter((f) => fa.has(f))
    if (common.length > 0) notes.push(`同文件 ${common.slice(0, 4).join(', ')}${common.length > 4 ? ` 等 ${common.length} 文件` : ''}`)
    return notes
  }

  const highCount = pairs.filter((p) => p.score >= HIGH_MIN).length
  const watchCount = pairs.length - highCount

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      thresholds: { high: HIGH_MIN, watch: WATCH_MIN },
      rendered: allNames.length,
      brandIcons,
      pairs: pairs.map((p) => ({ a: p.a, b: p.b, score: Number(p.score.toFixed(4)), band: bandOf(p.score), roles: [rel(p.a), rel(p.b)], cooccurrence: cooccurrence(p.a, p.b) })),
    }, null, 2) + '\n')
    return
  }

  const lines = []
  lines.push('# 图标感知相似度排查报告（P-20261022-2）')
  lines.push('')
  lines.push(`- 生成：${new Date().toISOString().slice(0, 10)}（工具 web/scripts/icon-similarity-report.mjs，按需手跑不入 check 链）`)
  lines.push(`- 阈值：高危 ≥${HIGH_MIN}（NCC）/ 观察 ${WATCH_MIN}~${HIGH_MIN}；位图 ${BITMAP}px（黑底白线，与深色 rail 观感同向）`)
  lines.push(`- 渲染面：src 实际导入的全部 ${allNames.length} 枚 ionicons；品牌图标（${brandIcons.join(', ') || '无'}）独占图形不入位图`)
  lines.push(`- 命中：高危 ${highCount} 对 / 观察 ${watchCount} 对（两两共 ${allNames.length * (allNames.length - 1) / 2} 对比）`)
  lines.push('')
  lines.push('## 同图多目的地（一图一目的地规则预检）')
  lines.push('')
  const dupNav = [...iconNavs.entries()].filter(([, keys]) => keys.length > 1)
  // 同一面板 id 同时出现在 rail 与 bottom-tab 是同一目的地的多入口（正确一致性）；
  // 只报「不同面板 id 共用同一图标」
  const dupRail = [...iconPanels.entries()].filter(([, uses]) => new Set(uses.map((u) => u.id)).size > 1)
  if (dupNav.length === 0 && dupRail.length === 0) {
    lines.push('无（NAV_ICONS 内一图一目的地、面板无跨面板同图复用）。')
  } else {
    for (const [icon, keys] of dupNav) lines.push(`- ${icon}：目的地 ${keys.join(' / ')} —— 同图对应多个目的地键，违反一图一目的地`)
    for (const [icon, uses] of dupRail) lines.push(`- ${icon}：面板 ${[...new Set(uses.map((u) => u.id))].join(' / ')} —— 不同面板共用同一图标`)
  }
  lines.push('')
  lines.push('## 相似对（降序）')
  lines.push('')
  lines.push('| # | 相似度 | 档 | 图标 A | 承载 | 图标 B | 承载 | 共现面 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  pairs.forEach((p, i) => {
    const notes = cooccurrence(p.a, p.b)
    lines.push(`| ${i + 1} | ${p.score.toFixed(4)} | ${bandOf(p.score)} | \`${p.a}\` | ${rel(p.a)} | \`${p.b}\` | ${rel(p.b)} | ${notes.join('；') || '跨文件/跨面'} |`)
  })
  lines.push('')
  lines.push('## 终审分档约定')
  lines.push('')
  lines.push('逐对裁决为三档：**必改**（换其中一枚，图形对入 `FORBIDDEN_ICON_PAIRS` 静态门禁）/ **接受**（强惯例族等，登记豁免理由）/ **观察**（挂起，后续报告复看）。裁决结果落 docs/design/icon-semantics.md「感知相似度禁配对」节。')

  const outDir = path.join(REPO_ROOT, '.goal-enhance')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `icon-similarity-${new Date().toISOString().slice(0, 10)}.md`)
  fs.writeFileSync(outPath, lines.join('\n') + '\n')

  process.stderr.write(`[icon-similarity] 高危 ${highCount} / 观察 ${watchCount}（渲染 ${allNames.length} 枚）\n`)
  for (const p of pairs.slice(0, 20)) {
    process.stderr.write(`  ${p.score.toFixed(4)} [${bandOf(p.score)}] ${p.a} × ${p.b} —— ${cooccurrence(p.a, p.b).join('；') || '跨文件/跨面'}\n`)
  }
  process.stderr.write(`[icon-similarity] 报告已落 ${outPath}\n`)
}

main().catch((err) => {
  console.error(`[icon-similarity] 执行失败：${err?.stack || err}`)
  process.exit(1)
})
