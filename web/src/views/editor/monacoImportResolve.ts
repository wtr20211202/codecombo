// 导入说明符解析纯函数（P-20261004-45 TS 项目上下文按需注入）
//
// 零依赖（不经 monaco、不经 store），jsdom 直测——pathCompletion 同款分层纪律。
// 职责两件事：
//  1. 从 import / require / 动态 import 形态的文本里提取模块说明符；
//  2. 把相对说明符按 TS 族扩展名探测序折叠为项目内真实文件路径（存在性 =
//     调用方注入的项目文件清单成员判定，不逐扩展名打 API——零 N+1）。
// MVP 诚实边界：裸包名（'vue'、'lodash'）与协议形态（node:fs、http://）一律
// 不可解析（返回 null），上层保持内建「找不到定义」原状不误开。

/** TS 族扩展名探测序：任务书「.ts/.tsx/.d.ts/index」——显式后缀 → 单文件三形
 *  → 目录 index 三形。.vue SFC / .js 不在列：SFC script 块非独立 TS model，
 *  注入也不会进 TS worker 上下文（MVP 边界由探测序自然收口） */
export const SPECIFIER_EXTENSIONS = ['.ts', '.tsx', '.d.ts'] as const
export const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.d.ts'] as const

/** spec 自带 TS 后缀的形态（import './x.ts'，TS 5 allowImportingTsExtensions
 *  之外罕见但零成本支持） */
const TS_SUFFIX_RE = /(?:\.d\.ts|\.tsx|\.ts)$/

/** 项目相对正斜杠路径的父目录；根级文件与项目根本身返回 ''（'' 即项目根）。
 *  与 pathCompletion.parentDir 同口径（各自零依赖，不互相拖拽依赖链） */
export function parentDir(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/** baseDir + 相对说明符折叠为项目内路径（解析 `.` / `..` 段；越出项目根返回
 *  null——说明符指向项目外，不属可注入面）。段间多余 / 与尾 / 自然收敛 */
export function resolveRelativeSpecifierPath(baseDir: string, spec: string): string | null {
  const out = baseDir ? baseDir.split('/') : []
  for (const seg of spec.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

// ── 说明符提取 ──
// 单行四形态（P-20261004-45 MVP 收敛）：from 'x'（静态 import/export...from）、
// import 'x'（副作用导入）、import('x')（动态）、require('x')。行内启发与
// pathCompletion.detectPathQuoteContext 同级（跨行模板串首行之外不探测）。

const LINE_SPEC_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])([^'"\n\r]+)\1/g,
  /\bimport\s*(['"])([^'"\n\r]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n\r]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"\n\r]+)\1\s*\)/g,
]

/** 提取一行文本里的全部模块说明符（按出现序去重；无命中返回空数组） */
export function extractImportSpecifiersFromLine(line: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const re of LINE_SPEC_PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const spec = m[2]
      if (spec && !seen.has(spec)) {
        seen.add(spec)
        found.push(spec)
      }
    }
  }
  return found
}

// 全文扫描 import 子句（含跨行花括号子句）：子句段不含引号/分号/圆括号且
// ≤200 字符——限定段长防注释/字符串里的游离 import 关键字拖出超远匹配
const IMPORT_CLAUSE_RE = /\bimport\s+(?:type\s+)?([A-Za-z0-9_$,\s{}*]{0,200}?)\s*\bfrom\s*(['"])([^'"\n\r]+)\2/g

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 全文找「import 子句包含该词」的语句，返回其说明符（首个命中；只服务
 *  F12 零结果路径——非热路径，全文正则一次可接受）。副作用导入（无子句）
 *  与 re-export 不在 MVP 扫描面 */
export function findImportSpecifierForWord(text: string, word: string): string | null {
  if (!word) return null
  const wordRe = new RegExp(`\\b${escapeRegExp(word)}\\b`)
  IMPORT_CLAUSE_RE.lastIndex = 0
  for (let m = IMPORT_CLAUSE_RE.exec(text); m; m = IMPORT_CLAUSE_RE.exec(text)) {
    if (wordRe.test(m[1] || '')) return m[3] || null
  }
  return null
}

/** 相对说明符 → 项目内真实路径（项目相对正斜杠口径）。
 *  @param currentFile 光标所在文件的项目相对路径（相对说明符的基准目录来源）
 *  @param spec 导入说明符（./ ../ / 开头的相对形态；反斜杠归一为正斜杠）
 *  @param fileSet 项目文件清单的路径集合（存在性判定，调用方注入以便测试）
 *  探测序：显式后缀（spec 自带 .ts/.tsx/.d.ts 时原样）→ +.ts/+.tsx/+.d.ts →
 *  /index.ts 三形。命中清单返回该路径；裸包名/越出项目根/全未命中返回 null */
export function resolveImportSpecifierPath(
  currentFile: string,
  spec: string,
  fileSet: ReadonlySet<string>,
): string | null {
  const s = spec.replace(/\\/g, '/').trim()
  if (!s) return null
  const isRootRelative = s.startsWith('/')
  const isSelfRelative = s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..'
  // 裸包名与协议形态（'vue'、'node:fs'、'http://…'）：MVP 不可解析边界
  if (!isRootRelative && !isSelfRelative) return null
  const baseDir = isRootRelative ? '' : parentDir(currentFile)
  const joined = resolveRelativeSpecifierPath(baseDir, s)
  if (joined === null || !joined) return null
  const candidates = [
    ...(TS_SUFFIX_RE.test(joined) ? [joined] : []),
    ...SPECIFIER_EXTENSIONS.map((ext) => joined + ext),
    ...INDEX_BASENAMES.map((idx) => `${joined}/${idx}`),
  ]
  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  return null
}
