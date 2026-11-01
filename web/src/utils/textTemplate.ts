// 文本模板插值工具：{参数名} 占位符的内联展开（P-20261002-123）。
// 纯字符串模板替换（等同 i18n 文案插值 / 表单插值），不涉及任何执行语义；
// 插值结果作为终端输入草稿展示给用户，由用户显式确认。
//
// 语法（按提案原文）：{name} 为占位符；{{ 字面转义输出单个 {（awk '{print $1}'
// 这类字面花括号命令靠它表达）。旧 {{name}} 双大括号形式继续按占位符识别，
// 兼容本特性之前已保存的片段数据——两者冲突时旧形式优先，因此「字面 {合法名}」
// 无法表达（现实命令里花括号内是裸标识符的情形可忽略）。
//
// 占位符名：unicode 字母/数字/下划线开头，组成字符再允许 . -（如 src、主机、
// file.txt）。不合名的花括号序列（${VAR}、{"k":v}、{{print $1}} 等）不是占位
// 符：单个 { 原样保留，{{…}} 整段按转义还原为 {…}——名称字符集收窄正是转义
// 语义能覆盖 awk/sed 类命令的前提。
//
// 纯函数：extractTemplateParams 提取按出现顺序去重的参数名，interpolateTemplate
// 按名插值（未填保留占位符原样）；两者共用 tokenizeTemplate 分词，语义不会漂移

const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u

type TemplateToken =
  | { kind: 'text'; text: string }
  | { kind: 'ph'; text: string; name: string }

/** 把模板切分为文本/占位符 token 流：{{name}} 双大括号优先识别（旧形式），
 *  其次 {{ 转义；单个 { 仅当紧跟合法占位符名+} 时成占位符，否则原样保留 */
function tokenizeTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  let lit = ''
  const pushLit = () => {
    if (lit) {
      tokens.push({ kind: 'text', text: lit })
      lit = ''
    }
  }
  let i = 0
  while (i < template.length) {
    if (template[i] !== '{') {
      lit += template[i]
      i++
      continue
    }
    if (template.startsWith('{{', i)) {
      const end = template.indexOf('}}', i + 2)
      if (end !== -1) {
        const content = template.slice(i + 2, end)
        const name = content.trim()
        if (NAME_RE.test(name)) {
          pushLit()
          tokens.push({ kind: 'ph', text: template.slice(i, end + 2), name })
          i = end + 2
          continue
        }
        lit += '{' + content + '}' // {{…}} 内容非占位符名：整段转义字面 → {…}（awk '{{print $1}}' → '{print $1}'）
        i = end + 2
        continue
      }
      lit += '{' // 未闭合的 {{xxx：转义 {，其余原样
      i += 2
      continue
    }
    // 单大括号 {name}；紧邻 $ 的 { 是 shell 变量语法（${VAR}）非占位符，
    // 否则最常用的 ${…} 引用会被误当参数要求填写
    const end = template.indexOf('}', i + 1)
    const raw = end === -1 ? '' : template.slice(i + 1, end)
    const name = raw.trim()
    const afterDollar = i > 0 && template[i - 1] === '$'
    if (!afterDollar && NAME_RE.test(name) && !raw.includes('{')) {
      pushLit()
      tokens.push({ kind: 'ph', text: template.slice(i, end + 1), name })
      i = end + 1
      continue
    }
    lit += '{'
    i++
  }
  pushLit()
  return tokens
}

/** 提取模板文本中按出现顺序去重的占位符参数名；无占位符返回空数组 */
export function extractTemplateParams(template: string): string[] {
  const names: string[] = []
  for (const tok of tokenizeTemplate(template)) {
    if (tok.kind === 'ph' && !names.includes(tok.name)) names.push(tok.name)
  }
  return names
}

/** 模板插值：把已填写的参数替换进文本；值为空白的参数保留占位符原样（不静默清空） */
export function interpolateTemplate(template: string, values: Record<string, string>): string {
  let out = ''
  for (const tok of tokenizeTemplate(template)) {
    if (tok.kind === 'text') {
      out += tok.text
      continue
    }
    const v = values[tok.name]
    out += v && v.trim() ? v : tok.text
  }
  return out
}
