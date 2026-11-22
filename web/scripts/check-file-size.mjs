#!/usr/bin/env node
// check-file-size.mjs —— 单文件体量守卫（前端侧，2026-11-18 决议 33 用户定向「避免单文件过大」）
//
// Go 侧同源闸：server/archguard/filesize_test.go（Go 1500 行，testdata/filesize-baseline.txt）。
// 扫 web/src 下 .vue/.ts/.css——locales/（数据表）、*.test.ts、__tests__/ 豁免。
// 阈值：vue 1500 / ts 800 / css 800。与基线 scripts/file-size-baseline.json 对账：
//   - 超阈且不在基线 → ERROR 退出 1（新犯零容忍）；
//   - 基线条目继续增长（actual > recorded）→ ERROR（拆分欠账加深——--update-baseline
//     重写必须附拆分立项理由，不许静默放宽；手写理由更新时保留）；
//   - 基线条目已回阈下 → stale 提示（不 ERROR）。
// 用法：
//   node scripts/check-file-size.mjs                # 对账（npm run check/check:fast 接入）
//   node scripts/check-file-size.mjs --update-baseline  # 重写基线（登记=承诺拆分立项）
//   node scripts/check-file-size.mjs --self-test    # 纯函数自检红绿
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '..', 'src')
const BASELINE = path.resolve(here, 'file-size-baseline.json')
const LIMITS = { '.vue': 1500, '.ts': 800, '.css': 800 }
const DEFAULT_REASON = '存量遗留，拆分收敛另行立项'

function countLines(text) {
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'locales' || e.name === '__tests__' || e.name === 'node_modules' || e.name === 'coverage') continue
      walk(full, out)
    } else if (/\.(vue|ts|css)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

// 纯函数：单文件对账 → 'ok' | 'fresh' | 'grown' | 'stale'
function evalFile(rel, lines, baseline, limit) {
  const rec = baseline[rel]
  if (lines > limit) {
    if (!rec) return 'fresh'
    if (lines > rec.lines) return 'grown'
    return 'ok'
  }
  return rec ? 'stale' : 'ok'
}

function selfTest() {
  const cases = [
    ['ok-fresh-under', evalFile('a.vue', 100, {}, 1500), 'ok'],
    ['fresh-over-no-baseline', evalFile('a.vue', 1600, {}, 1500), 'fresh'],
    ['ok-in-baseline', evalFile('a.vue', 1600, { 'a.vue': { lines: 1700, reason: 'x' } }, 1500), 'ok'],
    ['grown-over-record', evalFile('a.vue', 1800, { 'a.vue': { lines: 1700, reason: 'x' } }, 1500), 'grown'],
    ['stale-back-under', evalFile('a.vue', 900, { 'a.vue': { lines: 1700, reason: 'x' } }, 1500), 'stale'],
    ['count-lines', countLines('a\nb\nc'), 3],
    ['count-lines-trailing', countLines('a\nb\n'), 2],
  ]
  let bad = 0
  for (const [name, got, want] of cases) {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) { console.error(`self-test FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); bad++ }
  }
  console.log(bad === 0 ? 'SELF_TEST_OK' : `SELF_TEST_FAIL ${bad}`)
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) selfTest()

const update = process.argv.includes('--update-baseline')
let baseline = {}
// 基线缺失/损坏 = 首次运行或 --update-baseline 场景：按空表起步（下一行 update 分支）
// eslint 空块豁免靠注释占位（no-empty 默认禁空 catch）
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch { /* 基线缺失=空表起步 */ }
if (update && Object.keys(baseline).length === 0) baseline = {}

const files = walk(SRC)
const fresh = []
const grown = []
const stale = []
let scanned = 0
for (const f of files) {
  const ext = path.extname(f)
  const limit = LIMITS[ext]
  if (!limit) continue
  scanned++
  const lines = countLines(fs.readFileSync(f, 'utf8'))
  const rel = path.relative(path.resolve(here, '..'), f).split(path.sep).join('/')
  const st = evalFile(rel, lines, baseline, limit)
  if (st === 'fresh') fresh.push(`${rel}: ${lines} 行（阈值 ${limit}）——拆分或经拆分立项后 --update-baseline 登记`)
  else if (st === 'grown') grown.push(`${rel}: ${lines} 行 > 基线登记 ${baseline[rel].lines} 行——更新基线须附拆分立项理由`)
  else if (st === 'stale') stale.push(`${rel}: ${lines} 行已回阈下，基线条目可清理`)
}

if (update) {
  for (const f of files) {
    const ext = path.extname(f)
    const limit = LIMITS[ext]
    if (!limit) continue
    const lines = countLines(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(path.resolve(here, '..'), f).split(path.sep).join('/')
    if (lines > limit && !baseline[rel]) baseline[rel] = { lines, reason: DEFAULT_REASON }
    else if (baseline[rel] && lines > baseline[rel].lines) baseline[rel] = { lines, reason: baseline[rel].reason }
    else if (baseline[rel] && lines <= limit && baseline[rel].reason === DEFAULT_REASON) delete baseline[rel]
  }
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + '\n', 'utf8')
  console.log(`FILE_SIZE_BASELINE_UPDATED entries=${Object.keys(baseline).length} scanned=${scanned}`)
  process.exit(0)
}

for (const s of [...fresh, ...grown]) console.error(`ERROR ${s}`)
for (const s of stale) console.log(`stale: ${s}`)
console.log(`FILE_SIZE_OK scanned=${scanned} baseline=${Object.keys(baseline).length}${fresh.length + grown.length ? '' : ' fresh=0 grown=0'}`)
process.exit(fresh.length + grown.length === 0 ? 0 : 1)
