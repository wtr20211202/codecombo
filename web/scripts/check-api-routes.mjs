#!/usr/bin/env node
// check-api-routes.mjs —— 前端 API client 路径对账门禁（P-20261004-77）
//
// 用法：
//   node scripts/check-api-routes.mjs             # domains 调用面 × 路由快照对账，失配 ERROR 退出码 1
//   node scripts/check-api-routes.mjs --self-test # 文本夹具自检提取/匹配/红绿/基线（不碰源码树）
//
// 动机：~300 条 gin 路由与 web/src/api/domains 手写客户端零对账——路径拼写/
// 参数形态漂移在 TS 编译期零感知，运行期表现为 404 只能靠踩。路由侧事实源是
// server/archguard/testdata/api-routes.json（Go 测试 TestAPIRouteDump 从
// RegisterRoutes 组合根的 gin Routes dump，新鲜度由该测试钉住），本脚本把
// 前端调用面与之对账——与手册路由覆盖（Go 测试）/ payload 字段快照 /
// errmarkers 对账同族，构成 API 契约防线的「路由路径」轴。
//
// 提取面（锚定仓内书写惯例，形式变更须同步本脚本；数量下限防失明全绿）：
//   web/src/api 顶层 + web/src/api/domains 全部 *.ts 的 `api.(get|post|put|
//   delete|patch)(<泛型>)?(首参字符串字面量)`——baseURL '/api'（web/src/api/
//   http.ts）的相对路径形态，单引号/双引号/反引号皆收，跨行调用（泛型 + 换行）
//   照常命中。域拆分残留的顶层调用面（lock.ts 引导期解锁链）与 domains 同守，
//   面口径=整个手写 api client 层（提案原文的 api/domains 按意图扩为 api 层
//   全域——lock 走同一 axios 实例，漂移同样是运行期 404）。WS URL 构造
//   （terminal/system/remote 的 `${proto}//${location.host}/ws/...` 返回值）
//   不经 api.* 出界，不在本对账面（传输通道，由 Go 侧手册对账另守）。实例统一
//   fetch 通道 instanceFetch 的 path 实参（instanceFetch.ts，base 可切
//   /proxy/:id/api 代理前缀）同为出界面：调用点散在组件层而非 api 层，属多实例
//   传输通道，路径事实源仍是同一张路由表。
//
// 判定规则：
//   - 前端调用路径在路由表中无同形路由 → ERROR（404 形态，提案核心动机）；
//     路径同形但方法无一匹配 → ERROR（405 形态，单列便于区分修复方向）
//   - 路由表条目无任何前端调用引用 → WARN（agent 面/传输面/管理面合法存量，
//     api-routes-baseline.json 前缀/精确注记后不再重复报告；WARN 不阻断，
//     沿 P-144/P-29 对账先例）
//   - 基线条目不命中任何现存路由 → WARN（悬空注记，提示修剪防死账）
//   - 结构性失明：快照缺失/路由数或提取数低于下限/路径不以 / 起步 → ERROR
//
// 匹配语义（段级、单段；调用侧补 baseURL '/api' 前缀后与路由段对齐）：
//   gin 字面段↔前端字面段全等；gin `:param` 段匹配前端任意单段（运行期真值：
//   插值与字面量在该位都合法——存量先例 `terminal-history/entry?at=` 用字面
//   占位段命中 :idx 路由，见 terminal_history.go DeleteTerminalHistoryEntry）；
//   gin `*wild` 段吞剩余段。唯一禁止向：前端 `${...}` 插值段命中 gin 字面段
//   ——运行期是否 404 取决于变量取值，属路由结构知识泄漏进客户端，应写全
//   字面路径（真有此形态会在对账红面上显形，属显式评审动作）。查询串（? 起，
//   ${} 内的 ? 不截断）与匹配无关，剥离后对账。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.join(WEB_ROOT, '..')
const ROUTE_SNAPSHOT = path.join(REPO_ROOT, 'server', 'archguard', 'testdata', 'api-routes.json')
const API_DIR = path.join(WEB_ROOT, 'src', 'api')
const DOMAINS_DIR = path.join(API_DIR, 'domains')
const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'api-routes-baseline.json')

