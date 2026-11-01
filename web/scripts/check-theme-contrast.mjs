#!/usr/bin/env node
// check-theme-contrast.mjs —— 六主题语义色对 WCAG 可读性对比度校验
//
// 用法：
//   node scripts/check-theme-contrast.mjs                    # 校验，新增不达标退出码 1（存量债务按基线豁免）
//   node scripts/check-theme-contrast.mjs --update-baseline  # 以当前全部不达标项重写基线（治理流程专用）
//
// 说明：
//   - 从 src/themes/*.ts 轻量解析 colors 映射（同 check-i18n 思路：行级正则，不做 AST），
//     主题发现按目录扫描——新增主题文件自动纳入校验
//   - 门槛按「实际渲染字号/字重/是否图形」绑定（P-20261019-4，规则与色对表见
//     scripts/theme-contrast-lib.mjs）：常规字号文本 ≥4.5、大字号/非文本图形 ≥3。
//     语义角色不再直接决定门槛——辅助文字 10~13px 走 4.5 档，不再按「大字例外」放行
//   - 色对只收纯色，linear-gradient/transparent/含透明度衬底等跳过并计数
//   - 不达标项输出 主题+色对+实测值/门槛 清单；存量债务记入
//     theme-contrast-baseline.json 豁免，基线值是「已接受下限」——比下限更差仍判
//     失败（基线内持续劣化不被静默放过），基线条目实测已达标时提示移除（治理收敛）
//   - 独立调用，不进 npm run check 主链；报告驱动后续主题治理提案
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAIR_SPECS, evaluateTheme, parseThemeColors } from './theme-contrast-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEMES_DIR = path.join(root, 'src', 'themes')
const BASELINE = path.join(root, 'scripts', 'theme-contrast-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

// ---------- 校验主流程 ----------
const themeFiles = fs.readdirSync(THEMES_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => path.join(THEMES_DIR, e.name))

const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).entries
  : {}
const nextBaseline = {}

const rows = [] // { level: pass|fail|exempt|stale|skip, theme, pair, detail }
let passCount = 0
for (const file of themeFiles) {
  const theme = path.basename(file, '.ts')
  const colors = parseThemeColors(fs.readFileSync(file, 'utf-8'))
  if (colors.size === 0) {
    rows.push({ level: 'skip', theme, pair: '-', detail: '未找到 colors 块，跳过' })
    continue
  }
  for (const row of evaluateTheme(theme, colors, PAIR_SPECS)) {
    const key = `${row.theme}|${row.pair}`
    const floor = baseline[key]
    if (row.level === 'pass') {
      passCount += 1
      if (key in baseline) {
        rows.push({ level: 'stale', theme, pair: row.pair, detail: `已达标 ${row.ratio.toFixed(2)} ≥ ${row.min}，建议从基线移除` })
      }
      continue
    }
    if (row.level === 'skip') {
      rows.push(row)
      continue
    }
    if (floor === undefined) {
      rows.push({ level: 'fail', theme, pair: row.pair, detail: `${row.detail} —— 新增不达标` })
      nextBaseline[key] = Number(row.ratio.toFixed(2))
    } else if (row.ratio < floor) {
      rows.push({ level: 'fail', theme, pair: row.pair, detail: `${row.detail}，低于基线下限 ${floor.toFixed(2)} —— 基线内劣化` })
      nextBaseline[key] = Number(row.ratio.toFixed(2))
    } else {
      rows.push({ level: 'exempt', theme, pair: row.pair, detail: `${row.detail}，基线豁免（下限 ${floor.toFixed(2)}）` })
      nextBaseline[key] = floor
    }
  }
}

// ---------- 输出与退出码 ----------
const ICON = { fail: '✗', exempt: '○', stale: '↑', skip: '-' }
for (const r of rows) console.log(`${ICON[r.level]} [${r.level.padEnd(6)}] ${r.theme.padEnd(10)} ${r.pair.padEnd(30)} ${r.detail}`)
const fails = rows.filter((r) => r.level === 'fail')
const counts = (lv) => rows.filter((r) => r.level === lv).length
console.log(`\n校验 ${themeFiles.length} 个主题 × ${PAIR_SPECS.length} 色对：` +
  `不达标 ${fails.length}，基线豁免 ${counts('exempt')}，已达标待移除 ${counts('stale')}，跳过 ${counts('skip')}` +
  `（通过 ${passCount}）`)

if (UPDATE_BASELINE) {
  const doc = {
    _comment: '主题对比度基线：存量不达标色对清单。键 = "主题|fg/bg"，值 = 审计时实测对比度' +
      '（已接受下限，劣化会被判失败）；治理达标后删除对应条目。门槛按实际字号绑定：' +
      '常规文本 ≥4.5、大字号/非文本图形 ≥3（见 scripts/theme-contrast-lib.mjs）。' +
      '重建：npm run check:theme -- --update-baseline',
    entries: Object.fromEntries(Object.entries(nextBaseline).sort(([a], [b]) => a.localeCompare(b))),
  }
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
  console.log(`基线已重写：${path.relative(root, BASELINE)}（${Object.keys(doc.entries).length} 条）`)
} else if (fails.length > 0) {
  console.error('存在新增不达标（或基线内劣化）色对，见上方 ✗ 清单')
  process.exit(1)
}
