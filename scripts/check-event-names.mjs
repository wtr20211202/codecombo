#!/usr/bin/env node
/**
 * check-event-names.mjs —— ops 事件名广播面↔消费面双向对账门禁（P-20261004-78，契约四轴收官）
 *
 * 用法：
 *   node scripts/check-event-names.mjs               # 对账门禁：ERROR 退出码 1（npm run check 挂载形态）
 *   node scripts/check-event-names.mjs --report      # 同输出但恒退出码 0（本地盘点/查看）
 *   node scripts/check-event-names.mjs --root <dir>  # 对指定仓库根对账（构造红绿样本自测用，同 check-keybindings --src 惯例）
 *
 * 动机：opschannel 事件契约此前零「广播↔消费」对账——服务端广播与前端消费面
 * （opsEvents 常量 + 直通订阅 + 各 addEventListener）双向漂移无门禁：
 *   「广播了没人听」= 功能静默死（服务端在册 type 映射的 window 事件没人订阅）
 *   「听了没人广播」= 永不触发的死订阅（前端订阅的事件名永远不会有派发源）
 *
 * 广播面取数（复用 P-46 快照免二次解析 Go——server/archguard/ops_events_test.go
 * 已在 CI 守住快照 ↔ opschannel 常量集/BroadcastEvent 调用点/手册锚五面一致，
 * 本脚本直接信任该常量集）：
 *   1. server/archguard/testdata/ops-events.json → 服务端在册 type 全集
 *   2. web/src/composables/useOpsChannel.ts → 显式 case 'type': dispatch(CONST) 映射；
 *      其余 type 走直通规则，window 事件名 = `sc-ops:<type>`
 *   3. web/src 生产代码 new CustomEvent(...)/new Event(...) 首参 = 前端内部事件派发点。
 *      useOpsChannel.ts 自身是 WS→window 桥不是事件源，派发扫描排除它——否则服务端
 *      停播某 type 后桥代码仍在，「听了没人广播」会对账成假阴性
 * 消费面取数：
 *   4. web/src 生产代码 addEventListener 首参（opsEvents 常量名或 'sc-ops:'/'sc:' 字面量）。
 *      生产代码 = 排除 __tests__ / *.test.ts / *.spec.ts / *.d.ts（测试监听不证明真实消费，
 *      测试派发也不算广播源——两侧同口径防测试文件掩护漂移）
 *
 * 判定（ERROR 拦门禁 / WARN 只提示）：
 *   ① 快照 type 映射的 window 事件名无任何生产监听点 → ERROR。
 *      SILENT_SERVER_EVENTS 白名单逐条登记缘由豁免（存量 task.relaySkipped /
 *      system:rate-limited 系 agent 面向的有意设计，缘由引 events.go 注记）
 *   ② 被监听的 sc:* 事件名无任何广播源（服务端映射 ∪ 前端派发）→ ERROR 死订阅无豁免。
 *      外部 agent 自定义 type 一旦出现前端消费方即红——按 events.go 开放词表约定，
 *      出现消费方即升级正式事件补常量 + 快照登记
 *   ③ 前端派发的 sc:* 事件名无生产监听点 → ERROR（SILENT_FRONT_EVENTS 同池豁免）。
 *      派发点就在仓内，死派发没有「外部广播者」辩护理由
 *   ④ opsEvents 常量既无监听点亦无广播源 → WARN 死常量清理提示，不拦
 *
 * 提取正则锚定仓内注册惯例（addEventListener/CustomEvent 的常量名或引号字面量实参、
 * CustomEvent<T>( 泛形、跨行实参）；常量/快照/监听名/派发名四组最低数量失明守卫——
 * 注册方式重构时须同步本脚本正则，失明显式失败优于静默漏报（同 check-keybindings 惯例）。
 *
 * 与近邻分工：scripts/ops-events-catalog.cjs（P-75）守代码↔docs/OPS_EVENTS.md 目录登记；
 * Go archguard ops_events_test（P-46）守快照↔常量/裸串/广播点；本脚本守广播面↔消费面
 * 的代码↔代码双向核对——三面合围收口事件契约。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
let ROOT = path.resolve(SCRIPT_DIR, '..')
{
  const i = process.argv.indexOf('--root')
  if (i > 0 && process.argv[i + 1]) ROOT = path.resolve(process.argv[i + 1])
}
const REPORT_ONLY = process.argv.includes('--report')

const errors = []
const warnings = []
const notes = [] // 白名单豁免注记（可见性）

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/')
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/** 去 // 与块注释（字符串字面量内不动；正则字面量里的 /* 属已知边界——过度剥离
 *  只会丢监听点，失明守卫兜底）。注释字符替换为空格且保留换行：行号与原文对齐。
 *  必须先于扫描：注释掉的订阅/派发不算现场——否则注释掉的监听点让
 *  「听了没人广播」对账假阴性（红绿自证实测踩中） */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = '' // 当前所处字符串字面量的引号；非空 = 字符串内逐字透传
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
      if (c === quote) quote = ''
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function scanFatal(msg) {
  console.error(`scan error: ${msg}`)
  process.exit(2)
}

