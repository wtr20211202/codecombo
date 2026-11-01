#!/usr/bin/env node
// check-e2e-dualpath.mjs —— 跨拓扑双路径对账门禁（P-20261005-187 第三层：防再脱钩）
//
// 用法：
//   node scripts/check-e2e-dualpath.mjs   # error 级违例 → 退出码 1（无违例静默过）
//
// 背景：跨拓扑 e2e（Windows Playwright 打 WSL 服务实例，e2e-cross.sh 设
// E2E_SERVER_OS=linux）里，测试侧 os.tmpdir() 等本地绝对路径对 Linux 服务端
// 不可解释——必须经 tests/dualpath.ts 的 serverPath() 翻译成交服务端形态再交
// 服务端 API。10-05 跨拓扑全目录首跑 141+ 支稳定同败的根因即播种链把 Windows
// 路径直交服务端（fatal: 'C:\…' is not a working tree 及其下游 locator 超时）。
// 本门禁静态对账「绝对路径 → 服务端 payload 必经翻译」，防新增 spec 再次脱钩。
//
// 规则（零误报优先，宁漏勿误——同 check-e2e-conventions 家族口径）：
//   error：payload 对象字面量的路径字段（path/dir/targetDir/paths/dirs 等，
//          与服务端 bind 结构对齐）的值表达式引用了「本地绝对路径源」
//          （os.tmpdir()/process.env.TEMP/TMP/process.cwd()/__dirname 派生变量、
//          dualTmpDir() 返回值的非 .server 成员、盘符路径字面量）而未经
//          serverPath(...) 包裹。
//   不纳入（已知边界，宁漏勿误）：
//   - 经函数参数间接传递的路径（helper 内翻译/调用方传原始变量，行级静态
//     分析看不穿调用边——已迁移 spec 的 registerProject(dir) 范式依赖它）；
//   - 共享层 e2e-api 的 createAgentSessionApi：dir 选项契约即「本地形态，
//     内部自动 serverPath 翻译」（P-20261004-48），调用行显式豁免——上行
//     边界里行级静态可判定的子例，新路径型 API 原语入共享层时在此追加
//   - 项目相对路径 payload（file/gitops 域 `path: 'a.txt'`，服务端按项目根
//     解析，与拓扑无关）——值不引用绝对路径源即不触发；
//   - 服务端同为 Linux 的 WSL 内门禁（wsl-e2e.sh 全量）不受影响：os.tmpdir()
//     两侧同为 /tmp 形态，serverPath 恒等返回，翻译叠加不改语义。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_DIRS = [path.join(root, 'e2e', 'specs'), path.join(root, 'tests')]

