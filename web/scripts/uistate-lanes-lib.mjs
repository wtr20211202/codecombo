#!/usr/bin/env node
// uistate-lanes-lib.mjs —— UI 状态保持登记门禁的共享提取/对账库（P-20261114-2-S2）
//
// 纯函数模块（零副作用、零退出码）：check-uistate-lanes.mjs（npm run check 门禁主体）
// 与一致性单测 src/__tests__/persistence/uiStateLanes.test.ts 共同 import 本库——
// 门禁与单测共用同一套提取/对账逻辑，杜绝两处实现漂移。
//
// 提取面（**惯例级非编译级**，check-api-routes「锚定书写惯例，形式变更须同步本脚本」
// 同款自觉——头注如实标注钉不住的形态）：
//   可钉：① 引号字符串字面量键（'sc.xxx' / `sc.<静态前缀>.${...}` 模板串按 ${ 处
//   截断为前缀形态、'sc.xxx.' + var 拼接的常量前缀段）；② uiState.ts 的
//   patchNamespaces(id, { ns: ... }) 首层命名空间键面（含 { ns } shorthand）；
//   ③ useLayoutState.ts collectCurrentUIState 返回字面量的首层键面（剔除
//   instanceId/projectId 记录标识标量）。
//   钉不住（由一致性单测 writerFn/readerFn 函数名面与 satisfies 编译期断言补位）：
//   动态构造的非字面量键、变量别名封装、agentTaskTemplates 的 GET+merge+PUT 整更新
//   特例写端（无 patchNamespaces 形态）。新增写端若采用非惯例形态，本门禁与单测
//   双双失明即为显式评审动作（MIN 下限守卫防整体失明全绿）。
//
// 扫描范围：web/src 下 .ts/.vue（.vue 整文件——template 属性绑定是真实键接线点，
// storage-key="sc.<panel>.sidebarWidth" 先例；template 表达式误命中如 sc.label 由
// 登记表 falseHits 逐条注缘由承接；.json 不扫——防注册表文件自身的基线 pattern
// 字符串自匹配虚活悬空检查）。测试面（__tests__/、*.test.ts）不入生产键面
// （sc.test.* 夹具键与 sc.rfm.mem.h1/h2 测试键同此排除）。
import fs from 'node:fs'
import path from 'node:path'

/** 登记表路径（web/src/persistence/uiStateLanes.json，前端语义登记唯一事实源） */
export function registryPath(webRoot) {
  return path.join(webRoot, 'src', 'persistence', 'uiStateLanes.json')
}

/** 合法车道枚举（与矩阵文档「车道」列逐格一致） */
export const LANES = ['collect', 'writer', 'localStorage', 'temporary', 'retired']

/** collect 面返回字面量中的记录标识标量（非状态命名空间，不入对账面） */
export const SCALAR_COLLECT_KEYS = ['instanceId', 'projectId']

/** 数量下限守卫（防提取失明空转全绿，check-errmarkers/check-api-routes MIN_* 先例）：
 *  取当前存量留余量——提取器与书写惯例脱钩（如引号形态漏提取）时在此先红 */
export const MIN_GUARDS = {
  registryRows: 65, // 登记行数（当前 71）
  legacyKeys: 42, // 存量豁免条目数（当前 47）
  uniqueLiterals: 40, // 生产面 sc.* 唯一字面量数（当前 52：exact 键 + 模板/拼接前缀形态）
  writerNamespaces: 19, // patchNamespaces 命名空间键面（当前 19）
  collectNamespaces: 3, // collect 面命名空间键面（当前 3）
}

// ---------- 键模式匹配：exact 键或尾随 * 前缀（覆盖动态拼接族） ----------
export function matchKeyPattern(pattern, literal) {
  if (pattern.endsWith('*')) return literal.startsWith(pattern.slice(0, -1))
  return pattern === literal
}

