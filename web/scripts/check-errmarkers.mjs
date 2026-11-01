#!/usr/bin/env node
// check-errmarkers.mjs —— 对外稳定错误标记跨端同步守卫（P-20261004-29）
//
// 用法：
//   node scripts/check-errmarkers.mjs             # 注册表 × 前端正则表双向对账，失配 ERROR 退出码 1
//   node scripts/check-errmarkers.mjs --self-test # 文本夹具自检解析与红/绿/基线过滤（不碰源码树）
//
// 动机：服务端稳定错误标记 → 前端 KNOWN_ERROR_I18N（src/api/http.ts）/
// remoteErrors（src/utils/remoteErrors.ts）正则的映射链此前纯靠注释纪律——
// Go 侧重排文案即前端静默失配（用户看到英文原文，staleIndexLock 一键修复条
// 等联动功能整条静默死掉）。服务端标记现在集中登记在 server/errmarkers/
//（Registry：{Symbol, Text, LocaleKey, Kind, Note}，与结构化错误码体系
// shared/errors.go 分工并存不合并），本脚本把两端契约固化为可执行对账。
//
// 提取面（锚定仓内书写惯例，形式变更须同步本脚本正则；数量下限防失明全绿）：
//   Go   = server/errmarkers/errmarkers.go 的 const 块（`Name = "文本"` 单行）
//          + Registry 行（单行 `{Symbol: "...", Text: <常量名|"字面量">,
//          LocaleKey: "...", Kind: KindEmitted|KindExternal, ...}`）
//   前端 = http.ts 的 KNOWN_ERROR_I18N 表（`[/正则/flags, '键', ...]` 单行，
//          表项可引用同文件 `const X = /正则/` 标识符）+ remoteErrors.ts 的
//          rules 表（`[/正则/flags, '键'],` 单行）
//
// 判定规则：
//   - Go 有 marker、前端两表无任何正则匹配其文本 → ERROR（用户将看到英文原文，
//     联动功能静默失效；新增 marker 忘配正则当轮 check 即红）
//   - 前端正则不匹配任何已声明 marker 文本 → WARN（可能引用了未登记/已改名的
//     文本，或通用兜底条目）；基线内条目（errmarkers-baseline.json，存量注记）
//     不重复报告，基线外新增才列出——WARN 不阻断（沿 P-144 audit 对账先例），
//     但新增条目应当在 Go 侧登记 marker 或入基线注记
//   - marker 的 LocaleKey 在 zh-CN / en-US 任一 locale 缺失 → ERROR（键拼错 =
//     静默回退原文）；两表对该 marker 的映射键若与 LocaleKey 不一致 → WARN
//    （跨表语境差异合法，如 remoteErrors 对 "not found" 映射主机语境键）
//   - KindEmitted 的 Symbol 在 server/ 无任何引用（errmarkers.X 或别名行）→
//     WARN（「服务端发射」的声明未被接线，契约无事实源）
//
// fmt 模板约定：Registry Text 含 %s/%d/%v 占位符的，本脚本实例化
//（%s→xx、%d→1、%v→err）后再对前端正则测试——与 server/errmarkers 包内
// 占位符白名单测试一致，出现其他动词先补两侧约定。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.join(WEB_ROOT, '..')
const GO_REGISTRY = path.join(REPO_ROOT, 'server', 'errmarkers', 'errmarkers.go')
const HTTP_TS = path.join(WEB_ROOT, 'src', 'api', 'http.ts')
const REMOTE_ERRORS_TS = path.join(WEB_ROOT, 'src', 'utils', 'remoteErrors.ts')
const LOCALES = {
  'zh-CN': path.join(WEB_ROOT, 'src', 'locales', 'zh-CN.ts'),
  'en-US': path.join(WEB_ROOT, 'src', 'locales', 'en-US.ts'),
}
const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'errmarkers-baseline.json')

// 数量下限守卫（防提取正则失明空转全绿，沿 check-i18n AUDIT_MIN_ACTIONS 先例）：
// 下限取现存量留余量，常规新增不必动它
const MIN_MARKERS = 25
const MIN_FRONTEND_RULES = 40

// fmt 模板占位符实例化（与 errmarkers_test.go 白名单一致）
function instantiateTemplate(text) {
  return text.replace(/%([sdv])/g, (_, verb) => (verb === 'd' ? '1' : verb === 'v' ? 'err' : 'xx'))
}

