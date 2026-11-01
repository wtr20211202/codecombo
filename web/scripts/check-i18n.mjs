#!/usr/bin/env node
// check-i18n.mjs —— 前端 i18n 与主题色审计
//
// 用法：
//   node scripts/check-i18n.mjs            # 校验 t() 引用的 key 在 zh/en 都存在（缺失则退出码 1）
//   node scripts/check-i18n.mjs --colors   # 扫描 .vue 样式中的硬编码颜色（报告模式）
//   node scripts/check-i18n.mjs --unused   # 反向死键检测：语言包有、源码已无引用的键（报告模式）
//   node scripts/check-i18n.mjs --audit    # 审计动作常量 ↔ audit.action 词条双向对账
//                                          # （P-20261004-144 契约闸门第五轴；缺词条退出码 1，已接入 npm run check）
//   node scripts/check-i18n.mjs --audit --self-test  # 构造临时夹具自检解析与双向 diff（不碰源码树）
//   node scripts/check-i18n.mjs --errcodes # 结构化错误码映射对账（P-20261005-153）：
//                                          # http.ts ERROR_CODE_I18N 的 i18n 键 zh/en 齐备 + 码在 Go
//                                          # 注册表登记（缺一退出码 1，已接入 npm run check）
//   node scripts/check-i18n.mjs --errcodes --self-test  # 夹具自检解析与红/绿三态（不碰源码树）
//
// 说明：
//   - locale 文件用缩进感知的轻量解析器展开为平铺 key 集合（支持带引号的
//     'key.placeholder' 形式、// 注释、值内 {n} 占位与反引号字符）
//   - 动态 key（t(`...`) 模板串）无法静态校验，仅统计数量提示
//   - --unused 为报告模式（恒退出 0），独立调用不进 check 链；死键判定只认
//     静态引用与可识别的动态前缀，宁漏勿误，删除前仍需逐键人工复核
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const LOCALES = {
  'zh-CN': path.join(SRC, 'locales', 'zh-CN.ts'),
  'en-US': path.join(SRC, 'locales', 'en-US.ts'),
}
const COLORS_MODE = process.argv.includes('--colors')
const UNUSED_MODE = process.argv.includes('--unused')
const AUDIT_MODE = process.argv.includes('--audit')
const ERRCODES_MODE = process.argv.includes('--errcodes')
const SELF_TEST_MODE = process.argv.includes('--self-test')

// ---------- locale 平铺解析（缩进感知，处理 2 空格嵌套） ----------
function parseLocaleText(text) {
  const keys = new Set()
  const lines = text.split('\n')
  const stack = [] // 段落路径栈：stack[i] 对应第 i+1 层
  let started = false
  for (const raw of lines) {
    if (!started) {
      if (raw.trim() === 'export default {') started = true
      continue
    }
    const line = raw.replace(/\r$/, '').trim().replace(/\['([^']+)'\]\s*:/, "'$1':") // ['key']: → 'key':（括号键与普通键同义）
    if (!line || line.startsWith('//')) continue
    const level = Math.floor((raw.length - raw.trimStart().length) / 2)
    // 关闭段落：缩进回退时弹栈（栈按 level-1 对齐）
    while (stack.length > level - 1 && stack.length > 0) stack.pop()
    const m = line.match(/^(?:'([^']+)'|([A-Za-z0-9_$-]+))\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1] ?? m[2]
    const rest = m[3].trim()
    if (rest === '{' || rest === '{,') {
      stack[level - 1] = key
      continue
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      keys.add([...stack, key].join('.'))
    }
  }
  return keys
}

// 文件包装（--self-test 以文本夹具直测同一解析核心）
function parseLocale(file) {
  return parseLocaleText(fs.readFileSync(file, 'utf-8'))
}

// ---------- t() key 提取 ----------
function listFiles(dir, exts, out = [], includeTests = false) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'locales') continue // locale 源文件自身不扫
      listFiles(p, exts, out, includeTests)
    } else if (exts.includes(path.extname(e.name)) && (includeTests || !e.name.endsWith('.test.ts'))) {
      out.push(p)
    }
  }
  return out
}

