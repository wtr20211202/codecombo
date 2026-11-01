#!/usr/bin/env node
// check-e2e-conventions.mjs —— e2e 反模式静态检查（守门 CLAUDE.md「测试」节既有条目）
//
// 用法：
//   node scripts/check-e2e-conventions.mjs                  # error 级违例 → 退出码 1；warn 级仅报告
//   node scripts/check-e2e-conventions.mjs --report-skips   # 一屏汇总全部缺口类 skip+引用提案号（对账/收割输入）
//   node scripts/check-e2e-conventions.mjs --self-test      # 临时夹具自检（缺口/环境分类与引用守卫红绿）
//
// 说明：
//   - 扫描 e2e 用例文本（与 playwright testMatch 对齐：e2e/specs/ 与 tests/ 下
//     *.spec.ts），纯静态逐行匹配，秒级完成，接入 npm run check 尾部
//   - 规则全部取自 CLAUDE.md「测试」节沉淀的确定性条目；零误报优先——形态拿不准的
//     （如 modal/agent view 单终端作用域内的 .first()、经变量拼接的 goto URL）宁漏勿误
//   - error：page.on('dialog')、locator 含 [ref=、xterm 断言/交互配 .first()（限 tab
//     堆叠作用域）、裸 .lock-overlay input（须经 .lock-form）、缺口类 skip 未引用
//     追踪提案号（gap-skip-no-ref，P-20261004-86——提案落地 grep 提案号即得全部待解除守卫）
//   - warn：直接 page.goto 进项目页而全文件无 gotoAndUnlock/unlockIfNeeded 引用、
//     通知域 spec（文件名含 notif 且访问通知列表 API）缺 notifications/clear 前置、
//     已有 data-testid 语义锚点的选择器（设置导航项/提交面板页签/底部面板页签）
//     再用字面量 nth(N) 定位、spec 内重定义共享测试层（web/tests/）导出的同名
//     函数（P-20261004-48：createAgentSession 首个目标，存量渐进收编）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_DIRS = [path.join(root, 'e2e', 'specs'), path.join(root, 'tests')]