// 数量下限守卫（防提取失明空转全绿，check-errmarkers MIN_* 先例）：
// MIN_ROUTES 与 Go 侧 MIN_DUMPED_ROUTES 同步留余量；MIN_CALLS 取现存量
//（400）留余量——提取器与书写惯例脱钩（如嵌套泛型漏提取）时在此先红
const MIN_ROUTES = 250
const MIN_CALLS = 350

// ---------- 提取：api 层 *.ts 的 api.* 首参路径字面量 ----------
// 形式变更须同步本函数（MIN_CALLS 下限兜底失明）。泛型参数逐字平衡跳过而非
// <[^>]*> 正则——嵌套泛型（Record<string, {…}>）内含 >，正则形态会漏掉整个
// 调用（路由被误报未消费，真 404 反而失明），首跑盘点实测吃过这个亏。
export function extractCalls(fileName, src) {
  const calls = []
  const startRe = /\bapi\.(get|post|put|delete|patch)\b/g
  let m
  while ((m = startRe.exec(src))) {
    let i = m.index + m[0].length
    // 行注释里的 api.*（注释行常引旧路径登记改动缘由）不算调用面
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    if (src.slice(lineStart, m.index).includes('//')) continue
    // 跳过空白与平衡的泛型 <...>，落到调用实参括号
    let depth = 0
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '<') { depth++; continue }
      if (ch === '>') { depth--; continue }
      if (depth === 0 && !/\s/.test(ch)) break
    }
    if (src[i] !== '(') continue // 非调用形态（如 api.getUnknown），不属提取面
    i++
    // 跳过实参括号后的空白/换行（跨行调用形态），读首个字符串字面量
    while (i < src.length && /\s/.test(src[i])) i++
    const quote = src[i]
    if (quote !== "'" && quote !== '"' && quote !== '`') continue
    let raw = ''
    i++
    for (; i < src.length; i++) {
      if (src[i] === '\\') { raw += src[i] + (src[i + 1] ?? ''); i++; continue }
      if (src[i] === quote) break
      raw += src[i]
    }
    calls.push({
      file: fileName,
      line: src.slice(0, m.index).split('\n').length,
      method: m[1].toUpperCase(),
      raw,
    })
  }
  return calls
}

// 剥离查询串（depth>0 表示处于 ${...} 内——其中的 ? 是表达式不是查询起点）
export function stripQuery(rawPath) {
  let depth = 0
  for (let i = 0; i < rawPath.length; i++) {
    const ch = rawPath[i]
    if (ch === '$' && rawPath[i + 1] === '{') { depth++; i++; continue }
    if (ch === '}' && depth > 0) { depth--; continue }
    if (ch === '?' && depth === 0) return rawPath.slice(0, i)
  }
  return rawPath
}

// 归一为段数组：`${...}` 插值段 → ':param'（与 gin 占位段同型，段名不参与匹配）
export function pathSegments(rawPath) {
  return stripQuery(rawPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes('${') ? ':param' : s))
}

// ---------- 匹配：段级、单段（gin 字面↔字面全等；gin :param 配任意单段；*wild 吞剩余） ----------
export function routeMatchesCall(routeSegs, callSegs) {
  let i = 0
  for (; i < routeSegs.length; i++) {
    const rs = routeSegs[i]
    if (rs.startsWith('*')) return true // 通配段吞剩余段（含零段）
    if (i >= callSegs.length) return false
    const rsIsParam = rs.startsWith(':')
    const csIsParam = callSegs[i] === ':param'
    if (rsIsParam) continue // gin 参数段匹配前端任意单段（运行期真值，见文件头）
    if (csIsParam || rs !== callSegs[i]) return false // 前端插值段不得命中 gin 字面段
  }
  return i === callSegs.length
}

