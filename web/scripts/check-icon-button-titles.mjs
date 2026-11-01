#!/usr/bin/env node
// check-icon-button-titles.mjs —— vue 模板 icon-only 按钮微提示审计（title/aria-label 可访问名）
//
// 用法：
//   node scripts/check-icon-button-titles.mjs                    # 校验，基线外新增缺口退出码 1（存量债务按基线豁免）
//   node scripts/check-icon-button-titles.mjs --update-baseline  # 以当前全部缺口重写基线（治理流程专用）
//
// 说明（P-20261005-213）：
//   - 动机：裸 icon 按钮新手「这个图标是干嘛的」靠猜，屏幕阅读器用户零信息（aria-label 同缺）——
//     可发现性与无障碍双损失。icon-only 按钮（无文本子节点、仅图标 slot/子元素）必须携带
//     title（人类悬停提示）或 aria-label（辅助技术可访问名）至少其一。
//   - 识别面（双条件防误报，形态即 NButton/NIcon 组件形态 + 无文本子节点）：
//     ①按钮标签：<n-button>/<NButton>/<button>（含 v-if 等属性，引号感知取开标签）；
//     ②内容判空：剥非默认 slot 的 <template #xxx> 与全部标签/实体后无残留文本（{{ 插值 }} 算文本），
//       且曾有 #icon slot 或内含 <n-icon>/<NIcon>/<svg>/<img>/<i> 图标形态。
//     纯 loading 圈（无图标无文本）不算 icon-only；n-button-group 是容器不是按钮（词边界排除）。
//   - title 与 aria-label 双写的惯例缘由：title 悬停即知（人类），aria-label 供读屏（n-button 的
//     title 原样透传 DOM 但读屏对 title 支持不一致）；被 <n-tooltip> 包裹的按钮只补 aria-label——
//     tooltip 已是人类悬停提示，再写 title 会双气泡。
//   - 已知不识别面：非上述标签形态的自定义图标组件按钮、.ts 渲染函数（h()）里的按钮——模板层
//     审计为本分，出现时按需扩展识别面。
//   - 存量债务记入 scripts/icon-button-titles-baseline.json（键 = 「文件|行|标签」，值 = 豁免理由），
//     基线外新增即判失败防回潮；行号漂移会使条目 stale（提示移除重建），键含行号是刻意为之——
//     治理动作（补 title）就该让旧键失效。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const BASELINE = path.join(root, 'scripts', 'icon-button-titles-baseline.json')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')

const BUTTON_RE = /<(\/?)(n-button|NButton|button)(?![\w-])/g
// 可访问名属性：title / aria-label（含 :title / v-bind:title 动态绑定形态）；
// 前置 \s 防吃掉 data-title 等长尾属性名
const NAMED_ATTR_RE = /\s(?:v-bind:)?(?::)?(?:title|aria-label)\s*=/

function walkVueFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkVueFiles(p))
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

// 同长屏蔽：把 [s,e) 段换成空格（保留换行，行号不变）
function blankRange(text, s, e) {
  return text.slice(0, s) + text.slice(s, e).replace(/[^\n]/g, ' ') + text.slice(e)
}

// 从 from 起、引号感知地找开标签的 '>'，返回 { end（含 >）, selfClose }
function openTagEnd(text, from) {
  let inQuote = null
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") inQuote = c
    else if (c === '>') return { end: i + 1, selfClose: text[i - 1] === '/' }
  }
  return null
}

// 引号感知剥全部标签，返回剩余文本（插值 {{ }} 与裸文本保留）
function stripTags(html) {
  let out = ''
  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      const q = openTagEnd(html, i)
      if (!q) return out + html.slice(i) // 未闭合（模板残缺），原文兜底
      i = q.end
    } else {
      out += html[i]
      i++
    }
  }
  return out
}

// 剥非默认 slot 的 <template #xxx>…</template>（#default 与无名 template 保留），
// 返回 { inner, hadIconSlot }
function stripNamedSlotTemplates(inner) {
  let hadIconSlot = false
  const out = inner.replace(/<template[^>]*\s#\w[\w-]*[^>]*>[\s\S]*?<\/template>/g, (m) => {
    if (/#icon\b/.test(m)) hadIconSlot = true
    return ''
  })
  return { inner: out, hadIconSlot }
}