/** 锚点断言：提取正则必须命中——扫描面漂移导致的失明在此显式暴露而非静默漏报 */
function need(cond, what) {
  if (!cond) scanFatal(`锚点未命中：${what}——扫描面已漂移，请同步更新本脚本提取正则`)
}

// —— 豁免白名单（逐条登记缘由，同 manual_routes / legacyEventNames 治理惯例）——

// 服务端在册但前端刻意无消费方的 type（agent 面向 / 系统回告）——判定①豁免
const SILENT_SERVER_EVENTS = new Map([
  ['task.relaySkipped', 'agent 监控脚本/运维面板消费，前端暂无消费者（events.go EventTaskRelaySkipped 注记，有意设计）'],
  ['system:rate-limited', '限流回告仅服务端与 agent 关心，前端无消费者不受扰（events.go EventRateLimited 注记）'],
])
// 前端派发但刻意无监听点的占位事件——判定③豁免（当前为空，新增须在此登记缘由）
const SILENT_FRONT_EVENTS = new Map([])

// —— 1. 服务端快照（P-46 事件 schema 冻结，五面已由 Go archguard 对账）——

const snapshotPath = path.join(ROOT, 'server', 'archguard', 'testdata', 'ops-events.json')
let snapshot
try {
  snapshot = JSON.parse(readText(snapshotPath))
} catch (e) {
  scanFatal(`读取 ${rel(snapshotPath)} 失败：${e.message}`)
}
if (!snapshot || typeof snapshot !== 'object') scanFatal('ops-events.json 结构异常（期望 { type: {source,...} } 表）')
const serverTypes = Object.keys(snapshot)
need(serverTypes.length >= 21, `服务端快照 type 集（实提 ${serverTypes.length}，基线 21）`)

// —— 2. opsEvents 常量族（window 事件名）——

const eventsTs = stripComments(readText(path.join(ROOT, 'web', 'src', 'utils', 'opsEvents.ts')))
const constByName = new Map() // 常量名 → window 事件名
for (const m of eventsTs.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([^']+)'/g)) {
  if (constByName.has(m[1])) scanFatal(`opsEvents.ts 常量 ${m[1]} 重复定义`)
  constByName.set(m[1], m[2])
}
need(constByName.size >= 24, `opsEvents.ts 常量族（实提 ${constByName.size}，基线 24）`)
// 同值双名让两处监听/派发形态看似两事件——对账以事件名为键不致错判，但提示收敛
const byValue = new Map()
for (const [name, value] of constByName) {
  if (!byValue.has(value)) byValue.set(value, [])
  byValue.get(value).push(name)
}
for (const [value, names] of byValue) {
  if (names.length > 1) warnings.push(`同值双名常量：${names.join(' / ')} = '${value}'——建议收敛单常量`)
}

// —— 3. useOpsChannel：显式 case 映射 + 直通锚 ——

const channelPath = path.join(ROOT, 'web', 'src', 'composables', 'useOpsChannel.ts')
const channelTs = stripComments(readText(channelPath))
const explicitByType = new Map() // 显式分发型 type → window 事件名
for (const m of channelTs.matchAll(/case '([^']+)':\s*dispatch\(\s*([A-Z][A-Z0-9_]*)/g)) {
  if (m[1] === 'hello') continue
  const value = constByName.get(m[2])
  if (value === undefined) scanFatal(`useOpsChannel.ts case '${m[1]}' 引用未知 opsEvents 常量 ${m[2]}——常量表改名时同步调用点`)
  explicitByType.set(m[1], value)
}
need(explicitByType.size >= 6, `useOpsChannel 显式分发 case（实提 ${explicitByType.size}，基线 6）`)
need(channelTs.includes('`sc-ops:${ev.type}`'), '直通分发默认分支 dispatch(`sc-ops:${ev.type}`)——映射规则的前提')
for (const t of explicitByType.keys()) {
  if (!serverTypes.includes(t)) warnings.push(`显式分发 case「${t}」不在服务端快照——开放词表 type 走显式映射须先补登记（常量+快照）`)
}