// ---------- Go 侧：解析 server/errmarkers/errmarkers.go ----------
// 只认仓内书写惯例：const 块内 `Name = "文本"` 单行 + Registry 单行结构体字面量。
// 形式变更须同步本正则（MIN_MARKERS 下限兜底失明）
function parseGoRegistry(goSource) {
  const consts = new Map() // 常量名 → 文本
  let inConstBlock = false
  for (const raw of goSource.split('\n')) {
    const line = raw.trim()
    if (line === 'const (') { inConstBlock = true; continue }
    if (inConstBlock && line === ')') { inConstBlock = false; continue }
    if (inConstBlock) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+=\s+"((?:[^"\\]|\\.)*)"/)
      if (m) consts.set(m[1], m[2])
    }
  }
  const markers = []
  const rowRe = /^\{Symbol:\s*"([^"]+)",\s*Text:\s*(?:([A-Za-z][A-Za-z0-9_]*)|"((?:[^"\\]|\\.)*)"),\s*LocaleKey:\s*"([^"]+)",\s*Kind:\s*Kind(Emitted|External),\s*Note:\s*"((?:[^"\\]|\\.)*)"\}/
  let inRegistry = false
  for (const raw of goSource.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('var Registry')) { inRegistry = true; continue }
    if (!inRegistry) continue
    if (line === '}') break
    const m = line.match(rowRe)
    if (!m) continue
    const [, symbol, constName, literal, localeKey, kind, note] = m
    const text = constName ? consts.get(constName) : literal
    if (constName && text === undefined) {
      markers.push({ symbol, text: null, constName, localeKey, kind, note })
      continue // 解析阶段不报错——常量悬空由 runCheck 按结构错误处理
    }
    markers.push({ symbol, text, constName: constName ?? null, localeKey, kind, note })
  }
  return { consts, markers }
}

// server/ 全树引用盘点：KindEmitted 的 Symbol 至少被一处 errmarkers.X 引用
// （origin 包别名行 `const X = errmarkers.Y` 也算接线）。只在真实扫描时调用
function scanServerReferences() {
  const refs = new Map() // Symbol → 首个引用点
  const dir = path.join(REPO_ROOT, 'server')
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.go') || p === GO_REGISTRY) continue
      const rel = path.relative(REPO_ROOT, p).split(path.sep).join('/')
      const src = fs.readFileSync(p, 'utf-8')
      for (const m of src.matchAll(/errmarkers\.([A-Za-z][A-Za-z0-9_]*)/g)) {
        if (!refs.has(m[1])) refs.set(m[1], rel)
      }
    }
  }
  walk(dir)
  return refs
}

// ---------- 前端侧：解析两表 + 同文件正则常量 ----------
// JS 正则字面量提取：从首个 `/` 扫到未转义的收尾 `/`（字符类 [.] 内的 `/` 不收尾）
function extractJsRegexLiteral(line, from) {
  const start = line.indexOf('/', from)
  if (start < 0) return null
  let inClass = false
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') { i++; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      const source = line.slice(start + 1, i)
      const flagsM = line.slice(i + 1).match(/^[a-z]*/)
      return { source, flags: flagsM ? flagsM[0] : '', end: i + 1 + (flagsM ? flagsM[0].length : 0) }
    }
  }
  return null
}

// http.ts / remoteErrors.ts 模块级 `const NAME = /正则/flags;`（含 export 前缀）
function extractNamedRegexes(src) {
  const named = new Map()
  for (const raw of src.split('\n')) {
    const m = raw.match(/^(?:export )?const ([A-Z][A-Za-z0-9_]*)\s*=\s*/)
    if (!m) continue
    const lit = extractJsRegexLiteral(raw, m[0].length)
    if (lit && lit.end !== null) named.set(m[1], lit)
  }
  return named
}

// 表行提取：`[/正则/flags, '键'...]` / `[NAME, '键'...]` 单行（注释行跳过）
function extractTableRows(src) {
  const named = extractNamedRegexes(src)
  const rows = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('[')) continue
    const lit = extractJsRegexLiteral(line, 1)
    let regexLit
    let rest
    if (lit) {
      regexLit = { ...lit }
      rest = line.slice(lit.end)
    } else {
      const nameM = line.match(/^\[([A-Z][A-Za-z0-9_]*)\s*,/)
      if (!nameM) continue
      const named0 = named.get(nameM[1])
      if (!named0) continue
      regexLit = { ...named0 }
      rest = line.slice(nameM[0].length)
    }
    // 行内第一个带引号 token 即映射键（两形态都在正则/标识符之后）
    const keyM = rest.match(/'([^']+)'/)
    if (!keyM) continue
    rows.push({ source: regexLit.source, flags: regexLit.flags, key: keyM[1], raw: line })
  }
  return { rows, named }
}