// ---------- 对账核心（--self-test 以夹具直测同一套函数） ----------
// calls: {file, line, method, raw}；routes: [{method, path}]
// baseline: {prefixes: string[], exact: Map<"METHOD path", note>}
// 返回 { errors, warns, consumed } —— consumed 是被前端引用的路由键集
export function reconcile(calls, routes, baseline) {
  const errors = []
  const warns = []
  const consumed = new Set()

  const routeSegs = routes.map((r) => ({ ...r, segs: r.path.split('/').filter((s) => s.length > 0) }))

  // 方向①（ERROR）：前端调用必须落到同形路由（方法感知，404/405 分列）。
  // 调用面是 baseURL '/api' 的相对形态，补 'api' 首段后与路由全路径对齐。
  const byKey = new Map()
  for (const c of calls) {
    if (!c.raw.startsWith('/')) {
      errors.push(`${c.file}:${c.line} 调用路径不以 / 起步（${c.raw}）——domains 调用面是 baseURL 相对形态，非本形态属提取面结构异常`)
      continue
    }
    const segs = pathSegments(c.raw)
    const key = `${c.method} /${segs.join('/')}`
    if (byKey.has(key)) byKey.get(key).sites.push(`${c.file}:${c.line}`)
    else byKey.set(key, { method: c.method, segs: ['api', ...segs], sites: [`${c.file}:${c.line}`] })
  }
  for (const { method, segs, sites } of [...byKey.values()].sort((a, b) => a.sites[0].localeCompare(b.sites[0]))) {
    const pathHits = routeSegs.filter((r) => routeMatchesCall(r.segs, segs))
    if (pathHits.length === 0) {
      errors.push(`前端调用 ${sites.join('、')} → ${method} /api/${segs.slice(1).join('/')} 在路由表中无同形路由（运行期 404）——核对 server/api 注册面拼写/参数形态`)
    } else if (!pathHits.some((r) => r.method === method)) {
      const have = [...new Set(pathHits.map((r) => r.method))].join('/')
      errors.push(`前端调用 ${sites.join('、')} → ${method} /api/${segs.slice(1).join('/')} 路径存在但方法失配（服务端 ${have}，运行期 405）`)
    } else {
      // 消费记账只记方法一致的命中：方法失配本身已是 ERROR，失配路由不算被
      // 消费（否则方法孤儿路由在方向②静默，无 WARN 提示）
      for (const r of pathHits) {
        if (r.method === method) consumed.add(`${r.method} ${r.path}`)
      }
    }
  }

  // 方向②（WARN）：路由无前端调用面引用（agent/传输/管理面合法存量，基线注记）
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    if (consumed.has(key)) continue
    if (baseline.prefixes.some((p) => r.path.startsWith(p)) || baseline.exact.has(key)) continue
    warns.push(`路由 ${key} 无任何前端 domains 调用引用——agent/传输面入 api-routes-baseline.json 注记，或补 domains 客户端方法`)
  }

  // 基线悬空：注记不命中任何现存路由（路由已删/改名，修剪防死账）
  for (const p of baseline.prefixes) {
    if (!routes.some((r) => r.path.startsWith(p))) {
      warns.push(`基线前缀 ${p} 不命中任何现存路由——路由已删/改名，请修剪 api-routes-baseline.json`)
    }
  }
  for (const key of baseline.exact.keys()) {
    if (!routes.some((r) => `${r.method} ${r.path}` === key)) {
      warns.push(`基线条目 ${key} 不命中任何现存路由——路由已删/改名，请修剪 api-routes-baseline.json`)
    }
  }
  return { errors, warns, consumed }
}

// 基线：routePrefixes 前缀豁免（agent/传输面成族登记，缘由注明）+ routes 精确豁免
function loadBaseline() {
  const empty = { prefixes: [], exact: new Map() }
  if (!fs.existsSync(BASELINE)) return empty
  const parsed = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'))
  return {
    prefixes: Object.keys(parsed.routePrefixes ?? {}),
    exact: new Map(Object.entries(parsed.routes ?? {})),
  }
}