// ---------- 文件收集（递归 *.spec.ts） ----------
function listSpecs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listSpecs(p, out)
    else if (e.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

// ---------- error 级规则（逐行） ----------
const LINE_RULES = [
  {
    id: 'dialog-event',
    // confirmDialog（useDialog）渲染 n-modal 而非 window.confirm，dialog 事件等不到
    test: (line) => /page\.on\(\s*['"]dialog['"]/.test(line),
    message: "page.on('dialog') 对 confirmDialog（n-modal）无效——应在弹出的确认弹窗内点确认按钮",
  },
  {
    id: 'aria-ref-selector',
    // aria 快照里的 [ref=e123] 是 Playwright 会话标记，不是 DOM 属性
    test: (line) => line.includes('[ref='),
    message: '[ref=e…] 是 aria 快照里的 Playwright 标记，不是 CSS 选择器',
  },
  {
    id: 'xterm-first',
    // 多 tab 时旧 tab-content 仍挂载且 DOM 序在前——xterm 断言/交互取 last 即当前
    // 活跃屏。只查已证实的堆叠作用域（.term-tab-content 祖先、页面级裸 .xterm 或
    // .xterm-行内容定位）；单终端作用域（modal/agent view 等）的 .first() 合法，不纳入
    test: (line) => {
      if (!line.includes('.first()') || !line.includes('xterm')) return false
      if (line.includes('xterm-helper-textarea')) return false // 键入代理元素，非屏内容
      return (
        line.includes('term-tab-content') ||
        /page\.locator\(\s*['"`]\.xterm[^-]/.test(line) ||
        /page\.locator\(\s*['"`]\.xterm-(rows|screen|text-layer)/.test(line)
      )
    },
    message: 'xterm 断言/交互应取 .last()——多 tab 时旧屏 DOM 序在前（CLAUDE.md「测试」节）',
  },
  {
    id: 'lock-overlay-input',
    // 解锁输入框走 .lock-form input（Chromium text-security 主路径，非 type=password）
    test: (line) =>
      line.includes('locator(') &&
      /(lock-overlay|LOCK_OVERLAY)/.test(line) &&
      /input/i.test(line) &&
      !line.includes('lock-form'),
    message: '锁定遮罩输入框用 .lock-overlay .lock-form input，勿用裸 .lock-overlay input',
  },
]

// ---------- error 级规则：skip 守卫的提案引用纪律（P-20261004-86） ----------
// 产品缺口类 test.skip/skipIf 必须引用追踪提案号：缺口↔提案零机器联系时，提案落地后
// 哪些守卫该解除全靠记忆，守卫漏解除=测试覆盖永久暗坑（实证：serverIsLinux 守卫曾
// 4 处共享同一 Linux shellint 缺口，直到人工聚合才见全貌；P-20261004-82 守卫解除即靠
// 逐处 grep）。引用锚点使「grep 提案号即得全部守卫位」，--report-skips 一屏对账。
// 关键词只取「缺口语族」显式措辞（零误报优先）：环境差异类 skip（不可达/未播种/
// 未就绪）不携带这些措辞，天然不触发；「不支持」另带外部工具版本界豁免——
// 「服务端 git 不支持 merge-tree（< 2.38）」是环境能力门控的降级语义，非产品缺口
const GAP_KEYWORD_RE = /产品缺口|未生效|缺陷|独立跟进|待跟进|不支持/g
const VERSION_BOUND_RE = /[（(]\s*<\s*\d/ // 外部工具版本界（仓内惯例「（< 2.38）」）＝环境门控
const PROPOSAL_REF_RE = /P-\d+(?:-\d+)?/g // 提案号：旧式 P-109 与现行 P-20261004-82 双形态

// 守卫窗口 = 紧邻上方连续 // 注释行（守卫登记注释的惯例位）+ 调用行 + 其后 4 行
// （多行理由串，如 deploy-restart-sweep 的模板串）。调用行只认代码行——注释里
// 提及 test.skip( 不是守卫
function scanSkips(rawLines) {
  const out = []
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]
    if (!/\btest\.(?:skip|skipIf)\s*\(/.test(text)) continue
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) continue
    let start = i
    while (start > 0 && /^\s*\/\//.test(rawLines[start - 1])) start--
    out.push({ line: i + 1, window: rawLines.slice(start, i + 5).join('\n') })
  }
  return out
}

function classifySkip(occ) {
  const keywords = new Set()
  for (const m of occ.window.matchAll(GAP_KEYWORD_RE)) keywords.add(m[0])
  // 「不支持」且同行窗口带版本界 → 环境能力门控，从缺口集剔除（其余关键词不豁免）
  if (keywords.has('不支持') && VERSION_BOUND_RE.test(occ.window)) keywords.delete('不支持')
  const refs = [...new Set([...occ.window.matchAll(PROPOSAL_REF_RE)].map((m) => m[0]))]
  return { line: occ.line, gap: keywords.size > 0, keywords: [...keywords], refs, window: occ.window }
}

function gapSkipFinding(file, occ) {
  return {
    file, line: occ.line, level: 'error', rule: 'gap-skip-no-ref',
    message: `产品缺口类 skip（措辞：${occ.keywords.join('/')}）未引用追踪提案号——在理由串或紧邻注释补 P-<提案号>` +
      '（提案落地后 grep 提案号即得全部待解除守卫；纯环境门控请改用环境措辞：不可达/未播种/外部版本界（< N.N））',
  }
}

// 报告行的理由提取：调用点之后首个引号串（多行模板串截到首个内嵌引号——环境类
// 不进缺口清单，展示精度够用）
function skipReasonOf(win) {
  const at = win.search(/test\.(?:skip|skipIf)\s*\(/)
  if (at < 0) return ''
  const m = /['"`]((?:[^'"`\\]|\\.)+?)['"`]/.exec(win.slice(at))
  return (m ? m[1] : '').replace(/\s+/g, ' ').trim() || '（理由见源行）'
}

// ---------- warn 级规则（逐行：已有语义锚点的选择器再走位置索引） ----------
// W3 nth() 位置引用：data-testid 锚点家族再用字面量 nth(N) 依赖 DOM 序——分区/
// 页签插入新项即整体漂移静默改点其他目标（P-20261002-151 前设置分区只能追加表尾
// 就是这条约束）。类名全仓唯一性已核实：.nav-item 仅 SettingsModal、.cp-tab 仅
// CommitPanel。只查已建锚点家族并给出替换锚点——零误报优先：动态行序/重排断言
// （通知键盘高亮、tab 拖拽排序）里的 nth 是被测语义，变量下标 nth(i) 是循环迭代，
// 均不纳入
const NTH_TESTID_FAMILIES = [
  {
    re: /\.nav-item/,
    hint: '[data-testid="settings-nav-<分区>"]（键见 utils/settingsSearch.ts）',
  },
  {
    re: /\.cp-tab(?![\w-])/,
    hint: '[data-testid="cp-tab-changes" | "cp-tab-stash"]',
  },
  {
    re: /\.bottom-tabs/,
    hint: '[data-testid="bottom-tab-<key>"]（terminal/git/preview/console）',
  },
]

function nthOnAnchoredSelector(line) {
  if (!/\.nth\(\s*\d+\s*\)/.test(line)) return null
  for (const fam of NTH_TESTID_FAMILIES) {
    if (fam.re.test(line)) return fam.hint
  }
  return null
}

// ---------- warn 级规则（文件级启发式） ----------
// W1 裸 goto 进项目页：锁定开关是服务端跨用例全局状态，裸 goto 在锁定开启时落到
// 遮罩上（CLAUDE.md：不关心锁定态的 spec 统一 gotoAndUnlock；spec 自管解锁的
// unlockIfNeeded 亦认可）。URL 字面量含 project 即视为项目页
function bareGotoProjectLines(codeLines) {
  const hits = []
  for (const { n, text } of codeLines) {
    if (/page\.goto\(/.test(text) && /['"`][^'"`]*project/.test(text)) hits.push(n)
  }
  return hits
}

// W2 通知域 spec 缺 clear 前置：前序用例遗留的未读通知会让徽标计数/行定位不确定
// （CLAUDE.md：用例开头先 API 清空再播种）。文件名含 notif 且访问通知列表 API
// 才算通知域——/api/notifications 后跟 / 的子路径（prefs、webhook-test 等）不算
function notifyDomainMissingClear(file, text) {
  if (!path.basename(file).includes('notif')) return false
  if (text.includes('notifications/clear')) return false
  return /\/api\/notifications(?![-\w/])/.test(text)
}

// W4 spec 内重定义共享测试层同名函数（P-20261004-48）：tests/ 共享层（helpers/
// e2e-api/dualpath 等）导出的原语在 spec 内再写一份同名实现——签名互异的漂移
// 繁殖起点（createAgentSession 曾十余个 spec 各写一份）。warn 非 error：存量
// 渐进收编，新 spec 起草时直接 import 共享实现。UI 版 helpers 同名是有意分层，
// 本规则只扫 *.spec.ts 定义形态（import/调用不触发），共享层文件自身不入扫描面
function collectSharedExportNames() {
  const names = new Set()
  const dir = path.join(root, 'tests')
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return names
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.spec.ts')) continue
    const text = fs.readFileSync(path.join(dir, e.name), 'utf-8')
    for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1])
    for (const m of text.matchAll(/export\s+const\s+(\w+)/g)) names.add(m[1])
  }
  return names
}
const SHARED_EXPORT_NAMES = collectSharedExportNames()

function sharedExportShadow(codeLines) {
  const hits = []
  for (const { n, text } of codeLines) {
    // 函数声明或箭头函数定义（const x = (…) => / = async (…) =>）；参数表允许
    // 一层嵌套括号（import('…') 内联类型），更深嵌套宁漏勿误。括号表达式赋值
    // （const x = (a || b)）不匹配箭头胖箭头，天然排除
    const m = /(?:async\s+)?function\s+(\w+)\s*[(<]|const\s+(\w+)\s*=\s*(?:async\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+)?=>/.exec(text)
    const name = m?.[1] || m?.[2]
    if (name && SHARED_EXPORT_NAMES.has(name)) hits.push({ n, name })
  }
  return hits
}

// ---------- 主流程 ----------
const specs = SPEC_DIRS.flatMap((d) => listSpecs(d))
const rel = (f) => path.relative(root, f).replaceAll('\\', '/')

// --self-test：临时夹具自检缺口/环境分类与引用守卫红绿（同族脚本惯例），全程
// mkdtemp 不碰仓库与真实台账
function selfTest() {
  const CASES = [
    // [名, 文件体, 期望缺口类数, 期望 error 数]
    ['gap-no-ref', "test('t', () => {\n  // 终端输入完整性缺陷\n  test.skip(serverIsLinux, '产品缺口待跟进')\n})", 1, 1],
    ['gap-ref-in-comment', "test('t', () => {\n  // 产品缺口（P-20261004-82）\n  test.skip(serverIsLinux, '跳过')\n})", 1, 0],
    ['gap-ref-in-reason', "test('t', () => {\n  test.skip(serverIsLinux, '该功能 Linux 未生效（P-20261004-82 实证登记）')\n})", 1, 0],
    ['env-version-bound', "test('t', () => {\n  test.skip(supported !== true, '服务端 git 不支持 merge-tree（< 2.38），入口按降级语义隐藏')\n})", 0, 0],
    ['env-unsupported-no-bound', "test('t', () => {\n  test.skip(ok, '该环境不支持 X，跳过')\n})", 1, 1],
    ['env-platform', "test('t', () => {\n  test.skip(!wslUp, 'WSL sshd 不可达，跳过')\n})", 0, 0],
    ['skipif-with-ref', "test.skipIf(process.platform === 'win32')('t', () => {\n  // 产品缺口 P-404\n})", 1, 0],
    ['multiline-reason-no-ref', "test('t', () => {\n  test.skip(cond,\n    'Linux 输入完整性缺陷，独立跟进')\n})", 1, 1],
    ['comment-mention-only', "// 提及 test.skip( 的注释不是守卫：产品缺口措辞在此无调用行\ntest('t', () => {})", 0, 0],
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-selftest-'))
  let failed = 0
  try {
    for (const [name, body, wantGap, wantErr] of CASES) {
      const file = path.join(dir, `${name}.spec.ts`)
      fs.writeFileSync(file, body + '\n')
      const occs = scanSkips(fs.readFileSync(file, 'utf-8').split('\n')).map(classifySkip)
      const gap = occs.filter((o) => o.gap).length
      const errs = occs.filter((o) => o.gap && o.refs.length === 0).length
      if (gap === wantGap && errs === wantErr) console.log(`ok   ${name} (gap=${gap} err=${errs})`)
      else {
        failed++
        console.log(`FAIL ${name}: 期望 gap=${wantGap}/err=${wantErr}，实际 gap=${gap}/err=${errs}`)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log(failed === 0 ? `self-test: ${CASES.length} 断言全过` : `self-test: ${failed} 断言失败`)
  process.exit(failed === 0 ? 0 : 1)
}
if (process.argv.includes('--self-test')) selfTest() // 内部按结果 process.exit

// --report-skips：一屏汇总全部缺口类 skip+引用提案号——守卫解除对账（提案落地逐号
// 解除）与缺口收割（enhance-harvest-gaps）的输入；只读清单不拦门禁（门禁在下方
// 默认模式的 gap-skip-no-ref），恒退出 0
if (process.argv.includes('--report-skips')) {
  const rows = []
  for (const file of specs) {
    for (const occ of scanSkips(fs.readFileSync(file, 'utf-8').split('\n')).map(classifySkip)) {
      rows.push({ file, ...occ })
    }
  }
  const gaps = rows.filter((r) => r.gap)
  const unref = gaps.filter((g) => g.refs.length === 0)
  console.log('== 缺口类 skip（须引用追踪提案号，提案落地后逐号解除）==')
  for (const g of gaps) {
    console.log(`${rel(g.file)}:${g.line}  [${g.refs.join(', ') || '缺引用!'}]  ${skipReasonOf(g.window)}`)
  }
  console.log(`\n共 ${rows.length} 处 skip：缺口类 ${gaps.length}（缺引用 ${unref.length}），环境类 ${rows.length - gaps.length}（不要求引用，明细 grep test.skip）`)
  process.exit(0)
}

const findings = [] // { file, line, level, rule, message }

for (const file of specs) {
  const text = fs.readFileSync(file, 'utf-8')
  const rawLines = text.split('\n')
  // 注释行不执行，全部规则跳过防误报
  const codeLines = rawLines
    .map((t, i) => ({ n: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\*|\/\*)/.test(t))
  for (const { n, text: line } of codeLines) {
    for (const rule of LINE_RULES) {
      if (rule.test(line)) {
        findings.push({ file, line: n, level: 'error', rule: rule.id, message: rule.message })
      }
    }
    const nthHint = nthOnAnchoredSelector(line)
    if (nthHint) {
      findings.push({
        file, line: n, level: 'warn', rule: 'nth-positional-anchor',
        message: `位置索引 nth(N) 依赖 DOM 序，插入新项即静默改点——改用语义锚点 ${nthHint}`,
      })
    }
  }
  // W1：有裸 goto 项目页且全文件无任何解锁处理引用
  if (!text.includes('gotoAndUnlock') && !text.includes('unlockIfNeeded')) {
    for (const n of bareGotoProjectLines(codeLines)) {
      findings.push({
        file, line: n, level: 'warn', rule: 'bare-goto-project',
        message: '直接 page.goto 进项目页且无解锁处理——不关心锁定态的 spec 统一用 gotoAndUnlock',
      })
    }
  }
  if (notifyDomainMissingClear(file, text)) {
    findings.push({
      file, line: 0, level: 'warn', rule: 'notify-no-clear',
      message: '通知域 spec 缺 clear 前置——用例开头 POST /api/notifications/clear 再播种',
    })
  }
  for (const { n, name } of sharedExportShadow(codeLines)) {
    findings.push({
      file, line: n, level: 'warn', rule: 'shared-export-shadow',
      message: `spec 内重定义了共享测试层（web/tests/）导出的同名函数 ${name}——复用共享实现（e2e-api/helpers/dualpath…），勿在 spec 内再写一份`,
    })
  }
  // skip 守卫提案引用纪律（P-20261004-86）：缺口类 skip 未引用提案号即 error
  for (const occ of scanSkips(rawLines).map(classifySkip)) {
    if (occ.gap && occ.refs.length === 0) findings.push(gapSkipFinding(file, occ))
  }
}

for (const f of findings) {
  const at = f.line > 0 ? `:${f.line}` : ''
  console.log(`${rel(f.file)}${at}: [${f.level}] ${f.rule}: ${f.message}`)
}
const errors = findings.filter((f) => f.level === 'error').length
const warns = findings.length - errors
console.log(`\ncheck-e2e-conventions: ${specs.length} 个 spec 文件，error ${errors}，warn ${warns}`)
if (errors > 0) {
  console.log('存在 error 级反模式，拒绝通过；修复或给出豁免理由后重试（规则见 CLAUDE.md「测试」节）')
  process.exit(1)
}