// ---------- locale 点分叶子键（沿 check-i18n parseLocaleText 同语义简化实现） ----------
function parseLocaleLeafKeys(text) {
  const keys = new Set()
  const stack = []
  let started = false
  for (const raw of text.split('\n')) {
    if (!started) {
      if (raw.trim() === 'export default {') started = true
      continue
    }
    const line = raw.replace(/\r$/, '').trim().replace(/\['([^']+)'\]\s*:/, "'$1':")
    if (!line || line.startsWith('//')) continue
    const level = Math.floor((raw.length - raw.trimStart().length) / 2)
    while (stack.length > level - 1 && stack.length > 0) stack.pop()
    const m = line.match(/^(?:'([^']+)'|([A-Za-z0-9_$-]+))\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1] ?? m[2]
    const rest = m[3].trim()
    if (rest === '{' || rest === '{,') { stack[level - 1] = key; continue }
    if (rest.startsWith("'") || rest.startsWith('"')) keys.add([...stack, key].join('.'))
  }
  return keys
}

// ---------- 对账核心（--self-test 以夹具直测同一套函数） ----------
// errors: marker 无前端正则 / LocaleKey 缺失（阻断）
// warns:  前端正则无 marker / 映射键不一致 / Emitted 未接线 / 正则表基线外孤儿（报告）
function reconcile(markers, tables, locales, serverRefs, baselineKeys) {
  const errors = []
  const warns = []
  const allRules = tables.flatMap((t) => t.rows.map((r) => ({ ...r, table: t.name })))

  // 方向①（ERROR）：Go marker 必须有前端正则匹配其文本（模板实例化后）
  for (const m of markers) {
    if (m.text === null) {
      errors.push(`marker ${m.symbol} 的 Text 常量 ${m.constName} 未在 const 块找到——Registry 行引用悬空`)
      continue
    }
    const probe = instantiateTemplate(m.text)
    const hits = allRules.filter((r) => safeTest(r, probe))
    if (hits.length === 0) {
      errors.push(`Go marker「${m.symbol}」(${probe}) 无任何前端正则匹配——用户将看到英文原文，请补 KNOWN_ERROR_I18N/remoteErrors 条目（LocaleKey: ${m.localeKey}）`)
    } else if (!locales['zh-CN'].has(m.localeKey) || !locales['en-US'].has(m.localeKey)) {
      const missing = Object.entries(locales).filter(([, k]) => !k.has(m.localeKey)).map(([l]) => l)
      errors.push(`marker「${m.symbol}」LocaleKey "${m.localeKey}" 在 ${missing.join('/')} locale 缺失——键拼错即静默回退原文`)
    } else if (!hits.some((h) => h.key === m.localeKey)) {
      warns.push(`marker「${m.symbol}」的映射键与 LocaleKey 不一致：注册表声明 ${m.localeKey}，实际命中 ${[...new Set(hits.map((h) => `${h.table}:${h.key}`))].join('、')}（跨表语境差异可接受，请确认）`)
    }
    if (m.kind === 'Emitted' && serverRefs && !serverRefs.has(m.symbol)) {
      warns.push(`KindEmitted marker「${m.symbol}」在 server/ 无任何 errmarkers.${m.symbol} 引用——「服务端发射」未接线，契约无事实源`)
    }
  }

  // 方向②（WARN）：前端正则必须匹配至少一个已声明 marker 文本（基线过滤存量注记）
  for (const r of allRules) {
    const matched = markers.some((m) => m.text !== null && safeTest(r, instantiateTemplate(m.text)))
    if (!matched) {
      const baseKey = `${r.table}|${r.source}`
      if (baselineKeys.has(baseKey)) continue
      warns.push(`前端正则 /${r.source}/${r.flags}（${r.table} → ${r.key}）不匹配任何已声明 marker——请在 server/errmarkers 登记，或入 errmarkers-baseline.json 注记`)
    }
  }
  return { errors, warns }
}

function safeTest(rule, text) {
  try {
    return new RegExp(rule.source, rule.flags).test(text)
  } catch {
    return false // 非法正则按不匹配处理，由提取方报结构问题（此处宽松防脚本崩）
  }
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return new Map()
  const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'))
  return new Map(Object.entries(parsed.entries ?? {}))
}