// ---------- 主流程 ----------
function runCheck() {
  const structural = []
  if (!fs.existsSync(ROUTE_SNAPSHOT)) {
    console.error(`ERROR：路由快照缺失（${ROUTE_SNAPSHOT}）——以 SC_UPDATE_API_ROUTES=1 go test ./server/archguard/ -run TestAPIRouteDump 生成并提交`)
    process.exit(1)
  }
  const snap = JSON.parse(fs.readFileSync(ROUTE_SNAPSHOT, 'utf-8'))
  const routes = snap.routes ?? []
  if (routes.length < MIN_ROUTES) structural.push(`路由快照条目 ${routes.length} < ${MIN_ROUTES}——快照残缺/失明，请重跑 Go 侧 TestAPIRouteDump 排查`)

  const calls = []
  for (const f of fs.readdirSync(API_DIR)) {
    if (f.endsWith('.ts')) calls.push(...extractCalls(f, fs.readFileSync(path.join(API_DIR, f), 'utf-8')))
  }
  for (const f of fs.readdirSync(DOMAINS_DIR)) {
    // 文件名标签用逻辑正斜杠（报告输出跨平台一致，非文件系统寻址）
    if (f.endsWith('.ts')) calls.push(...extractCalls(`domains/${f}`, fs.readFileSync(path.join(DOMAINS_DIR, f), 'utf-8')))
  }
  if (calls.length < MIN_CALLS) structural.push(`domains 调用面提取数 ${calls.length} < ${MIN_CALLS}——提取正则与仓内书写惯例脱钩失明，请同步本脚本`)

  const { errors, warns } = reconcile(calls, routes, loadBaseline())
  const all = [...structural, ...errors]

  console.log(`API 路由对账：路由快照 ${routes.length} 条 × domains 调用面 ${calls.length} 处`)
  if (warns.length) {
    console.log(`WARN ${warns.length} 条（不阻断，逐条处置：补 domains 客户端方法或入基线注记）：`)
    for (const w of warns) console.log('  ⚠ ' + w)
  }
  if (all.length) {
    console.error(`ERROR ${all.length} 条（前后端路径契约失配，必须修复）：`)
    for (const e of all) console.error('  ✗ ' + e)
    console.error('处置：前端拼写/参数形态向 server/api 注册面对齐；路由有意改名则同步 domains 调用面。路由侧快照刷新见 server/archguard/api_routes_test.go 头注')
    process.exit(1)
  }
  console.log('API 路由对账通过')
}

