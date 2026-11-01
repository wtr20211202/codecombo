#!/usr/bin/env node
/**
 * ops 事件目录对账脚本（P-20261003-75）——docs/OPS_EVENTS.md 是 sc-ops:* 事件
 * 契约面的单一事实源，本脚本把「代码现实」扫出来与目录对账，防文档漂移：
 *
 *   node scripts/ops-events-catalog.cjs            # 漂移报告（退出码恒 0，供人工查看）
 *   node scripts/ops-events-catalog.cjs --check    # 门禁模式：漏登记/失效行退出码 1
 *   node scripts/ops-events-catalog.cjs --draft    # 按扫描结果产出目录表格草稿
 *                                                  # （人工校注语义列后粘贴进 OPS_EVENTS.md）
 *
 * 扫描面（与目录的覆盖面一一对应）：
 *   1. web/src/utils/opsEvents.ts        → window 事件名常量（export const X = '…'）
 *   2. web/src/composables/useOpsChannel.ts → 显式分发 switch case（其余 type 走直通）
 *   3. 仓库 *.go（排除 _test.go / web/dist）→ opschannel.BroadcastEvent 调用点：
 *      裸串形态 BroadcastEvent("<type>") 直取，常量形态
 *      BroadcastEvent(opschannel.EventXxx) 解析 server/api/opschannel 包的
 *      Event/System 前缀常量表取值（P-20261003-110 事件名常量化）
 *   4. docs/OPS_EVENTS.md                → 目录行（A 节 `### <type>` 小节 + 全文常量值出现）
 *
 * 判定口径：新常量 / 新广播 type 必须在目录中出现（硬失败）；目录小节 id 在代码侧
 * 消失 → 提示清理（--check 不因此失败——删事件属人工决策，脚本只报不裁）。
 * .cjs 而非 .mjs：与本目录 check-commit-msg.cjs 同款（仓库根无 package.json，
 * 未来若加且带 "type":"module" 也不受影响）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MODE = process.argv.includes('--check') ? 'check' : process.argv.includes('--draft') ? 'draft' : 'report'

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
}

function walkGo(dir, out) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist' || name.name === '.git') continue
    const p = path.join(dir, name.name)
    if (name.isDirectory()) walkGo(p, out)
    else if (name.name.endsWith('.go') && !name.name.endsWith('_test.go')) out.push(p)
  }
  return out
}

// —— 1. 前端常量族 ——
const eventsTs = read('web/src/utils/opsEvents.ts')
const constants = []
for (const m of eventsTs.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([^']+)'/g)) {
  constants.push({ name: m[1], value: m[2] })
}
if (constants.length === 0) {
  console.error('scan error: opsEvents.ts 未扫到任何常量——文件结构变化时同步本脚本正则（同 check-keybindings 惯例）')
  process.exit(2)
}

// —— 2. 显式分发型（useOpsChannel switch）——
const channelTs = read('web/src/composables/useOpsChannel.ts')
const explicitTypes = [...channelTs.matchAll(/case '([^']+)':/g)].map((m) => m[1]).filter((t) => t !== 'hello')
// 显式型 type → window 常量名（同 case 行 dispatch(CONST, …)；显式型的 window 事件名
// 与 type 不同名，直通型才恒等 sc-ops:<type>，故常量回查须走此映射而非字符串拼接）
const explicitConstByType = new Map()
for (const m of channelTs.matchAll(/case '([^']+)':\s*dispatch\(([A-Z][A-Z0-9_]*)/g)) {
  explicitConstByType.set(m[1], m[2])
}

// —— 3. 服务端广播调用点 ——
// P-20261003-110 起服务端 type 常量化（server/api/opschannel，Event/System 前缀）：
// 常量调用点须解析常量表取值才能与目录对账；裸串调用仍扫出直报——新广播点应
// 引用常量，两种形态漏登记都要拦
const opsConsts = new Map() // opschannel 事件常量名 → 事件 type 值
const opsDir = path.join(ROOT, 'server', 'api', 'opschannel')
for (const name of fs.readdirSync(opsDir)) {
  if (!name.endsWith('.go') || name.endsWith('_test.go')) continue
  const src = fs.readFileSync(path.join(opsDir, name), 'utf8')
  for (const m of src.matchAll(/^\s*(?:const\s+)?((?:Event|System)[A-Za-z0-9]*)\s*=\s*(.+?)\s*$/gm)) {
    const lit = m[2].match(/^"([^"]*)"$/)
    const concat = m[2].match(/^([A-Z][A-Za-z0-9]*)\s*\+\s*"([^"]*)"$/)
    if (lit) opsConsts.set(m[1], lit[1])
    else if (concat && opsConsts.has(concat[1])) opsConsts.set(m[1], opsConsts.get(concat[1]) + concat[2])
  }
}
if (opsConsts.size === 0) {
  console.error('scan error: server/api/opschannel 未扫到任何 Event/System 常量——常量表结构变化时同步本脚本正则（同 opsEvents.ts 空表守卫惯例）')
  process.exit(2)
}

const goFiles = walkGo(ROOT, [])
const broadcasts = [] // { type, loc }
let literalBroadcasts = 0 // 裸串调用点数（常量化后应恒为 0，留扫出兜底新调用点）
for (const f of goFiles) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/opschannel\.BroadcastEvent\(\s*(?:"([^"]+)"|opschannel\.([A-Z][A-Za-z0-9]*))/g)) {
    let type
    if (m[1] !== undefined) {
      type = m[1]
      literalBroadcasts++
    } else {
      type = opsConsts.get(m[2])
      if (type === undefined) {
        console.error(`scan error: ${path.relative(ROOT, f).replace(/\\/g, '/')} 引用未知 opschannel 事件常量 ${m[2]}——常量表改名时同步调用点`)
        process.exit(2)
      }
    }
    const line = src.slice(0, m.index).split('\n').length
    broadcasts.push({ type, loc: `${path.relative(ROOT, f).replace(/\\/g, '/')}:${line}` })
  }
}

// —— 4. 目录现状 ——
const doc = read('docs/OPS_EVENTS.md')
const docHeadings = [...doc.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim())
// 非事件小节（通配行等）——新增同类小节时在此登记
const headingAllowlist = [/^&lt;/]

// —— 对账 ——
const missingInDoc = [] // 代码有、目录无（漏登记，硬失败）
for (const b of broadcasts) {
  if (!doc.includes(b.type)) missingInDoc.push(`广播 type "${b.type}"（${b.loc}）未在目录出现`)
}
for (const c of constants) {
  if (!doc.includes(c.value)) missingInDoc.push(`常量 ${c.name} = '${c.value}' 未在目录出现`)
}
const staleRows = [] // 目录有、代码无（人工确认后清理）
for (const h of docHeadings) {
  if (headingAllowlist.some((re) => re.test(h))) continue
  const id = h.split(/[\s（]/)[0]
  const known =
    broadcasts.some((b) => b.type === id) ||
    explicitTypes.includes(id) ||
    constants.some((c) => c.value === id || c.value === `sc-ops:${id}`) ||
    doc.includes(`\`${id}\``) // B 节内部事件以行内代码形式列在表格里
  if (!known) staleRows.push(`目录小节 "### ${h}" 在代码侧未找到对应事件`)
}

// —— 输出 ——
if (MODE === 'draft') {
  console.log('<!-- 以下为扫描草稿：语义列（消费方/说明）需人工校注后合入 docs/OPS_EVENTS.md -->')
  console.log()
  console.log('| type | window 事件 | 分发 | 广播点 |')
  console.log('|---|---|---|---|')
  const byType = new Map()
  for (const b of broadcasts) {
    if (!byType.has(b.type)) byType.set(b.type, [])
    byType.get(b.type).push(b.loc)
  }
  for (const [type, locs] of byType) {
    const disp = explicitTypes.includes(type) ? '显式' : '直通'
    const konst = explicitConstByType.has(type)
      ? constants.find((c) => c.name === explicitConstByType.get(type))
      : constants.find((c) => c.value === `sc-ops:${type}`)
    console.log(`| \`${type}\` | ${konst ? `\`${konst.value}\`（\`${konst.name}\`）` : '（待命名）'} | ${disp} | ${locs.join('；')} |`)
  }
  console.log()
  console.log('<!-- 前端内部事件（不发线上）——消费方人工补注 -->')
  for (const c of constants) {
    console.log(`| \`${c.name}\` | \`${c.value}\` | | | |`)
  }
} else {
  console.log(`ops 事件对账（docs/OPS_EVENTS.md vs 代码）`)
  console.log(`  前端常量: ${constants.length} 个  显式分发型: ${explicitTypes.length} 型  服务端广播调用点: ${broadcasts.length} 处（${new Set(broadcasts.map((b) => b.type)).size} 型，裸串 ${literalBroadcasts} 处）  目录小节: ${docHeadings.length} 节`)
  const passthrough = [...new Set(broadcasts.map((b) => b.type))].filter((t) => !explicitTypes.includes(t))
  console.log(`  直通分发型（服务端广播）: ${passthrough.join(', ')}`)
  if (missingInDoc.length) {
    console.log(`\n[漏登记] 代码侧事件未进目录（新增事件必须同 PR 登记 docs/OPS_EVENTS.md）:`)
    for (const s of missingInDoc) console.log(`  - ${s}`)
  }
  if (staleRows.length) {
    console.log(`\n[失效行] 目录小节在代码侧已无对应事件（人工确认后清理，--check 不因此失败）:`)
    for (const s of staleRows) console.log(`  - ${s}`)
  }
  if (!missingInDoc.length && !staleRows.length) console.log('\n目录与代码一致。')
  if (MODE === 'check' && missingInDoc.length) {
    console.log('\n--check 失败：存在漏登记事件。')
    process.exit(1)
  }
}