// ---------- 字符串字面量提取（注释/正则/模板插值三态感知扫描器） ----------
//
// 动机与边界：sc.* 存量键大量出现在注释与 SFC template 中（docs-follow-code 注记、
// v-for 变量），裸 grep 会让豁免清单被噪声灌爆、误命中当真键。本扫描器按 JS 词法
// 惯例跳过行/块注释；正则字面量按「前导 token = 值起始位（标点/关键字）」启发式
// 判定（minifier 同款思路，除法 / 与正则 / 的经典歧义位）；模板串 `${...}` 插值
// 区按代码处理（插值内嵌套字符串照常提取，模板静态段在 ${ 处截断——前缀形态键的
// 提取来源）。启发式对非常规书写可能误判，后果限于漏提取（MIN 下限兜底）或提取出
// 非 sc. 开头的噪声（匹配阶段天然忽略），不会把注释当键。
const REGEX_PRECEDING_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'])
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])

function isWordChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch)
}

/** 判定 src[i] 处的 / 是除法还是正则起点：回溯最近非空白字符，标点/关键字后 = 正则 */
function looksLikeRegexStart(src, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(src[j])) j--
  if (j < 0) return true
  const ch = src[j]
  if (isWordChar(ch)) {
    let k = j
    while (k >= 0 && isWordChar(src[k])) k--
    const word = src.slice(k + 1, j + 1)
    return REGEX_PRECEDING_KEYWORDS.has(word)
  }
  if (ch === ')' || ch === ']' || ch === '"' || ch === "'" || ch === '`') return false
  return REGEX_PRECEDING_PUNCT.has(ch)
}

/** 单段代码的扫描：提取以 sc. 开头的字符串字面量（含模板串静态段截断形态）。
 *  返回 [{ literal, line }]（line 为本段内 1 起行号，调用方叠加区偏移） */
export function extractScKeyLiteralsFromCode(src) {
  const out = []
  const push = (raw, line) => {
    // 前导空白剥离：模板串插值后续段（`pre ${x} sc.mid.` 形态）与前缀匹配对齐
    const literal = raw.replace(/^\s+/, '')
    if (/^sc\.[A-Za-z0-9]/.test(literal)) out.push({ literal, line })
  }
  let i = 0
  let line = 1
  // string: null | { quote, chars }；interpDepth > 0 表示处于模板串 ${...} 插值区（按代码处理）
  let string = null
  let interpDepth = 0
  const stack = [] // 模板串嵌套：进入插值时压入 { quote, chars }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') { line++; i++; continue }
    if (string) {
      if (ch === '\\' && i + 1 < src.length) { string.chars += src[i] + src[i + 1]; i += 2; continue }
      if (interpDepth === 0 && string.quote === '`' && ch === '$' && src[i + 1] === '{') {
        push(string.chars, line) // 静态段截断：前缀形态键来源
        stack.push(string)
        string = null
        interpDepth++
        i += 2
        continue
      }
      if (ch === string.quote) { push(string.chars, line); string = null; i++; continue }
      string.chars += ch
      i++
      continue
    }
    // 插值区内（代码态）：与外层代码同规则，close brace 回到模板串。
    // 恢复段必须重置 chars——弹出的是截断时压入的同一对象，残留 chars 会把
    // 截断前缀并进续段（自检夹具实证：sc.tpl. 重复 + sc.mid. 丢失）
    if (interpDepth > 0 && ch === '}') { string = { quote: stack.pop().quote, chars: '' }; interpDepth--; i++; continue }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++ }
      i += 2
      continue
    }
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      // 正则字面量：吞到未转义闭 /（跳过字符类 [..]，类内 / 不闭）；换行即假阳性回落
      i++
      let inClass = false
      let closed = false
      while (i < src.length) {
        const rc = src[i]
        if (rc === '\n') break
        if (rc === '\\') { i += 2; continue }
        if (inClass) { if (rc === ']') inClass = false }
        else if (rc === '[') inClass = true
        else if (rc === '/') { closed = true; i++; break }
        i++
      }
      if (!closed) { /* 假阳性（实为除法）：i 已移位，容忍噪声继续 */ }
      while (i < src.length && /[a-z]/i.test(src[i])) i++ // flags
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { string = { quote: ch, chars: '' }; i++; continue }
    i++
  }
  if (string) push(string.chars, line) // 末尾未闭串（畸形代码）兜底
  return out
}

export function isTestFile(relPath) {
  const norm = relPath.split('\\').join('/')
  return norm.includes('/__tests__/') || /(^|\/)[^/]+\.test\.ts$/.test(norm)
}