// ---------- 主流程 ----------
function runCheck() {
  const goSource = fs.readFileSync(GO_REGISTRY, 'utf-8')
  const { markers } = parseGoRegistry(goSource)
  const tables = [
    { name: 'http.ts', ...extractTableRows(fs.readFileSync(HTTP_TS, 'utf-8')) },
    { name: 'remoteErrors.ts', ...extractTableRows(fs.readFileSync(REMOTE_ERRORS_TS, 'utf-8')) },
  ]
  const locales = Object.fromEntries(
    Object.entries(LOCALES).map(([l, f]) => [l, parseLocaleLeafKeys(fs.readFileSync(f, 'utf-8'))]),
  )
  const serverRefs = scanServerReferences()
  const baselineKeys = new Set(loadBaseline().keys())

  const structural = []
  if (markers.length < MIN_MARKERS) structural.push(`Go marker 提取数 ${markers.length} < ${MIN_MARKERS}——errmarkers.go 形式变更致提取失明，请同步本脚本正则`)
  const ruleCount = tables.reduce((n, t) => n + t.rows.length, 0)
  if (ruleCount < MIN_FRONTEND_RULES) structural.push(`前端正则提取数 ${ruleCount} < ${MIN_FRONTEND_RULES}——两表形式变更致提取失明，请同步本脚本正则`)

  const { errors, warns } = reconcile(markers, tables, locales, serverRefs, baselineKeys)
  const all = [...structural, ...errors]

  console.log(`errmarkers 对账：Go marker ${markers.length} 条 × 前端正则 ${ruleCount} 条（http.ts ${tables[0].rows.length} + remoteErrors ${tables[1].rows.length}），基线注记 ${baselineKeys.size} 条`)
  if (warns.length) {
    console.log(`WARN ${warns.length} 条（不阻断，逐条处置：登记 marker 或入基线注记）：`)
    for (const w of warns) console.log('  ⚠ ' + w)
  }
  if (all.length) {
    console.error(`ERROR ${all.length} 条（跨端契约失配，必须修复）：`)
    for (const e of all) console.error('  ✗ ' + e)
    console.error('处置：改 Text/加正则必须两侧同步（server/errmarkers/errmarkers.go × web/src/api/http.ts | web/src/utils/remoteErrors.ts）；LocaleKey 缺失补两 locale 词条')
    process.exit(1)
  }
  console.log('errmarkers 对账通过')
}

