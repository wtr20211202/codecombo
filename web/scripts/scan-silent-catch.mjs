#!/usr/bin/env node
// scan-silent-catch.mjs —— 前端「真静默」catch 预筛（P-20261122-13 三步法①）
//
// 背景：catch 体不含任何反馈（toast/日志/抛错/emit）的块是「真静默」候选——用户
// 点了没反应、失败了不知道。axios 面不在候选内（api/http.ts 拦截器已统一 toast +
// 错误中心记账，见 CLAUDE.md「健壮性红线」），故②风险分流由本脚本顺手标注：
// 操作面命中 api 族调用的块归为 axios 面，其余按非 axios 面（storage/clipboard/
// Notification/createObjectURL/WS/router/JSON.parse）分组输出。
//
// 统计口径：
//   total     try/catch 子句 + Promise .catch(handler) 总数（web/src，剔 __tests__）
//   silent    提案基线 token（errorLog|toast|console.|throw|emit）均未出现的块
//   residual  再剔除本仓实际反馈通道与显式登记后的残余：
//             message./Message.（naive-ui 离散 API，本仓 toast 主通道）
//             notify.（通知中心/桌面通知）、silent-by-design（显式登记标记）
//
// 这是「按需手跑」工具，不入 npm run check 链（P-20261122-13 评审裁定：登记不设门禁）。
// 用法（web/ 目录下）：
//   node scripts/scan-silent-catch.mjs            # 汇总 + 分面残余清单
//   node scripts/scan-silent-catch.mjs --json     # 机器可读全量明细
//   node scripts/scan-silent-catch.mjs --file src/stores/instance.ts  # 只看单文件
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import ts from 'typescript'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '..', 'src')

// 提案基线 token（P-20261122-13 原文）
const BASE_TOKENS = /\berrorLog\b|toast|console\.|throw|emit/
// 本仓实际用户可见反馈通道 + 显式 by-design 登记（见 CLAUDE.md 前端编码规范）
const FEEDBACK_TOKENS = /message\.|Message\.|notify\.|silent-by-design/
// axios 面识别：api 域调用 / 带出域闸的 fetch（其失败已由 http.ts 拦截器统一 toast+记账）
const AXIOS_SURFACE = /\bapi\.|\b\w+Api\.|fetchWithEgressGate|await fetch\(/
// 非 axios 风险面（提案②）
const SURFACES = {
  storage: /safeStorage|localStorage|sessionStorage|indexedDB/,
  clipboard: /copyText|Clipboard|clipboard/,
  notification: /\bNotification\b|useDesktopNotify/,
  objectUrl: /createObjectURL/,
  websocket: /\.send\(|WebSocket/,
  router: /router\.(push|replace)/,
  jsonParse: /JSON\.parse/,
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'coverage') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full)
  }
  return out
}

/** .vue 提取 <script> 块，返回块内文本与起始行偏移（保证行号对齐源文件） */
function scriptBlocks(text) {
  const out = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].indexOf('>') + 1
    out.push({ code: m[1], lineOffset: text.slice(0, start).split('\n').length - 1 })
  }
  return out
}

function lineOf(text, pos) {
  return text.slice(0, pos).split('\n').length
}

/** 收集单文件里的 catch 块（try/catch 与 .catch(handler)），标注反馈面与操作面 */
function collect(code, lineOffset, file) {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hits = []
  const push = (node, kind, body, op) => {
    const flat = (s) => s.replace(/\s+/g, ' ').trim()
    hits.push({
      file,
      line: lineOf(code, node.getStart(sf)) + lineOffset,
      kind,
      silent: !BASE_TOKENS.test(body),
      residual: !BASE_TOKENS.test(body) && !FEEDBACK_TOKENS.test(body),
      axios: AXIOS_SURFACE.test(op),
      op: flat(op).slice(0, 400),
      body: flat(body).slice(0, 200),
    })
  }
  const visit = (node) => {
    if (ts.isTryStatement(node) && node.catchClause) {
      push(node.catchClause, 'try-catch', node.catchClause.block.getText(sf), node.tryBlock.getText(sf))
    }
    const isCatchCall = ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.getText(sf) === 'catch'
    if (isCatchCall) {
      const cb = node.arguments[0]
      push(node, '.catch()', cb ? cb.getText(sf) : '', node.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

const onlyFile = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null
const files = walk(SRC).filter((f) => {
  if (!onlyFile) return true
  return path.resolve(onlyFile).toLowerCase() === path.resolve(f).toLowerCase()
    || f.split(path.sep).join('/').endsWith('/' + onlyFile.replace(/\\/g, '/'))
})

const hits = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const rel = path.relative(SRC, f).split(path.sep).join('/')
  if (f.endsWith('.vue')) {
    for (const b of scriptBlocks(text)) hits.push(...collect(b.code, b.lineOffset, rel))
  } else {
    hits.push(...collect(text, 0, rel))
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(hits, null, 1))
  process.exit(0)
}

const silent = hits.filter((h) => h.silent)
const residual = silent.filter((h) => h.residual)
const nonAxios = residual.filter((h) => !h.axios)
console.log(`total catch sites: ${hits.length}`)
console.log(`proposal-base silent (no errorLog|toast|console.|throw|emit): ${silent.length}`)
console.log(`residual after message/notify/silent-by-design: ${residual.length}`)
console.log(`  ├─ axios surface (http.ts 拦截器已统一反馈，不修): ${residual.length - nonAxios.length}`)
console.log(`  └─ non-axios surface (真静默候选): ${nonAxios.length}`)

const bySurface = new Map()
for (const h of nonAxios) {
  // 风险面判据看操作面（try 块 / .catch 接收者）：SURFACES 的调用通常就在 try 里，
  // catch 体只负责兜底
  const names = Object.entries(SURFACES).filter(([, re]) => re.test(h.op)).map(([n]) => n)
  for (const name of names.length > 0 ? names : ['other']) {
    const arr = bySurface.get(name) || []
    arr.push(h)
    bySurface.set(name, arr)
  }
}
for (const [name, arr] of [...bySurface.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n[${name}] ${arr.length}`)
  for (const h of arr) console.log(`  ${h.file}:${h.line}  ${h.body}`)
}