// ---------- --self-test：夹具直测提取/匹配/对账三态（红/绿/基线/段型严格） ----------
function runSelfTest() {
  const routeFixture = [
    { method: 'GET', path: '/api/projects' },
    { method: 'POST', path: '/api/projects' },
    { method: 'GET', path: '/api/projects/:id' },
    { method: 'PUT', path: '/api/projects/:id' },
    { method: 'GET', path: '/api/projects/:id/file-tree' },
    { method: 'GET', path: '/api/share/status' },
    { method: 'GET', path: '/api/health' },
    { method: 'GET', path: '/api/x/:id/*rest' },
    { method: 'GET', path: '/api/gone' },
  ]
  const domainFixture = [
    "export const projectApi = {",
    "  list: () => api.get('/projects'),",
    "  add: (data) => api.post('/projects', data),",
    "  get: (id: string) => api.get(`/projects/${id}`),",
    "  tree: (id: string, path?: string) =>",
    "    api.get<{ data: string[] }>(`/projects/${id}/file-tree`, { params: { path } }),",
    "  // api.get('/projects/dead-comment-call') 注释行不算调用面",
    "  shareStatus: () => api.get(`/share/${'status'}`),",
    "  query: (id: string, q: string) => api.get(`/projects/${id}/file-tree?q=${q}`),",
    "  wild: (a: string) => api.get(`/x/${a}/deep/more`),",
    "  typo: () => api.get('/projects/x/typo'),",
    "  wrongMethod: (id: string) => api.post(`/projects/${id}`, {}),",
    "  noSlash: () => api.get('projects'),",
    "}",
  ].join('\n')

  let failed = 0
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected)
    if (a !== e) { console.error(`  FAIL ${label}：期望 ${e}，实际 ${a}`); failed++ }
    else console.log(`  ok ${label}`)
  }

  console.log('--self-test api-routes 对账夹具：')
  const calls = extractCalls('fixture.ts', domainFixture)
  eq(calls.length, 10, '调用面提取数（泛型跨行/模板串照收，注释行排除）')
  eq(calls[2].method, 'GET', '方法归一大写')
  eq(calls[2].raw, '/projects/${id}', '模板串原文保留')

  eq(pathSegments('/projects/${id}/file-tree?q=1'), ['projects', ':param', 'file-tree'], '查询串剥离 + 插值归一')
  eq(pathSegments('/a/${q ? 1 : 2}/b'), ['a', ':param', 'b'], '${} 内 ? 不截断查询剥离')

  eq(routeMatchesCall(['api', ':id'], ['api', ':param']), true, 'gin :param 匹配前端插值段')
  eq(routeMatchesCall(['api', ':idx'], ['api', 'entry']), true, 'gin :param 匹配前端字面占位段（entry?at= 存量先例）')
  eq(routeMatchesCall(['api', 'fleet'], ['api', ':param']), false, '前端插值段不得命中 gin 字面段（知识泄漏向）')
  eq(routeMatchesCall(['api', 'x', '*rest'], ['api', 'x', 'a', 'b']), true, '通配段吞剩余段')
  eq(routeMatchesCall(['api', ':id'], ['api', ':param', 'extra']), false, '段数不等不匹配')

  // 红态全量：typo→404、插值撞字面路由→404、post /projects/:id→405、noSlash→结构 ERROR
  const baseline = { prefixes: ['/api/health'], exact: new Map([['GET /api/gone', 'fixture']]) }
  let r = reconcile(calls, routeFixture, baseline)
  eq(r.errors.length, 4, '红态：404×2 + 405 + 非 / 起步结构 ERROR')
  eq(r.errors.filter((e) => e.includes('无同形路由')).length, 2, '404 形态报「无同形路由」（typo + 插值撞字面段）')
  eq(r.errors.some((e) => e.includes('方法失配')), true, '405 形态报「方法失配」')
  eq(r.errors.some((e) => e.includes('不以 / 起步')), true, '非 baseURL 相对形态报结构 ERROR')

  // 绿态：剔除四个坏调用后零 ERROR；通配路由被消费；health/gone 基线豁免不 WARN
  const good = calls.filter((c) => c.raw !== '/projects/x/typo' && !(c.raw === '/projects/${id}' && c.method === 'POST') && c.raw !== 'projects' && !c.raw.startsWith('/share/'))
  r = reconcile(good, routeFixture, baseline)
  eq(r.errors.length, 0, '绿态：对齐调用面零 ERROR')
  eq(r.warns.filter((w) => w.startsWith('路由 GET /api/health')).length, 0, '基线前缀豁免的路由不再 WARN')
  eq(r.warns.filter((w) => w.startsWith('路由 ')).length, 2, '未消费且未豁免的路由逐条 WARN（PUT /api/projects/:id + GET /api/share/status）')

  // 基线悬空：路由表删掉 /api/gone 后，精确基线条目必须报悬空
  r = reconcile(good, routeFixture.filter((rt) => rt.path !== '/api/gone'), { prefixes: [], exact: new Map([['GET /api/gone', 'x']]) })
  eq(r.warns.filter((w) => w.includes('基线条目 GET /api/gone')).length, 1, '精确基线条目悬空报 WARN')

  if (failed) {
    console.error(`--self-test ${failed} 处断言失败`)
    process.exit(1)
  }
  console.log('--self-test 全部通过')
}

if (process.argv.includes('--self-test')) runSelfTest()
else runCheck()
