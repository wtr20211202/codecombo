#!/usr/bin/env node
// check-uistate-lanes.mjs —— UI 状态保持登记纪律门禁（P-20261114-2-S2）
//
// 用法：
//   node scripts/check-uistate-lanes.mjs             # 生产面三提取 × 登记表对账，失配 ERROR 退出码 1
//   node scripts/check-uistate-lanes.mjs --self-test # 夹具自检提取/匹配/对账红绿（不碰源码树）
//
// 动机：UI 状态保持三轨（① collect 收集轨 / ② saveXxx→patchNamespaces 专用读写器轨 /
// ③ localStorage sc.* 键控面轨）此前零机械对账——新界面状态随手落 localStorage、
// collect 面随手扩键、专用读写器随手改道，均无门禁可拦（「把新雷埋不进去」）。
// 本脚本把生产面三个可机械提取的事实源与代码级语义登记表
// web/src/persistence/uiStateLanes.json（与 docs/PERSISTENCE_LANES.md「UI 状态保持
// 矩阵」逐行对应，行内容源自 docs/ui-state-audit-20261114.md S1 全景审计）对账：
//
//   ① patchNamespaces 写端命名空间键面（uiState.ts）× 注册表 writerNs —— 双向集合
//     对账，错位即红（未登记写端 / 死登记行）；
//   ② collectCurrentUIState 返回字面量首层键面（useLayoutState.ts，剔除
//     instanceId/projectId 记录标识标量）× 注册表 collectNs —— 双向集合对账；
//   ③ 生产面 sc.* 字面量键（web/src 全量 .ts/.vue script 区）× （注册表 rows[].keys
//     新键登记 ∪ legacyScKeys 存量豁免 ∪ falseHits 误命中）—— 未登记未豁免即红；
//     豁免/误命中/登记键面不命中任何现存字面量 → 悬空报红强制修剪（check-api-routes
//     基线悬空 + check-doc-paths 白名单两先例同款机制，本门禁按任务书取 ERROR 档）。
//
// 提取面为**惯例级非编译级**（诚实边界，check-api-routes「锚定书写惯例，形式变更须
// 同步本脚本」同款自觉）：引号字符串字面量、patchNamespaces/collect 返回对象字面量
// 首层键可钉；动态构造键、变量别名封装、agentTaskTemplates 的 GET+merge+PUT 整更新
// 特例写端钉不住——由一致性单测（uiStateLanes.test.ts）的 writerFn/readerFn 函数名面
// 与 NESTED_UISTATE_SUBFIELDS satisfies 编译期断言补位。扫描范围 web/src 生产面
// （.vue 整文件——template 属性绑定是真实键接线点，storage-key="sc.<panel>.sidebarWidth"
// 先例；测试面 __tests__/*.test.ts 不入生产键面；.json 不扫——防注册表自身 pattern
// 字符串自匹配虚活悬空检查）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIN_GUARDS,
  extractCollectNamespaces,
  extractPatchNamespacesNamespaces,
  extractScKeyLiteralsFromCode,
  guards,
  listSourceFiles,
  matchKeyPattern,
  reconcile,
  registryPath,
  scanScKeyLiterals,
} from './uistate-lanes-lib.mjs'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UISTATE_STORE = path.join(WEB_ROOT, 'src', 'stores', 'uiState.ts')
const LAYOUT_STATE = path.join(WEB_ROOT, 'src', 'composables', 'useLayoutState.ts')

function runCheck() {
  const regPath = registryPath(WEB_ROOT)
  if (!fs.existsSync(regPath)) {
    console.error(`ERROR：登记表缺失（${regPath}）——UI 状态保持登记纪律的唯一事实源被删，恢复文件`)
    process.exit(1)
  }
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(regPath, 'utf-8'))
  } catch (e) {
    console.error(`ERROR：登记表 JSON 解析失败（${regPath}）：${e.message}`)
    process.exit(1)
  }

  const files = listSourceFiles(path.join(WEB_ROOT, 'src')).map((f) => ({
    name: f.name,
    src: fs.readFileSync(f.abs, 'utf-8'),
  }))
  const literals = scanScKeyLiterals(files)
  const writerFace = extractPatchNamespacesNamespaces(fs.readFileSync(UISTATE_STORE, 'utf-8'))
  const collectFace = extractCollectNamespaces(fs.readFileSync(LAYOUT_STATE, 'utf-8'))

  const { errors, stats } = reconcile({ literals, writerFace, collectFace, registry })
  const all = [...errors, ...guards(stats)]

  console.log(
    `UI 状态登记对账：注册表 ${stats.rows} 行（豁免 ${stats.legacy} + 误命中 ${stats.falseHits}）× 生产面 sc.* 唯一字面量 ${stats.uniqueLiterals}（${stats.literalSites} 处）× writer 面 ${stats.writerNamespaces} 命名空间 × collect 面 ${stats.collectNamespaces} 命名空间`
  )
  if (all.length) {
    console.error(`ERROR ${all.length} 条（登记纪律失配，必须修复）：`)
    for (const e of all) console.error('  ✗ ' + e)
    console.error('处置：新键先在 src/persistence/uiStateLanes.json 登记一行（含矩阵列字段）并同步 docs/PERSISTENCE_LANES.md 矩阵行；键已删则修剪豁免条目；写端/collect 面改道同步 writerNs/collectNs。判据见 CLAUDE.md 前端纪律节「UI 状态保持三轨选轨」')
    process.exit(1)
  }
  console.log('UI 状态登记对账通过')
}