/** 扫描文件清单中的 sc.* 键字面量。files: [{ name, src }]（name 用逻辑正斜杠标签）。
 *  .vue 整文件扫描（script + template）：template 属性绑定是真实键接线点
 *  （storage-key="sc.<panel>.sidebarWidth" 先例），template 表达式误命中
 *  （sc.label v-for 变量类）由登记表 falseHits 逐条注缘由承接 */
export function scanScKeyLiterals(files) {
  const hits = []
  for (const { name, src } of files) {
    if (isTestFile(name) || name.endsWith('.json')) continue
    for (const hit of extractScKeyLiteralsFromCode(src)) {
      hits.push({ file: name, line: hit.line, literal: hit.literal })
    }
  }
  return hits
}

// ---------- patchNamespaces 键面提取（uiState.ts 专用读写器轨事实源） ----------

/** 从对象字面量首层读键名（含 { ns } shorthand；跳过字符串/嵌套结构/注释）。
 *  返回 null = 解析失败（非惯例形态，MIN 守卫兜底显性化） */
export function parseTopLevelObjectKeys(src, braceIdx) {
  const keys = []
  let i = braceIdx + 1
  const skipWs = () => {
    while (i < src.length) {
      const ch = src[i]
      if (/\s/.test(ch)) { i++; continue }
      if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
      if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
      break
    }
  }
  const skipValue = () => { // 跳过一个值的表达式（含嵌套 {}[]() 与字符串）
    // 值局部深度 d：'}'/']' 回落到 0 = 值的结构闭合端（消费后返回）；'(' ')'
    // 视为表达式内部（useInstanceStore().currentInstanceId 成员链不自断值）；
    // ',' 或对象自身的 '}' 在 d=0 处即值结束（不消费，回主循环判定）
    let d = 0
    while (i < src.length) {
      const ch = src[i]
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
        i++
        continue
      }
      if (ch === '{' || ch === '[' || ch === '(') { d++; i++; continue }
      if (ch === '}' || ch === ']' || ch === ')') {
        if (d === 0) return // 对象自身的收尾符（'}'）或意外形态：交回主循环
        d--
        i++
        if (d === 0 && ch !== ')') return // 值的嵌套结构闭合（'}' / ']'）
        continue
      }
      if (d === 0 && (ch === ',' || ch === '}')) return
      i++
    }
  }
  while (i < src.length) {
    skipWs()
    if (i >= src.length) return null
    const ch = src[i]
    if (ch === '}') { i++; return keys }
    if (!isWordChar(ch) && ch !== '$') return null // 非键形态（spread 等）→ 放弃解析
    let j = i
    while (j < src.length && (isWordChar(src[j]) || src[j] === '$')) j++
    const key = src.slice(i, j)
    i = j
    skipWs()
    if (src[i] === ':') {
      keys.push(key)
      i++
      skipWs()
      skipValue()
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return keys }
      return null
    }
    if (src[i] === ',' || src[i] === '}') { // shorthand
      keys.push(key)
      if (src[i] === ',') { i++; continue }
      i++
      return keys
    }
    return null
  }
  return null
}

