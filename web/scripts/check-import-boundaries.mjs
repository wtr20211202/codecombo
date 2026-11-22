#!/usr/bin/env node
// check-import-boundaries.mjs —— 前端 import 分层方向禁令（2026-11-18 决议 33 用户定向「分层要合理」）
//
// 与 server/archguard（depRule 表，P-20261003-17）同源同纪律：把散落的分层禁令固化为可执行
// 门禁，且恪守「首跑全绿承诺」——规则表只收录当前合规面的禁令，现存合法耦合面刻意不设禁令
// （api→stores/http.ts 错误与锁恢复、components→views 的 DiffViewer 复用、utils→stores 的
// agentTaskNotify 桥接、stores→composables 等）；要加新禁令先修存量再入表，不得为转绿掩盖。
//
// 规则表（2026-11-18 全量 1700+ 文件对账零违规；from=文件所在层，forbid=禁止 import 的层）：
//   api         ↛ composables/components/panels/views/router
//   stores      ↛ components/panels/views
//   components  ↛ router
//   panels      ↛ router/views
//   router      ↛ api/stores/composables/components/panels
//   utils       ↛ views/panels
//   types       ↛ 一切业务层（api/stores/composables/components/panels/views/router/utils/persistence）
//   persistence ↛ api/stores/composables/components/panels/views
//
// 扫描：web/src 下 .ts/.vue（*.test.ts 与 __tests__/ 豁免）；import/export-from/动态 import；
// '@/'-别名与相对路径解析到层。违规输出 规则号+文件+目标层，退出码 1。
// 用法：node scripts/check-import-boundaries.mjs [--self-test]
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '..', 'src')

const LAYERS = ['api', 'stores', 'composables', 'components', 'panels', 'views', 'router', 'utils', 'types', 'persistence']
const RULES = [
  { id: 'IB-1', from: ['api'], forbid: ['composables', 'components', 'panels', 'views', 'router'] },
  { id: 'IB-2', from: ['stores'], forbid: ['components', 'panels', 'views'] },
  { id: 'IB-3', from: ['components'], forbid: ['router'] },
  { id: 'IB-4', from: ['panels'], forbid: ['router', 'views'] },
  { id: 'IB-5', from: ['router'], forbid: ['api', 'stores', 'composables', 'components', 'panels'] },
  { id: 'IB-6', from: ['utils'], forbid: ['views', 'panels'] },
  { id: 'IB-7', from: ['types'], forbid: ['api', 'stores', 'composables', 'components', 'panels', 'views', 'router', 'utils', 'persistence'] },
  { id: 'IB-8', from: ['persistence'], forbid: ['api', 'stores', 'composables', 'components', 'panels', 'views'] },
]

// 文件 → 所属层（不在任何受管层 → null）
function layerOf(p) {
  const rel = path.relative(SRC, p)
  const top = rel.split(path.sep)[0]
  return LAYERS.includes(top) ? top : null
}

// import 说明符 → 绝对路径（'@/' 别名与相对路径；裸包名 → null）
function resolveSpec(spec, fromFile) {
  if (spec.startsWith('@/')) return path.join(SRC, spec.slice(2))
  if (spec.startsWith('.')) return path.normalize(path.join(path.dirname(fromFile), spec))
  return null
}

// 一条 import 边是否违反规则表 → 违反的规则 id（无则 null）
function ruleHit(fromLayer, toLayer) {
  if (!fromLayer || !toLayer || fromLayer === toLayer) return null
  for (const r of RULES) {
    if (r.from.includes(fromLayer) && r.forbid.includes(toLayer)) return r.id
  }
  return null
}

const IMPORT_RE = /import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|export\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+["']([^"']+)["']/g

function selfTest() {
  const cases = [
    ['layer-api', layerOf(path.join(SRC, 'api', 'client.ts')), 'api'],
    ['layer-components', layerOf(path.join(SRC, 'components', 'a', 'B.vue')), 'components'],
    ['layer-views', layerOf(path.join(SRC, 'views', 'x', 'Y.vue')), 'views'],
    ['layer-root', layerOf(path.join(SRC, 'main.ts')), null],
    ['resolve-alias', path.relative(SRC, resolveSpec('@/stores/lock', path.join(SRC, 'api', 'x.ts'))).split(path.sep).join('/'), 'stores/lock'],
    ['resolve-relative', path.relative(SRC, resolveSpec('../stores/lock', path.join(SRC, 'api', 'x.ts'))).split(path.sep).join('/'), 'stores/lock'],
    ['resolve-bare', resolveSpec('pinia', path.join(SRC, 'api', 'x.ts')), null],
    ['hit-api-to-composables', ruleHit('api', 'composables'), 'IB-1'],
    ['hit-router-to-stores', ruleHit('router', 'stores'), 'IB-5'],
    ['allow-api-to-stores', ruleHit('api', 'stores'), null],
    ['allow-components-to-views', ruleHit('components', 'views'), null],
    ['allow-views-to-anything', ruleHit('views', 'router'), null],
    ['same-layer', ruleHit('api', 'api'), null],
  ]
  let bad = 0
  for (const [name, got, want] of cases) {
    if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`self-test FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); bad++ }
  }
  console.log(bad === 0 ? 'SELF_TEST_OK' : `SELF_TEST_FAIL ${bad}`)
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) selfTest()

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'locales' || e.name === 'coverage') continue
      walk(full, out)
    } else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

const violations = []
let scanned = 0
for (const f of walk(SRC)) {
  const from = layerOf(f)
  if (!from) continue
  scanned++
  const text = fs.readFileSync(f, 'utf8')
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1] || m[2] || m[3]
    if (!spec) continue
    const target = resolveSpec(spec, f)
    if (!target) continue
    const to = layerOf(target)
    const hit = ruleHit(from, to)
    if (hit) violations.push(`${hit} ${path.relative(SRC, f).split(path.sep).join('/')} -> ${to}（${spec}）`)
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`ERROR ${v}`)
  console.error(`IMPORT_BOUNDARY_FAIL violations=${violations.length} scanned=${scanned}`)
  process.exit(1)
}
console.log(`IMPORT_BOUNDARY_OK scanned=${scanned} rules=${RULES.length}`)