// ---------- --self-test：文本夹具直测同一套解析与对账核心（红/绿/基线三态） ----------
function runSelfTest() {
  const goFixture = [
    'package errmarkers',
    'const (',
    '\tIndexLockStale = "stale git index lock detected"',
    '\tHostKeyChanged        = "host key has changed"',
    '\tPrecheckTemplate      = "runtime %s is not installed or not in the service process PATH"',
    ')',
    'var Registry = []Marker{',
    '\t{Symbol: "IndexLockStale", Text: IndexLockStale, LocaleKey: "errors.known.staleIndexLock", Kind: KindEmitted, Note: "x"},',
    '\t{Symbol: "HostKeyChanged", Text: HostKeyChanged, LocaleKey: "errors.known.hostKeyChanged", Kind: KindEmitted, Note: "x"},',
    '\t{Symbol: "PrecheckTemplate", Text: PrecheckTemplate, LocaleKey: "agent.runtime.errorMissing", Kind: KindEmitted, Note: "x"},',
    '\t{Symbol: "ConnRefused", Text: "connection refused", LocaleKey: "errors.known.connRefused", Kind: KindExternal, Note: "x"},',
    '\t{Symbol: "Orphan", Text: "marker nobody maps", LocaleKey: "errors.known.someKey", Kind: KindEmitted, Note: "x"},',
    '\t{Symbol: "Dangling", Text: MissingConst, LocaleKey: "errors.known.missing", Kind: KindEmitted, Note: "x"},',
    '}',
  ].join('\n')
  const httpFixture = [
    "const INDEX_LOCK_STALE_RE = /stale git index lock detected/i",
    'const KNOWN_ERROR_I18N = [',
    "  [/host key has changed/i, 'errors.known.hostKeyChanged'],",
    "  [INDEX_LOCK_STALE_RE, 'errors.known.staleIndexLock'],",
    "  [/runtime (\\S+) is not installed or not in the service process path/i, 'agent.runtime.errorMissing', m => ({ name: m[1] })],",
    "  [/connection refused/i, 'errors.known.connRefused'],",
    "  [/legacy dead regex no marker/i, 'errors.known.legacy'],",
    ']',
  ].join('\n')
  const remoteFixture = [
    'const rules: Array<[RegExp, string]> = [',
    "  [/connection refused/i, 'errors.known.connRefused'],",
    ']',
  ].join('\n')
  const localeFixture = (hostKeyChanged) => `export default {
  errors: {
    known: {
      staleIndexLock: '锁',
      connRefused: '拒',
      legacy: '旧',
      hostKeyChanged: '${hostKeyChanged}',
    },
  },
  agent: {
    runtime: {
      errorMissing: '缺',
    },
  },
}
`
  let failed = 0
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected)
    if (a !== e) { console.error(`  FAIL ${label}：期望 ${e}，实际 ${a}`); failed++ }
    else console.log(`  ok ${label}`)
  }

  console.log('--self-test errmarkers 对账夹具：')
  const { markers } = parseGoRegistry(goFixture)
  eq(markers.length, 6, 'Registry 行提取数（5 结构合法 + 1 悬空常量）')
  eq(markers[2].text, 'runtime %s is not installed or not in the service process PATH', 'Text 常量解析到模板原文')
  eq(markers[5].text, null, '悬空常量引用记为 text=null')
  eq(instantiateTemplate('runtime %s failed: %d/%v'), 'runtime xx failed: 1/err', '占位符实例化')

  const tables = [
    { name: 'http.ts', ...extractTableRows(httpFixture) },
    { name: 'remoteErrors.ts', ...extractTableRows(remoteFixture) },
  ]
  eq(tables[0].rows.length, 5, 'http 夹具行提取数（含标识符引用行）')
  eq(tables[0].rows[1].source, 'stale git index lock detected', '标识符正则解析（INDEX_LOCK_STALE_RE）')

  const locales = { 'zh-CN': parseLocaleLeafKeys(localeFixture('变')), 'en-US': parseLocaleLeafKeys(localeFixture('changed')) }

  // 绿：全对齐场景（Orphan/Dangling 两行夹具为红态用例，此处先剔除；
  // Emitted 引用盘点全接线，未接线 WARN 不掺入）
  const green = markers.filter((m) => m.symbol !== 'Orphan' && m.symbol !== 'Dangling')
  const wiredRefs = new Map(green.filter((m) => m.kind === 'Emitted').map((m) => [m.symbol, 'x']))
  let r = reconcile(green, tables, locales, wiredRefs, new Set())
  eq(r.errors.length, 0, '对齐场景零 ERROR')
  eq(r.warns.filter((w) => w.includes('不匹配任何已声明 marker')).length, 1, '基线外孤儿正则报 WARN')

  // 红①：marker 无正则（只留 remoteErrors 表，http 独占的三个 marker 失配）
  r = reconcile(green, [{ ...tables[1] }], locales, wiredRefs, new Set())
  eq(r.errors.length, 3, '仅 remoteErrors 表时三个 http 独占 marker 失配报 ERROR')

  // 红②：模板实例化匹配（%s→xx 后 runtime 正则必须命中）
  r = reconcile([markers[2]], tables, locales, new Map([['PrecheckTemplate', 'x']]), new Set())
  eq(r.errors.length, 0, '模板 marker 经实例化被正则命中')

  // 红③：LocaleKey 缺失（en-US 侧删词条）
  const localesMissing = { 'zh-CN': locales['zh-CN'], 'en-US': parseLocaleLeafKeys(localeFixture('changed').replace("      staleIndexLock: '锁',\n", '')) }
  r = reconcile(green, tables, localesMissing, wiredRefs, new Set())
  eq(r.errors.filter((e) => e.includes('en-US locale 缺失')).length, 1, 'LocaleKey 单侧缺失报 ERROR')

  // 红④：悬空常量引用报结构 ERROR
  r = reconcile(markers.filter((m) => m.symbol === 'Dangling'), tables, locales, new Map(), new Set())
  eq(r.errors.length, 1, 'Registry 行引用悬空常量报 ERROR')

  // 基线过滤：孤儿正则入基线后不再 WARN
  r = reconcile(green, tables, locales, wiredRefs, new Set(['http.ts|legacy dead regex no marker']))
  eq(r.warns.length, 0, '基线内孤儿正则不再报告')

  // Emitted 未接线 WARN
  r = reconcile(green, tables, locales, new Map(), new Set())
  eq(r.warns.filter((w) => w.includes('未接线')).length, 3, 'Emitted 无 server 引用逐条报 WARN')

  if (failed) {
    console.error(`--self-test ${failed} 处断言失败`)
    process.exit(1)
  }
  console.log('--self-test 全部通过')
}

if (process.argv.includes('--self-test')) runSelfTest()
else runCheck()