// 服务端在册 type → window 事件名（显式 case 优先，其余直通 sc-ops:<type>）
const windowByType = new Map()
const serverBackedNames = new Set() // 有服务端广播源的 window 事件名
for (const t of serverTypes) {
  const w = explicitByType.get(t) ?? `sc-ops:${t}`
  windowByType.set(t, w)
  serverBackedNames.add(w)
}

// —— 4. 生产代码遍历（web/src，测试与类型声明不入对账面）——

const SRC = path.join(ROOT, 'web', 'src')
const prodFiles = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) prodFiles.push(p)
  }
})(SRC)
need(prodFiles.length >= 200, `web/src 生产文件遍历（实提 ${prodFiles.length}，基线 200）`)

// 首参四形态：单引号 / 双引号 / 全大写常量名 / 模板字面量（跨行实参靠 \s* 吃掉）
const ARG = `(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]*)|\`([^\`]*)\`)`
const LISTEN_RE = new RegExp(`\\baddEventListener\\(\\s*${ARG}`, 'g')
const CUSTOM_RE = new RegExp(`\\bnew\\s+CustomEvent(?:<[^>]*>)?\\(\\s*${ARG}`, 'g')
const EVENT_RE = new RegExp(`\\bnew\\s+Event\\(\\s*${ARG}`, 'g')

const listeners = new Map() // window 事件名 → [监听点 loc]
const feDispatch = new Map() // window 事件名 → [前端派发点 loc]

/** 首参捕获组 → 事件族内事件名；族外（普通 DOM 事件等）返回 null 不入对账面 */
function resolveArg(m, where) {
  let value
  if (m[1] !== undefined || m[2] !== undefined) value = m[1] ?? m[2]
  else if (m[3] !== undefined) {
    value = constByName.get(m[3])
    if (value === undefined) return null // 非 opsEvents 常量 = 非 sc 事件族
  } else {
    value = m[4]
    if (value.includes('${')) {
      warnings.push(`动态事件名「${value}」无法静态对账（${where}）——请改用 opsEvents 常量或显式登记豁免`)
      return null
    }
  }
  return value.startsWith('sc-ops:') || value.startsWith('sc:') ? value : null
}

function record(map, name, loc) {
  if (!map.has(name)) map.set(name, [])
  map.get(name).push(loc)
}

let listenSites = 0
let dispatchSites = 0
for (const f of prodFiles) {
  const text = stripComments(readText(f))
  const base = `${rel(f)}:`
  let m
  while ((m = LISTEN_RE.exec(text)) !== null) {
    const name = resolveArg(m, `${base}${lineOf(text, m.index)}`)
    if (name === null) continue
    record(listeners, name, `${base}${lineOf(text, m.index)}`)
    listenSites++
  }
  // useOpsChannel 是 WS→window 桥（广播面取数第 2 条已单独建模），排除出前端
  // 事件源扫描——它派发的每个名字都来自服务端 type，不算独立广播源
  if (f === channelPath) continue
  for (const re of [CUSTOM_RE, EVENT_RE]) {
    while ((m = re.exec(text)) !== null) {
      const name = resolveArg(m, `${base}${lineOf(text, m.index)}`)
      if (name === null) continue
      record(feDispatch, name, `${base}${lineOf(text, m.index)}`)
      dispatchSites++
    }
  }
}
need(listeners.size >= 25, `被监听事件名集合（实提 ${listeners.size}，基线 25）`)
need(feDispatch.size >= 8, `前端内部派发事件名集合（实提 ${feDispatch.size}，基线 8）`)

// —— 对账 ——