// 单文件审计，返回命中 [{ line, tag, snippet }]
function auditFile(text) {
  // 屏蔽 script/style 段与 HTML 注释（注释里的死代码按钮不入审计）
  let tpl = text
  for (const blockRe of [/<script[\s\S]*?<\/script>/g, /<style[\s\S]*?<\/style>/g, /<!--[\s\S]*?-->/g]) {
    for (const m of tpl.matchAll(blockRe)) tpl = blankRange(tpl, m.index, m.index + m[0].length)
  }
  const hits = []
  const stack = [] // { tag, innerStart, attrs, tagLine }
  const lineAt = (pos) => tpl.slice(0, pos).split('\n').length
  BUTTON_RE.lastIndex = 0
  let m
  while ((m = BUTTON_RE.exec(tpl)) !== null) {
    const [, slash, tag] = m
    if (slash) {
      // 关闭标签：弹栈（同名未配对/残缺模板容错跳过）
      const top = stack.length - 1
      if (top >= 0 && stack[top].tag === tag) {
        const el = stack.pop()
        if (el) hits.push(...judge(el, tpl.slice(el.innerStart, m.index), lineAt))
      }
      continue
    }
    const q = openTagEnd(tpl, m.index)
    if (!q) break
    if (!q.selfClose) {
      stack.push({ tag, innerStart: q.end, attrs: tpl.slice(m.index, q.end), tagLine: lineAt(m.index) })
    } else {
      hits.push(...judge({ tag, attrs: tpl.slice(m.index, q.end), tagLine: lineAt(m.index) }, '', lineAt))
    }
    BUTTON_RE.lastIndex = q.end
  }
  return hits
}

// 判定单个按钮元素是否 icon-only 缺可访问名
function judge(el, inner, lineAt) {
  const { inner: stripped, hadIconSlot } = stripNamedSlotTemplates(inner)
  const iconish = /<(?:n-icon|NIcon|svg|img|i)[\s>]/.test(stripped)
  const visibleText = stripTags(stripped).replace(/&[a-zA-Z]+;|&#\d+;/g, '').replace(/\s+/g, '')
  const iconOnly = visibleText === '' && (hadIconSlot || iconish)
  if (!iconOnly) return []
  const hasName = NAMED_ATTR_RE.test(el.attrs)
  if (hasName) return []
  return [{
    line: el.tagLine ?? lineAt(0),
    tag: el.tag,
    snippet: `${el.attrs.replace(/\s+/g, ' ').trim()} …`.slice(0, 90),
  }]
}

// ---------- 主流程 ----------
const files = walkVueFiles(SRC)
const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).entries
  : {}
const rows = [] // { level: fail|exempt|stale, key, rel, line, tag, snippet, reason }
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  for (const hit of auditFile(fs.readFileSync(file, 'utf-8'))) {
    const key = `${rel}|${hit.line}|${hit.tag}`
    const reason = baseline[key]
    if (reason === undefined) rows.push({ level: 'fail', key, rel, ...hit })
    else rows.push({ level: 'exempt', key, reason, rel, ...hit })
  }
}
for (const [key, reason] of Object.entries(baseline)) {
  if (!rows.some((r) => r.key === key)) rows.push({ level: 'stale', key, reason })
}

const ICON = { fail: '✗', exempt: '○', stale: '↑' }
for (const r of rows) {
  const loc = r.level === 'stale' ? r.key : `${r.rel}:${r.line}`
  const detail = r.level === 'stale' ? '已无命中，建议从基线移除' : `[${r.tag}] ${r.snippet}`
  console.log(`${ICON[r.level]} [${r.level.padEnd(6)}] ${loc.padEnd(58)} ${detail}`)
  if (r.reason) console.log(`           豁免理由：${r.reason}`)
}
const fails = rows.filter((r) => r.level === 'fail')
console.log(`\n审计 ${files.length} 个 vue 模板：icon-only 按钮缺 title/aria-label ${fails.length}，` +
  `基线豁免 ${rows.filter((r) => r.level === 'exempt').length}，已达标待移除 ${rows.filter((r) => r.level === 'stale').length}`)

if (UPDATE_BASELINE) {
  const doc = {
    _comment: 'icon-only 按钮缺 title/aria-label 基线：存量缺口豁免清单。键 = "文件|行|标签"，值 = 豁免理由；' +
      '补齐 title/aria-label 后删除对应条目。重建：npm run check:icon-titles -- --update-baseline',
    entries: Object.fromEntries(rows
      .filter((r) => r.level !== 'stale')
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => [r.key, r.reason ?? '存量豁免（待治理：补 title/aria-label 或补充豁免理由）'])),
  }
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
  console.log(`基线已重写：${path.relative(root, BASELINE)}（${Object.keys(doc.entries).length} 条）`)
} else if (fails.length > 0) {
  console.error('存在基线外 icon-only 按钮缺可访问名（防回潮），请补 title+aria-label（tooltip 包裹只补 aria-label）或更新基线并说明理由')
  process.exit(1)
}