function listSpecs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listSpecs(p, out)
    else if (e.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

// 「本地绝对路径源」变量定义行：RHS 含 tmpdir/TEMP/cwd/__dirname（os.tmpdir()
// 与具名导入 tmpdir() 两形态都认——fleet-overview 等走 `import { tmpdir }`），
// 或经 dualTmpDir() 建的双形态夹具（.server 成员合法，其余成员/整体非法）
const ABS_SOURCE_RE = /(?:\bos\.|[^.\w])tmpdir\(\)|process\.env\.TEMP|process\.env\.TMP|process\.cwd\(\)|__dirname/
const DUAL_DIR_RE = /\bdualTmpDir\(/
// 声明/赋值行提取变量名：`name =`（排除 == / => / 比较）——声明与重赋值同规则
// （`const dir = …os.tmpdir()…` 与 `localDir = path.join(os.tmpdir()…)` 都入集）
const ASSIGN_RE = /\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*[^=;\n]/g

// 服务端 payload 的路径字段（与 server/api 各 bind 结构的 json tag 对齐：
// project.go path / clone.go dir / worktree.go path / disk.go dirs 等）
const PATH_KEY_RE = /\b(path|dir|targetDir|sourceDir|destDir|paths|dirs|repoPath|worktreePath|localPath)\s*:/
// 简写属性形态（`{ kind: 'agent', dir }`）：仅在 payload 锚定行上启用，
// 防函数签名/解构里的同名参数误报
const PATH_SHORTHAND_RE = /\b(path|dir|paths|dirs)\b\s*(?=[,}\]])/
// payload 锚定行：data:/body: 赋值带对象字面量，或 JSON.stringify({...}) 内联
const PAYLOAD_LINE_RE = /\b(data|body)\s*[:=]\s*[^;]*\{|JSON\.stringify\(\s*\{/
// 断言匹配器：expect(...).toMatchObject/toEqual 等的对象字面量是「值比对」不是
// 交服务端的 payload（如 timeline-resume 断言前端按 transcript cwd 原样回显
// dir）——匹配器行起、至闭合行 `})` 止的窗口内不查（宁漏勿误，窗口只抑制不新增）
const MATCHER_RE = /\.(toMatchObject|toEqual|toStrictEqual|toMatchInlineSnapshot|toNestedEqual)\s*\(/
const ASSERTION_CLOSE_RE = /^\}\)[,;]?\s*$/
// 值表达式已翻译的形态：serverPath(...) 包裹；或 dualTmpDir 返回值的 .server 成员
const TRANSLATED_RE = /serverPath\s*\(|\.\bserver\b/

// 盘符路径字面量（Windows 形态硬编码，两拓扑语义即分叉）
const DRIVE_LITERAL_RE = /['"`][A-Za-z]:[\\/][^'"`]*['"`]/

const violations = []

for (const file of SPEC_DIRS.flatMap((d) => listSpecs(d))) {
  const lines = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((t, i) => ({ n: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\*|\/\*)/.test(t)) // 整行注释不执行（家族口径）

  // 收集本文件的绝对路径源变量名
  const absVars = new Set()
  for (const { text } of lines) {
    const isAbs = ABS_SOURCE_RE.test(text)
    const isDual = DUAL_DIR_RE.test(text)
    // 赋值已经 serverPath(...) 包裹的不入源集：RHS 引用 abs 源是被翻译消费，
    // 结果是服务端形态（`const repoPath = serverPath(path.resolve(process.cwd(),
    // '..'))` 先例）——仍入集会让后续合法 payload `path: repoPath` 误报
    // （terminal-external-tmux.spec 实测误报一例）。整行级保守近似：同行混入
    // 未翻译 abs 声明的极端写法按宁漏勿误放行
    if (isAbs && /serverPath\s*\(/.test(text)) continue
    if (!isAbs && !isDual) continue
    // 行上所有被赋值名（逗号多声明同标记——行级静态的保守近似）
    for (const m of text.matchAll(ASSIGN_RE)) absVars.add(m[1])
    // 解构声明：const { win, server } = dualTmpDir(...) —— win/server 单名入集
    if (isDual) {
      for (const m of text.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[},]/g)) absVars.add(m[1])
    }
  }

  const valueUsesAbsSource = (expr) => {
    if (DRIVE_LITERAL_RE.test(expr)) return true
    for (const name of absVars) {
      const re = new RegExp(`\\b${name}\\b`)
      if (!re.test(expr)) continue
      // dualTmpDir 双形态：取 .server 成员即已翻译；其余（.win/整体）非法
      if (new RegExp(`\\b${name}\\s*\\.\\s*server\\b`).test(expr)) continue
      return true
    }
    // 行内直接引用绝对路径源（path: path.join(os.tmpdir(), 'x')）
    return ABS_SOURCE_RE.test(expr)
  }

  let suppress = false
  let suppressLeft = 0
  for (const { n, text } of lines) {
    // 断言窗口：匹配器行开启，闭合行或 15 行兜底窗口关闭（窗口只抑制不新增）
    if (suppress) {
      suppressLeft -= 1
      if (ASSERTION_CLOSE_RE.test(text.trim()) || suppressLeft <= 0) suppress = false
      continue
    }
    if (MATCHER_RE.test(text)) {
      suppress = true
      suppressLeft = 15
      continue
    }
    const full = PATH_KEY_RE.test(text)
    const shorthand = !full && PAYLOAD_LINE_RE.test(text) && PATH_SHORTHAND_RE.test(text)
    if (!full && !shorthand) continue
    // 共享层 e2e-api.createAgentSessionApi 的 dir 选项内部已 serverPath 翻译
    // （tests/e2e-api.ts 契约）——调用行免查，见头注「不纳入」第二条
    if (/createAgentSessionApi\s*\(/.test(text)) continue
    // 取首个字段键之后的值表达式段（同一行内；多行 payload 的值段按行内剩余计）
    const keyAt = text.search(full ? PATH_KEY_RE : PATH_SHORTHAND_RE)
    const valueSeg = text.slice(keyAt)
    if (TRANSLATED_RE.test(valueSeg)) continue
    if (!valueUsesAbsSource(valueSeg)) continue
    violations.push({
      file,
      line: n,
      text: text.trim().slice(0, 160),
      reason: DRIVE_LITERAL_RE.test(valueSeg)
        ? '盘符路径字面量'
        : 'os.tmpdir()/cwd()/dualTmpDir() 派生的本地绝对路径',
    })
  }
}

const rel = (f) => path.relative(root, f).replaceAll('\\', '/')
for (const v of violations) {
  console.log(`${rel(v.file)}:${v.line}: [error] dualpath-untranslated: ${v.reason}交服务端 payload 未经 serverPath() 翻译`)
  console.log(`    ${v.text}`)
}
console.log(`\ncheck-e2e-dualpath: error ${violations.length}`)
if (violations.length > 0) {
  console.log('存在未翻译的本地绝对路径 payload——经 tests/dualpath.ts 的 serverPath() 翻译后交服务端（测试侧 fs 断言维持原路径）；详见脚本头注')
  process.exit(1)
}