function extractUsedKeys() {
  const files = listFiles(SRC, ['.vue', '.ts'])
  const used = new Map() // key -> [file:line]
  let dynamic = 0
  const re = /(?<![\w.$])t\(\s*'([^']+)'\s*[,)]/g
  for (const f of files) {
    const rel = path.relative(root, f)
    const src = fs.readFileSync(f, 'utf-8')
    dynamic += (src.match(/t\(`/g) || []).length
    for (const m of src.matchAll(re)) {
      const key = m[1]
      const line = src.slice(0, m.index).split('\n').length
      if (!used.has(key)) used.set(key, [])
      used.get(key).push(`${rel}:${line}`)
    }
  }
  return { used, dynamic }
}

// ---------- --unused 死键检测（报告模式，恒退出 0，不进 check 链） ----------
// 死键 = 语言包有、源码已无引用的键。静态引用识别 t('key') / i18n.global.t('key')
// / $t('key')（t 前允许 . 方法链与 $ 前缀，但不允许属于更长标识符，split( 不误吞）。
// 动态构造按宁漏勿误排除：t(`前缀${x}`) 与 t('前缀' + x) 收字面前缀、t(x + '后缀')
// 收字面后缀；另扫源码任意位置「路径.${」形态的间接模板前缀（先拼进变量再 t 的写法，
// 如 DeployDialog 的 const key = `deploy.log.level.${level}`），凡以其开头的键同样视为
// 可能被引用。Go 后端经 WS/通知下发 messageKey/TitleKey 等**完整 i18n 键**由前端翻译
// （deploy 日志、agentcron/report/monitor 通知等），故反向扫描仓库 server/ 下 Go 源的
// 点分字符串字面量并入引用集（目录不存在时跳过，脚本可独立于仓库布局运行）。
// 全路径在源码任意位置出现但非 t() 直引的键
// （常量表间接消费，如 http.ts 的 KNOWN_ERROR_I18N / errorLabel）单独归入人工复核
// 清单而不判死；测试文件计入引用源（测试断言的键同样「有人用」）。
function extractUnused(locales) {
  const staticRe = /(?<![\w$])\.?\$?t\(\s*'([^']+)'\s*[,)]/g
  const fullTplRe = /(?<![\w$])\.?\$?t\(\s*`([^`$]+)`\s*[,)]/g // t(`纯字面`) 同静态
  const tplPrefixRe = /(?<![\w$])\.?\$?t\(\s*`([^`$]*)\$\{/g // t(`前缀${x}`)
  const concatPrefixRe = /(?<![\w$])\.?\$?t\(\s*'([^']+)'\s*\+/g // t('前缀' + x)
  const concatSuffixRe = /(?<![\w$])\.?\$?t\(\s*[^)'`+]+\+\s*'([^']+)'\s*[,)]/g // t(x + '后缀')
  const holePrefixRe = /([A-Za-z0-9_.$-]+\.)\$\{/g // 任意位置 `路径.${x}`——先拼变量再 t 的间接前缀
  const staticUsed = new Set()
  const prefixes = []
  const suffixes = []
  let dynamic = 0
  let allSrc = ''
  for (const f of listFiles(SRC, ['.vue', '.ts'], [], true)) {
    const src = fs.readFileSync(f, 'utf-8')
    allSrc += src + '\n'
    dynamic += (src.match(/t\(`/g) || []).length
    for (const re of [staticRe, fullTplRe]) {
      for (const m of src.matchAll(re)) staticUsed.add(m[1])
    }
    for (const m of src.matchAll(tplPrefixRe)) if (m[1]) prefixes.push(m[1])
    for (const m of src.matchAll(concatPrefixRe)) prefixes.push(m[1])
    for (const m of src.matchAll(concatSuffixRe)) suffixes.push(m[1])
    for (const m of src.matchAll(holePrefixRe)) prefixes.push(m[1])
  }
  // Go 后端下发的完整键（deploy 日志 messageKey、通知 TitleKey/BodyKey 等）并入引用集
  const serverDir = path.join(root, '..', 'server')
  if (fs.existsSync(serverDir)) {
    const goFiles = []
    ;(function walkGo(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walkGo(p)
        else if (e.name.endsWith('.go')) goFiles.push(p)
      }
    })(serverDir)
    for (const f of goFiles) {
      const src = fs.readFileSync(f, 'utf-8')
      for (const m of src.matchAll(/['"]([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+\.?)['"]/g)) {
        // 尾随点的字面量（如 "monitor.disk.notify."）是运行时拼接前缀，按动态前缀处理
        if (m[1].endsWith('.')) prefixes.push(m[1])
        else staticUsed.add(m[1])
      }
    }
  }
  const candidates = new Set([...locales['zh-CN'], ...locales['en-US']])
  const dead = []
  const review = []
  let dynamicExcluded = 0
  for (const key of candidates) {
    if (staticUsed.has(key)) continue
    if (prefixes.some((p) => key.startsWith(p)) || suffixes.some((s) => key.endsWith(s))) {
      dynamicExcluded++
      continue
    }
    ;(allSrc.includes(key) ? review : dead).push(key)
  }
  return { dead: dead.sort(), review: review.sort(), dynamic, dynamicExcluded, staticUsed: staticUsed.size }
}

// ---------- --audit 审计动作 ↔ audit.action 词条双向对账（P-20261004-144，契约闸门第五轴） ----------
// 双端契约：服务端动作常量（auditlog.go Audit* 块，块注释即约定「前端 i18n
// audit.action.<同 key> 一一对应」）× 前端 audit.action 子树叶子键。漏词条的
// 后果是审计面板永久显示原始点分串（AuditLogPane.actionLabel 未知动作回退原文），
// 静默降级无人知晓。check-locale-parity 只保证 zh/en 键结构相等，不保证覆盖
// 服务端常量，故以常量集为基准独立双向对账：常量无词条 ERROR（双语各报一份，
// 缺一即红）、词条无常量 WARN 孤儿死键（报告不阻断）。
const AUDIT_GO_FILE = path.join(root, '..', 'server', 'store', 'auditlog.go')
const AUDIT_KEY_PREFIX = 'audit.action.'
// 常量数下限守卫（防失明全绿）：auditlog.go 常量书写形式重排/正则失配时提取数
// 骤降，门禁必须红而不是空转放行。下限取现存量（49）留余量，常规新增不必动它
const AUDIT_MIN_ACTIONS = 40

// 提取 auditlog.go 中的动作常量：只认 Audit 前缀导出常量的字符串赋值形态
// （兼容 `const Name = "x"` 单行与类型声明形态），非动作常量双守卫排除——
// ① 名字 AuditResult* 前缀（结果三值走 audit.result.* 子树，与动作轴无关）；
// ② 值非点分式（marker/prefix 类杂项常量天然无点）。
// 正则锚定仓内 const 块书写惯例，auditlog.go 形式变更须同步本正则
function extractAuditActions(goSource) {
  const actions = new Map() // 点分值 → 常量名（报告可归因到注册点）
  for (const raw of goSource.split('\n')) {
    const line = raw.trim()
    const m = line.match(/^(?:const\s+)?(Audit[A-Za-z0-9_]*)\s*(?:[A-Za-z0-9_]*\s*)?=\s*"([A-Za-z0-9_.]+)"/)
    if (!m || m[1].startsWith('AuditResult') || !m[2].includes('.')) continue
    actions.set(m[2], m[1])
  }
  return actions
}

// 双向 diff：errors = 常量缺词条（阻断），warns = 词条无常量（孤儿死键，报告）
function auditDiff(actions, locales) {
  const errors = []
  const warns = []
  for (const [value, name] of [...actions].sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = AUDIT_KEY_PREFIX + value
    for (const [locale, keys] of Object.entries(locales)) {
      if (!keys.has(key)) errors.push({ locale, name, value, key })
    }
  }
  const constantKeys = new Set([...actions.keys()].map((v) => AUDIT_KEY_PREFIX + v))
  for (const [locale, keys] of Object.entries(locales)) {
    for (const key of [...keys].filter((k) => k.startsWith(AUDIT_KEY_PREFIX)).sort()) {
      if (!constantKeys.has(key)) warns.push({ locale, key })
    }
  }
  return { errors, warns }
}

// --self-test：文本夹具直测同一套解析与 diff 核心，不碰源码树
function runAuditSelfTest() {
  const goFixture = [
    'const (',
    '\tAuditResultSuccess = "success"',
    '\tAuditUnlock        = "lock.unlock"',
    '\tAuditShareView     = "share.view"',
    '\tAuditSomeMarker    = "sc-audit-prefix"',
    '\tsomeLocal          = "x.y"',
    ')',
    'const AuditSingle = "single.action"',
  ].join('\n')
  const localeFixture = `export default {
  audit: {
    action: {
      lock: {
        unlock: '解锁',
      },
      share: {
        view: '访客访问分享',
      },
      single: {
        action: '单行动作',
      },
    },
  },
}
`
  const zh = parseLocaleText(localeFixture)
  const en = parseLocaleText(localeFixture.replace('访客访问分享', 'Guest share visit'))
  let failed = 0
  const eq = (actual, expected, label) => {
    if (actual !== expected) {
      console.error(`  FAIL ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
      failed++
    } else {
      console.log(`  ok ${label}`)
    }
  }

  console.log('--self-test 审计动作对账夹具：')
  const actions = extractAuditActions(goFixture)
  eq(actions.size, 3, '常量提取数量（结果/非点分/非前缀三形态排除）')
  eq(actions.get('lock.unlock'), 'AuditUnlock', '点分值 → 常量名映射')
  eq(actions.get('single.action'), 'AuditSingle', '单行 const 形态收录')
  eq(actions.has('success'), false, 'AuditResult* 结果常量排除')
  eq(actions.has('sc-audit-prefix'), false, '非点分值常量排除')
  eq(actions.has('x.y'), false, '非 Audit 前缀标识符排除')
  eq(zh.has('audit.action.lock.unlock') && zh.has('audit.action.share.view'), true, 'locale 夹具叶子键点分展开')

  const full = { 'zh-CN': zh, 'en-US': en }
  const zhMissing = { 'zh-CN': new Set([...zh].filter((k) => k !== 'audit.action.share.view')), 'en-US': en }
  let r = auditDiff(actions, zhMissing)
  eq(r.errors.length, 1, '单侧缺词条报 1 错')
  eq(r.errors[0] && r.errors[0].locale, 'zh-CN', '缺词条归因到缺的语言')
  eq(r.errors[0] && r.errors[0].key, 'audit.action.share.view', '缺词条指明期望键')
  eq(r.warns.length, 0, '缺词条场景无孤儿告警')
  r = auditDiff(actions, { 'zh-CN': new Set([...full['zh-CN'], 'audit.action.legacy.dead']), 'en-US': new Set([...full['en-US'], 'audit.action.legacy.dead']) })
  eq(r.errors.length, 0, '词条超集场景无缺词条错')
  eq(r.warns.length, 2, '孤儿词条双语各报一份 WARN')
  r = auditDiff(actions, full)
  eq(r.errors.length + r.warns.length, 0, '双向对齐场景全绿')

  if (failed) {
    console.error(`--self-test ${failed} 处断言失败`)
    process.exit(1)
  }
  console.log('--self-test 全部通过')
}

// ---------- --errcodes 结构化错误码映射对账（P-20261005-153） ----------
// 双端契约：http.ts ERROR_CODE_I18N（code → i18n 键，前端 code 优先命中层的表）
// × 两路事实源——①映射值（i18n 键）在 zh/en locale 齐备（缺键 = code 命中后
// t() 静默回退键名原文）；②映射键（码）在 server/api/shared/errors.go 注册表
// 登记（错字/未落地码 = 永不命中的死映射，静默退回正则层——正是该提案要消灭
// 的形态）。方向②同判 ERROR 而非 WARN：monorepo 两端同仓同轮 check，正常新增
// 不存在窗口期，命中即 typo。与 check-errmarkers（P-29）分工不双份：那张守
// marker 文本 ↔ 正则匹配 + LocaleKey，这张守 code ↔ 键齐备性，两轴正交。
// Go 侧多码少映射不告警——ERROR_CODE_I18N 是有意的高频用户面子集（agent 面
// 码与带插值参数的码有意不收，理由见 http.ts 表头注记）。
const HTTP_TS_FILE = path.join(SRC, 'api', 'http.ts')
const ERRCODE_GO_FILE = path.join(root, '..', 'server', 'api', 'shared', 'errors.go')
// 数量下限守卫（防提取失明全绿，沿 AUDIT_MIN_ACTIONS 先例）：下限取现存量留余量，
// 常规新增不必动它
const MIN_ERR_MAPPINGS = 8

// 提取 http.ts 的 ERROR_CODE_I18N 表行：`'code': 'i18n.key',` 单行（注释行天然
// 不匹配；表起止锚定 export 声明与收尾花括号，形式变更须同步本提取器）
function extractErrorCodeMappings(src) {
  const rows = []
  let inTable = false
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('export const ERROR_CODE_I18N')) { inTable = true; continue }
    if (!inTable) continue
    if (line === '}' || line === '};') break
    const m = line.match(/^'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)'\s*:\s*'([^']+)'\s*,?$/)
    if (m) rows.push({ code: m[1], key: m[2] })
  }
  return rows
}

// 提取 shared/errors.go 的 ErrCode 常量值：`CodeXxx ErrCode = "domain.error"`
//（行内尾注释不影响；正则锚定仓内书写惯例，errors.go 形式变更须同步）
function extractGoErrCodes(goSource) {
  const codes = new Set()
  for (const raw of goSource.split('\n')) {
    const m = raw.match(/^\s*Code[A-Za-z0-9_]*\s+ErrCode\s*=\s+"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)"/)
    if (m) codes.add(m[1])
  }
  return codes
}

// 对账核心（--self-test 以夹具直测）：errors = 键缺词条 / 码未登记（均阻断）
function errcodeDiff(mappings, goCodes, locales) {
  const errors = []
  for (const { code, key } of mappings) {
    for (const [locale, keys] of Object.entries(locales)) {
      if (!keys.has(key)) errors.push({ kind: 'locale', code, key, locale })
    }
    if (!goCodes.has(code)) errors.push({ kind: 'registry', code, key })
  }
  return errors
}

// --self-test：文本夹具直测同一套提取与对账核心（红/绿三态），不碰源码树
function runErrcodesSelfTest() {
  const httpFixture = [
    'export const ERROR_CODE_I18N: Record<string, string> = {',
    "  'project.locked': 'errors.known.projectLocked',",
    "  'files.not_found': 'errors.known.fileNotFound',",
    '}',
  ].join('\n')
  const goFixture = [
    'const (',
    '\tCodeProjectLocked ErrCode = "project.locked" // 硬锁 403',
    '\tCodeFilesNotFound ErrCode = "files.not_found"',
    ')',
  ].join('\n')
  const localeFixture = `export default {
  errors: {
    known: {
      projectLocked: '项目已锁定',
      fileNotFound: '文件不存在',
    },
  },
}
`
  let failed = 0
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.error(`  FAIL ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
      failed++
    } else {
      console.log(`  ok ${label}`)
    }
  }

  console.log('--self-test 错误码映射对账夹具：')
  const mappings = extractErrorCodeMappings(httpFixture)
  eq(mappings.length, 2, '表行提取数（跳过声明行与收尾花括号）')
  eq(mappings[0], { code: 'project.locked', key: 'errors.known.projectLocked' }, 'code → 键映射行解析')
  const goCodes = extractGoErrCodes(goFixture)
  eq([...goCodes].sort(), ['files.not_found', 'project.locked'], 'Go 注册表码提取（含尾注释行）')

  const locales = { 'zh-CN': parseLocaleText(localeFixture), 'en-US': parseLocaleText(localeFixture) }
  eq(errcodeDiff(mappings, goCodes, locales).length, 0, '对齐场景零 ERROR')

  // 红①：en-US 缺词条（单侧缺失即红）
  const enMissing = { 'zh-CN': locales['zh-CN'], 'en-US': parseLocaleText(localeFixture.replace("      fileNotFound: '文件不存在',\n", '')) }
  let errs = errcodeDiff(mappings, goCodes, enMissing)
  eq(errs.length, 1, '单侧缺词条报 1 错')
  eq(errs[0] && errs[0].kind, 'locale', '缺词条归因 kind=locale')
  eq(errs[0] && errs[0].locale, 'en-US', '缺词条归因到缺的语言')

  // 红②：映射码不在 Go 注册表（typo 死映射即红）
  errs = errcodeDiff([{ code: 'project.lockd', key: 'errors.known.projectLocked' }], goCodes, locales)
  eq(errs.length, 1, '未登记码报 1 错')
  eq(errs[0] && errs[0].kind, 'registry', '未登记码归因 kind=registry')

  if (failed) {
    console.error(`--self-test ${failed} 处断言失败`)
    process.exit(1)
  }
  console.log('--self-test 全部通过')
}

// ---------- 硬编码颜色扫描（.vue <style> 内 hex/rgb，var(--x) 不算） ----------
function scanColors() {
  const files = listFiles(SRC, ['.vue'])
  const findings = []
  for (const f of files) {
    const rel = path.relative(root, f)
    const src = fs.readFileSync(f, 'utf-8')
    const styleStart = src.indexOf('<style')
    if (styleStart < 0) continue
    const style = src.slice(styleStart)
    for (const m of style.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)) {
      const line = style.slice(0, m.index).split('\n').length
      // var(--token, 兜底) 内的颜色在主题齐备时永不生效，与裸硬编码（真实
      // 违规，主题切换不动）风险不同——单独归类让报告可行动。
      // 兜底可以是多值阴影等复合值，逗号后不必然紧跟颜色——用括号栈判断
      // 匹配位置是否处于某个未闭合的 var( 内
      const before = style.slice(Math.max(0, m.index - 200), m.index)
      const stack = []
      for (const p of before.matchAll(/var\(|\(|\)/g)) {
        if (p[0] === ')') stack.pop()
        else stack.push(p[0])
      }
      const tag = stack.includes('var(') ? '  [var-fallback]' : ''
      findings.push(`${rel}:style+${line}: ${m[0]}${tag}`)
    }
  }
  return findings
}

// ---------- 主流程 ----------
if (COLORS_MODE) {
  const findings = scanColors()
  const bare = findings.filter((f) => !f.includes('[var-fallback]'))
  const fallbacks = findings.filter((f) => f.includes('[var-fallback]'))
  console.log(`硬编码颜色 ${findings.length} 处（裸硬编码 ${bare.length} | var 兜底 ${fallbacks.length}）`)
  if (bare.length) {
    console.log('裸硬编码（真实违规，需人工评估改主题令牌）：')
    for (const f of bare) console.log('  ' + f)
  }
  if (fallbacks.length) {
    console.log('var 兜底值（令牌缺省时的最后防线；同一令牌的兜底值应全仓一致）：')
    for (const f of fallbacks) console.log('  ' + f)
  }
  process.exit(0)
}

if (UNUSED_MODE) {
  const locales = Object.fromEntries(Object.entries(LOCALES).map(([k, v]) => [k, parseLocale(v)]))
  const { dead, review, dynamic, dynamicExcluded, staticUsed } = extractUnused(locales)
  console.log(`--unused 死键检测（报告模式，不阻断）：静态引用 key ${staticUsed} 个 | 动态模板 key ${dynamic} 处`)
  console.log(`动态/拼接构造排除 ${dynamicExcluded} 键（宁漏勿误）`)
  const bySection = (keys) => {
    const map = new Map()
    for (const k of keys) {
      const s = k.split('.')[0]
      if (!map.has(s)) map.set(s, [])
      map.get(s).push(k)
    }
    return map
  }
  if (dead.length) {
    console.log(`\n死键 ${dead.length} 个（静态引用零命中且全路径未在源码出现，删除前仍需逐键复核间接引用）：`)
    for (const [s, ks] of bySection(dead)) {
      console.log(`  [${s}] ${ks.length}`)
      for (const k of ks) console.log(`    ${k}`)
    }
  } else {
    console.log('\n死键 0 个')
  }
  if (review.length) {
    console.log(`\n需人工复核 ${review.length} 个（全路径在源码出现但非 t() 直引，常量表/间接拼接候选，脚本不判死）：`)
    for (const [s, ks] of bySection(review)) {
      console.log(`  [${s}] ${ks.length}`)
      for (const k of ks) console.log(`    ${k}`)
    }
  }
  process.exit(0)
}

if (AUDIT_MODE) {
  if (SELF_TEST_MODE) runAuditSelfTest()
  if (!fs.existsSync(AUDIT_GO_FILE)) {
    console.error(`审计动作对账：找不到常量源 ${AUDIT_GO_FILE}——auditlog.go 移动/重命名时同步本脚本路径`)
    process.exit(2)
  }
  const actions = extractAuditActions(fs.readFileSync(AUDIT_GO_FILE, 'utf-8'))
  if (actions.size < AUDIT_MIN_ACTIONS) {
    console.error(
      `审计动作对账：常量仅提取到 ${actions.size} 个（下限 ${AUDIT_MIN_ACTIONS}）——` +
        'auditlog.go 书写形式变更致正则失明空转，须同步 extractAuditActions 正则',
    )
    process.exit(1)
  }
  const locales = Object.fromEntries(Object.entries(LOCALES).map(([k, v]) => [k, parseLocale(v)]))
  const { errors, warns } = auditDiff(actions, locales)
  const countAction = (keys) => [...keys].filter((k) => k.startsWith(AUDIT_KEY_PREFIX)).length
  console.log(
    `审计动作 ↔ audit.action 词条对账：常量 ${actions.size} 个 | ` +
      `zh 词条 ${countAction(locales['zh-CN'])} | en 词条 ${countAction(locales['en-US'])}`,
  )
  if (errors.length) {
    console.log(`\n缺词条（ERROR，双语各报一份——parity 只保证 zh/en 相等，不保证覆盖常量）${errors.length} 处：`)
    for (const e of errors) console.log(`  [${e.locale}] ${e.name} = "${e.value}" → 期望 ${e.key}`)
  }
  if (warns.length) {
    console.log(`\n词条无常量（WARN 孤儿死键，报告不阻断；确认动作废弃则删词条，否则补常量）${warns.length} 个：`)
    for (const w of warns) console.log(`  [${w.locale}] ${w.key}`)
  }
  if (!errors.length && !warns.length) console.log('对账通过：常量 ↔ 双语词条一一对应，无孤儿词条')
  process.exit(errors.length ? 1 : 0)
}

if (ERRCODES_MODE) {
  if (SELF_TEST_MODE) runErrcodesSelfTest()
  if (!fs.existsSync(HTTP_TS_FILE) || !fs.existsSync(ERRCODE_GO_FILE)) {
    console.error(
      `错误码映射对账：找不到源文件 ${HTTP_TS_FILE} / ${ERRCODE_GO_FILE}` +
        '——http.ts 或 shared/errors.go 移动/重命名时同步本脚本路径',
    )
    process.exit(2)
  }
  const mappings = extractErrorCodeMappings(fs.readFileSync(HTTP_TS_FILE, 'utf-8'))
  if (mappings.length < MIN_ERR_MAPPINGS) {
    console.error(
      `错误码映射对账：映射仅提取到 ${mappings.length} 条（下限 ${MIN_ERR_MAPPINGS}）——` +
        'ERROR_CODE_I18N 书写形式变更致提取失明空转，须同步 extractErrorCodeMappings 正则',
    )
    process.exit(1)
  }
  const goCodes = extractGoErrCodes(fs.readFileSync(ERRCODE_GO_FILE, 'utf-8'))
  if (goCodes.size === 0) {
    console.error('错误码映射对账：Go 注册表 0 码——errors.go 书写形式变更致提取失明空转，须同步 extractGoErrCodes 正则')
    process.exit(1)
  }
  const locales = Object.fromEntries(Object.entries(LOCALES).map(([k, v]) => [k, parseLocale(v)]))
  const errors = errcodeDiff(mappings, goCodes, locales)
  console.log(`错误码映射对账：映射 ${mappings.length} 条 × Go 注册表 ${goCodes.size} 码（zh/en 词条齐备性随行校验）`)
  if (errors.length) {
    console.log(`\n对账失配（ERROR，必须修复）${errors.length} 处：`)
    for (const e of errors) {
      if (e.kind === 'locale') console.log(`  ✗ 映射 ${e.code} → ${e.key} 在 ${e.locale} locale 缺词条——缺键即 code 命中后回退键名原文`)
      else console.log(`  ✗ 映射 ${e.code} → ${e.key} 的码不在 server/api/shared/errors.go 注册表——typo 死映射，永不命中`)
    }
    process.exit(1)
  }
  console.log('错误码映射对账通过')
  process.exit(0)
}

const locales = Object.fromEntries(Object.entries(LOCALES).map(([k, v]) => [k, parseLocale(v)]))
const { used, dynamic } = extractUsedKeys()

let missing = 0
for (const [key, locs] of used) {
  for (const [locale, keys] of Object.entries(locales)) {
    if (!keys.has(key)) {
      // 已知豁免：运行时拼接的分类兜底 key（errors.${category}）逐类声明过
      missing++
      console.log(`缺失 [${locale}] ${key}\n    at ${locs.join('\n    at ')}`)
    }
  }
}
console.log(`\n使用 key: ${used.size}（动态模板 key: ${dynamic} 处不校验）`)
console.log(`zh-CN keys: ${locales['zh-CN'].size} | en-US keys: ${locales['en-US'].size}`)
if (missing > 0) {
  console.error(`\n共 ${missing} 处缺失`)
  process.exit(1)
}
console.log('i18n 校验通过')