// ---------- --self-test：夹具直测扫描器/解析器/对账三态（红/绿/悬空/失明守卫） ----------
function runSelfTest() {
  let failed = 0
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) { console.error(`  FAIL ${label}：期望 ${e}，实际 ${a}`); failed++ }
    else console.log(`  ok ${label}`)
  }

  console.log('--self-test uiStateLanes 提取夹具：')

  // 扫描器：字面量提取 + 注释排除 + 模板截断 + 正则启发式 + 拼接前缀
  const code = [
    "const a = 'sc.exact.key'", // 命中
    "const b = `sc.tpl.${pid}`", // 模板 → 前缀 sc.tpl.
    "const c = 'sc.concat.' + sessionId", // 拼接前缀段
    "// 'sc.in.line.comment' 注释不提", // 行注释
    "/* 'sc.in.block.comment' */ const d = 1", // 块注释
    "const e = /sc.regex.\\d+/.test(x)", // 正则字面量不提（前导 = 位 → 正则）
    "const f = x / 2 / y", // 除法不误吞
    "const g = `pre ${x} sc.mid.${y}`", // 插值后静态段 sc.mid.
    "const h = `x ${'sc.nested'}`", // 插值内嵌套字符串照提
    'const i = "sc.dq"', // 双引号
  ].join('\n')
  const hits = extractScKeyLiteralsFromCode(code).map((h) => h.literal).sort()
  eq(hits, ['sc.concat.', 'sc.dq', 'sc.exact.key', 'sc.mid.', 'sc.nested', 'sc.tpl.'], '扫描器：字面量/模板截断/插值嵌套提取，注释与正则排除')

  // .vue 整文件扫描（template 属性绑定是真实键接线点；误命中由 falseHits 承接）
  const vue = [
    '<template>',
    '  <div :key="sc.label" storage-key="sc.in.vue">{{ sc.label }}</div>',
    '</template>',
    "<script setup lang=\"ts\">",
    "const k = 'sc.in.script'",
    '</script>',
  ].join('\n')
  eq(scanScKeyLiterals([{ name: 'x.vue', src: vue }]).map((h) => h.literal).sort(), ['sc.in.script', 'sc.in.vue', 'sc.label'], 'SFC：整文件扫描（script+template 接线点，误命中如实入面由 falseHits 承接）')

  // 测试面排除
  eq([['src/__tests__/a.test.ts', "'sc.x'"], ['src/stores/b.ts', "'sc.y'"]].map(([n, s]) => scanScKeyLiterals([{ name: n, src: s }]).length), [0, 1], '测试面（__tests__/*.test.ts）不入生产键面')

  // patchNamespaces 键面：普通/shorthand/无字面量实参
  const storeSrc = [
    'async function patchNamespaces(id: string, rec: Record<string, unknown>) {}',
    'await patchNamespaces(instanceStore.currentInstanceId, { remoteConsole: { tabs } })',
    'await patchNamespaces(id, { layout: defaults.layout, fileTree })',
    'const rec = build(); patchNamespaces(id, rec)', // 无字面量 → 跳过
  ].join('\n')
  eq(extractPatchNamespacesNamespaces(storeSrc), ['remoteConsole', 'layout', 'fileTree'], 'patchNamespaces 键面（含 shorthand，无字面量实参跳过）')

  // collect 面：首层键 + 标量剔除
  const layoutSrc = [
    'function collectCurrentUIState(extra?: { a?: string }) {',
    '  const persistList = []',
    '  return {',
    '    instanceId: useInstanceStore().currentInstanceId,',
    '    projectId: projectStore.currentProjectId || undefined,',
    '    editor: { openFiles: [], activeIndex: 0, scrollPositions: {} },',
    '    layout: { sidePanelWidth: 1 },',
    '    gitPanel: { collapsedSections: [] },',
    '  }',
    '}',
  ].join('\n')
  eq(extractCollectNamespaces(layoutSrc), ['editor', 'layout', 'gitPanel'], 'collect 面首层键（instanceId/projectId 标量剔除）')

  // 对账红态：未登记字面量 / 死 writerNs / collect 面失配 / 悬空豁免 / registryId 悬空
  const registryFixture = {
    rows: [
      { id: 'r1', item: 'x', lane: 'writer', writerNs: 'goneNs', refresh: '✓', routeTrip: '✓', multiTab: '✓', crossBrowser: '✓', crossMachine: '✓', clear: 'c' },
      { id: 'r2', item: 'y', lane: 'collect', collectNs: 'collectA', refresh: '✓', routeTrip: '✓', multiTab: '✓', crossBrowser: '✓', crossMachine: '✓', clear: 'c' },
      { id: 'r3', item: 'z', lane: 'localStorage', refresh: '✓', routeTrip: '✓', multiTab: '✓', crossBrowser: '✓', crossMachine: '✓', clear: 'c' },
      { id: 'r4', item: 't', lane: 'temporary', refresh: '✗', routeTrip: '✗', multiTab: '✗', crossBrowser: '✗', crossMachine: '✗', clear: 'c', writerNs: 'bad' },
    ],
    legacyScKeys: [{ pattern: 'sc.exact.key', registryId: 'r3', reason: 'fixture' }, { pattern: 'sc.gone.*', registryId: 'missing-row', reason: 'fixture' }],
    falseHits: [{ pattern: 'sc.concat.', reason: 'fixture' }],
  }
  const lit = (l) => [{ file: 'f.ts', line: 1, literal: l }]
  let r = reconcile({
    literals: lit('sc.exact.key'),
    writerFace: ['liveNs'],
    collectFace: ['collectA'],
    registry: registryFixture,
  })
  eq(r.errors.some((x) => x.includes('goneNs')), true, '红态：registry writerNs 无写端（死登记行）')
  eq(r.errors.some((x) => x.includes('liveNs')), true, '红态：写端命名空间未登记')
  eq(r.errors.some((x) => x.includes('sc.gone.*')), true, '红态：豁免 pattern 悬空报红')
  eq(r.errors.some((x) => x.includes('bad')), true, '红态：temporary 车道携带 writerNs 结构违规')
  eq(r.errors.filter((x) => x.includes('registryId 未解析')).length, 1, '红态：registryId 未解析到登记行')
  eq(r.errors.filter((x) => x.includes('未登记也未豁免')).length, 0, '绿面：已豁免字面量不报未登记')

  // 未登记字面量红
  r = reconcile({ literals: lit('sc.unknown.new'), writerFace: [], collectFace: [], registry: { rows: registryFixture.rows.slice(0, 1), legacyScKeys: [], falseHits: [] } })
  eq(r.errors.filter((x) => x.includes('未登记也未豁免')).length, 1, '红态：未登记未豁免字面量报错')
  // registry keys 新键登记绿 + 悬空红
  const withKeys = {
    rows: [{ ...registryFixture.rows[2], keys: ['sc.new.reg.*'] }],
    legacyScKeys: [], falseHits: [],
  }
  r = reconcile({ literals: lit('sc.new.reg.abc'), writerFace: [], collectFace: [], registry: withKeys })
  eq(r.errors.filter((x) => x.includes('未登记也未豁免')).length, 0, '绿面：rows[].keys 前缀登记命中新键')
  eq(r.errors.filter((x) => x.includes('sc.gone.*')).length, 0, '绿面：本夹具无悬空条目')
  r = reconcile({ literals: [], writerFace: [], collectFace: [], registry: withKeys })
  eq(r.errors.filter((x) => x.includes('请修剪 uiStateLanes.json')).length, 1, '红态：registry keys 登记键面悬空')

  // 模式匹配语义
  eq([matchKeyPattern('sc.a', 'sc.a'), matchKeyPattern('sc.a', 'sc.ab'), matchKeyPattern('sc.a.*', 'sc.a.'), matchKeyPattern('sc.a.*', 'sc.a.b'), matchKeyPattern('sc.a.*', 'sc.ab.')], [true, false, true, true, false], 'matchKeyPattern：exact/前缀语义')

  // 失明守卫
  const g = guards({ rows: 0, legacy: 0, falseHits: 0, uniqueLiterals: 0, literalSites: 0, writerNamespaces: 0, collectNamespaces: 0 })
  eq(g.length, 5, '失明守卫：五组下限全触发')
  eq(MIN_GUARDS.collectNamespaces, 3, 'MIN_COLLECT_NS 与现存量一致')

  if (failed) {
    console.error(`--self-test ${failed} 处断言失败`)
    process.exit(1)
  }
  console.log('--self-test 全部通过')
}

if (process.argv.includes('--self-test')) runSelfTest()
else runCheck()