const silentSet = [] // 白名单豁免的在册 type（报告表格标注）
for (const t of serverTypes) {
  const w = windowByType.get(t)
  if (listeners.has(w)) continue
  if (SILENT_SERVER_EVENTS.has(t)) {
    notes.push(`type「${t}」→「${w}」无前端监听点（白名单）：${SILENT_SERVER_EVENTS.get(t)}`)
    silentSet.push(t)
    continue
  }
  errors.push(`广播了没人听：服务端在册 type「${t}」（source=${snapshot[t]?.source ?? '-'}）→ window 事件「${w}」无任何生产监听点——功能静默死。补前端消费方；确属 agent 面向有意无消费方，在本脚本 SILENT_SERVER_EVENTS 登记缘由（并同步 events.go 注记）`)
}

for (const [name, locs] of listeners) {
  if (serverBackedNames.has(name) || feDispatch.has(name)) continue
  const hint = name.startsWith('sc-ops:')
    ? `服务端快照无对应 type（外部 agent 自定义 type 出现消费方即按 events.go 约定升级正式事件补常量+快照登记）`
    : `前端内部事件（sc: 前缀）派发点已全部消失`
  errors.push(`听了没人广播：「${name}」（${locs.join('；')}）无任何广播源——死订阅永不触发。${hint}；确认废弃则删除监听点`)
}

for (const [name, locs] of feDispatch) {
  if (listeners.has(name)) continue
  if (SILENT_FRONT_EVENTS.has(name)) {
    notes.push(`前端派发「${name}」（${locs.join('；')}）无监听点（白名单）：${SILENT_FRONT_EVENTS.get(name)}`)
    continue
  }
  errors.push(`广播了没人听（前端内部）：「${name}」派发点（${locs.join('；')}）无生产监听点——死派发。补消费方或删除派发；确属占位事件在 SILENT_FRONT_EVENTS 登记缘由`)
}

for (const [name, value] of constByName) {
  if (listeners.has(value) || feDispatch.has(value) || serverBackedNames.has(value)) continue
  warnings.push(`死常量：${name} = '${value}' 无监听点亦无广播源——确认后删除，或补消费方/广播点`)
}

// —— 输出 ——

console.log('ops 事件名对账（广播面 ↔ 消费面，P-20261004-78）')
console.log(`  服务端在册 type: ${serverTypes.length}（显式分发 ${explicitByType.size} / 直通 ${serverTypes.length - explicitByType.size}，白名单无消费方 ${silentSet.length}）  opsEvents 常量: ${constByName.size}  监听事件名: ${listeners.size}（${listenSites} 处）  前端内部派发事件名: ${feDispatch.size}（${dispatchSites} 处）`)
console.log()
console.log('type'.padEnd(26) + 'source'.padEnd(14) + 'window 事件名'.padEnd(36) + '监听处')
console.log('-'.repeat(96))
const sortedTypes = [...serverTypes].sort()
for (const t of sortedTypes) {
  const w = windowByType.get(t)
  const n = listeners.get(w)?.length ?? 0
  const mark = silentSet.includes(t) ? '  [白名单]' : n === 0 ? '  [!]' : ''
  console.log(t.padEnd(26) + String(snapshot[t]?.source ?? '-').padEnd(14) + w.padEnd(36) + String(n) + mark)
}
console.log()
console.log('前端内部事件（sc:*，派发 ∪ 监听）')
for (const name of [...new Set([...feDispatch.keys(), ...listeners.keys()])].filter((n) => !serverBackedNames.has(n)).sort()) {
  console.log(`  ${name.padEnd(36)} 派发 ${feDispatch.get(name)?.length ?? 0} 处 / 监听 ${listeners.get(name)?.length ?? 0} 处`)
}
for (const s of notes) console.log(`[豁免] ${s}`)
for (const s of warnings) console.log(`[warn] ${s}`)
if (errors.length > 0) {
  for (const s of errors) console.error(`[error] ${s}`)
  console.error(`\ncheck-event-names: error ${errors.length}，warn ${warnings.length}——广播面与消费面漂移，拒绝通过`)
  if (REPORT_ONLY) {
    console.error('--report 模式恒退出码 0（仅供本地盘点查看）')
  } else {
    process.exit(1)
  }
} else {
  console.log(`\ncheck-event-names: error 0，warn ${warnings.length}——广播面与消费面一致，通过`)
}