/** 提取 patchNamespaces(id, { ns... }) 全部调用点的首层命名空间键集合 */
export function extractPatchNamespacesNamespaces(src) {
  const out = []
  const callRe = /patchNamespaces\s*\(/g
  let m
  while ((m = callRe.exec(src))) {
    let i = m.index + m[0].length
    let paren = 1
    let braceIdx = -1
    while (i < src.length && paren > 0) {
      const ch = src[i]
      if (ch === '(') paren++
      else if (ch === ')') paren--
      else if (ch === '{' && braceIdx < 0) braceIdx = i
      i++
    }
    if (braceIdx < 0) continue // 无字面量对象实参（非惯例形态），跳过
    const keys = parseTopLevelObjectKeys(src, braceIdx)
    if (keys) out.push(...keys)
  }
  return out
}

// ---------- collect 面提取（useLayoutState.ts collectCurrentUIState 事实源） ----------

/** 提取 collectCurrentUIState 返回字面量的首层键（剔除 instanceId/projectId 标量） */
export function extractCollectNamespaces(src) {
  const anchor = src.indexOf('function collectCurrentUIState')
  if (anchor < 0) return []
  const nextFn = src.indexOf('\n  function ', anchor + 10)
  const bodyEnd = nextFn < 0 ? src.length : nextFn
  const returnIdx = src.indexOf('return {', anchor)
  if (returnIdx < 0 || returnIdx > bodyEnd) return []
  const keys = parseTopLevelObjectKeys(src, returnIdx + 'return '.length)
  if (!keys) return []
  return keys.filter((k) => !SCALAR_COLLECT_KEYS.includes(k))
}

// ---------- 对账核心（门禁主体与单测共用） ----------

/** 登记表结构校验 + 三面对账。返回 { errors, stats }（errors 非空 = 门禁红） */
export function reconcile({ literals, writerFace, collectFace, registry }) {
  const errors = []
  const rows = registry.rows || []

  // ① 结构校验：id 唯一、车道合法、face 字段与车道耦合规则
  const ids = new Set()
  for (const row of rows) {
    if (!row.id || !row.item) { errors.push(`登记行缺 id/item：${JSON.stringify(row).slice(0, 120)}`); continue }
    if (ids.has(row.id)) errors.push(`登记号重复：${row.id}`)
    ids.add(row.id)
    if (!LANES.includes(row.lane)) errors.push(`登记行 ${row.id} 车道非法：${row.lane}（合法值 ${LANES.join('/')}）`)
    if (row.collectNs && row.lane !== 'collect') errors.push(`登记行 ${row.id}：collectNs 仅 collect 车道可携带`)
    if (row.writerNs && row.lane !== 'collect' && row.lane !== 'writer') errors.push(`登记行 ${row.id}：writerNs 仅 collect/writer 车道可携带`)
    if (row.keys?.length && row.lane !== 'localStorage') errors.push(`登记行 ${row.id}：keys 仅 localStorage 车道可携带（存量键走 legacyScKeys）`)
    if ((row.lane === 'temporary' || row.lane === 'retired') && (row.collectNs || row.writerNs || row.keys?.length)) {
      errors.push(`登记行 ${row.id}：temporary/retired 车道不得携带 collectNs/writerNs/keys`)
    }
    for (const f of ['refresh', 'routeTrip', 'multiTab', 'crossBrowser', 'crossMachine', 'clear']) {
      if (typeof row[f] !== 'string' || !row[f].trim()) errors.push(`登记行 ${row.id} 缺矩阵列字段：${f}`)
    }
  }

  // ② 豁免/误命中清单 → 登记行链接完整性（防悬空 id）
  const legacy = registry.legacyScKeys || []
  const falseHits = registry.falseHits || []
  for (const e of legacy) {
    if (!e.pattern || !e.reason) errors.push(`legacyScKeys 条目缺 pattern/reason：${JSON.stringify(e).slice(0, 120)}`)
    if (!ids.has(e.registryId)) errors.push(`legacyScKeys 条目 ${e.pattern} 的 registryId 未解析到登记行：${e.registryId}`)
  }
  for (const f of falseHits) {
    if (!f.pattern || !f.reason) errors.push(`falseHits 条目缺 pattern/reason：${JSON.stringify(f).slice(0, 120)}`)
  }

  // ③ 专用读写器键面 × 注册表（双向集合对账，错位即红）
  const regWriter = new Set(rows.map((r) => r.writerNs).filter(Boolean))
  for (const ns of new Set(writerFace)) {
    if (!regWriter.has(ns)) errors.push(`patchNamespaces 写端命名空间 ${ns} 未登记（uiState.ts writer 面 vs 注册表失配）——新增专用读写器须先在 uiStateLanes.json 登记一行`)
  }
  for (const ns of regWriter) {
    if (!writerFace.includes(ns)) errors.push(`注册表 writerNs ${ns} 在 uiState.ts patchNamespaces 键面无对应写端（死登记行或写端改道未同步）`)
  }

  // ④ collect 面 × 注册表（双向集合对账）
  const regCollect = new Set(rows.map((r) => r.collectNs).filter(Boolean))
  for (const ns of new Set(collectFace)) {
    if (!regCollect.has(ns)) errors.push(`collect 面命名空间 ${ns} 未登记（useLayoutState.ts collectCurrentUIState vs 注册表失配）——collect 新增命名空间须先登记`)
  }
  for (const ns of regCollect) {
    if (!collectFace.includes(ns)) errors.push(`注册表 collectNs ${ns} 在 collectCurrentUIState 面无对应收集端（死登记行或 collect 收窄未同步）`)
  }

  // ⑤ sc.* 字面量键面 × （registry keys ∪ legacyScKeys ∪ falseHits）
  const patterns = [
    ...legacy.map((e) => ({ pattern: e.pattern, kind: 'legacy', label: e.registryId })),
    ...falseHits.map((e) => ({ pattern: e.pattern, kind: 'falseHit', label: '误命中' })),
    ...rows.flatMap((r) => (r.keys || []).map((k) => ({ pattern: k, kind: 'registry', label: r.id }))),
  ]
  const matchedPatterns = new Set()
  const uniqLiterals = new Map()
  for (const l of literals) if (!uniqLiterals.has(l.literal)) uniqLiterals.set(l.literal, l)
  for (const [literal, site] of uniqLiterals) {
    const hits = patterns.filter((p) => matchKeyPattern(p.pattern, literal))
    if (hits.length === 0) {
      errors.push(`sc.* 键字面量 ${literal}（${site.file}:${site.line}）未登记也未豁免——新键须在 uiStateLanes.json rows 登记（lane=localStorage 带 keys，或对应 uiState 车道行），确属误命中入 falseHits 注缘由`)
    } else {
      for (const h of hits) matchedPatterns.add(h.pattern)
    }
  }

  // ⑥ 悬空检查：豁免/误命中/登记键面不命中任何现存字面量 → 报红强制修剪（防死账）
  for (const p of patterns) {
    if (!matchedPatterns.has(p.pattern)) {
      errors.push(`键面 pattern ${p.pattern}（${p.kind}${p.kind === 'legacy' ? ' → ' + p.label : ''}）不命中任何现存 sc.* 字面量——键面已删/改名，请修剪 uiStateLanes.json（豁免悬空报红）`)
    }
  }

  return {
    errors,
    stats: {
      rows: rows.length,
      legacy: legacy.length,
      falseHits: falseHits.length,
      uniqueLiterals: uniqLiterals.size,
      literalSites: literals.length,
      writerNamespaces: new Set(writerFace).size,
      collectNamespaces: new Set(collectFace).size,
    },
  }
}

/** 失明守卫（MIN 下限，reconcile 结构校验之外的总量面兜底） */
export function guards(stats) {
  const g = MIN_GUARDS
  const out = []
  if (stats.rows < g.registryRows) out.push(`登记行 ${stats.rows} < ${g.registryRows}——注册表残缺/读取失明`)
  if (stats.legacy < g.legacyKeys) out.push(`存量豁免条目 ${stats.legacy} < ${g.legacyKeys}——豁免清单残缺`)
  if (stats.uniqueLiterals < g.uniqueLiterals) out.push(`生产面 sc.* 唯一字面量 ${stats.uniqueLiterals} < ${g.uniqueLiterals}——扫描器与书写惯例脱钩失明，请同步本库`)
  if (stats.writerNamespaces < g.writerNamespaces) out.push(`patchNamespaces 命名空间键面 ${stats.writerNamespaces} < ${g.writerNamespaces}——提取器失明或写端大面积改道`)
  if (stats.collectNamespaces < g.collectNamespaces) out.push(`collect 面命名空间键面 ${stats.collectNamespaces} < ${g.collectNamespaces}——提取器失明或 collect 面大面积收窄`)
  return out
}

/** 递归收集 web/src 生产面文件（.ts/.vue，剔除测试面） */
export function listSourceFiles(srcRoot) {
  const out = []
  ;(function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relChild = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === '__tests__') continue
        walk(path.join(dir, e.name), relChild)
      } else if ((e.name.endsWith('.ts') || e.name.endsWith('.vue')) && !isTestFile(relChild)) {
        out.push({ name: relChild, abs: path.join(dir, e.name) })
      }
    }
  })(srcRoot, '')
  return out
}
