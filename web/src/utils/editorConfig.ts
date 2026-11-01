/**
 * .editorconfig 前端换算面（P-20261003-95）：项目级缩进约定进编辑器。
 *
 * 分工边界：INI 解析与节匹配在服务端（filepolicy/editorconfig.go），生效键
 * 子集随 file-policy 响应的 editorconfig 字段下发（打开链同点位零新增请求）；
 * 本模块只做「生效键 → Monaco model 缩进选项」的优先级合成——
 * editorconfig > 全局设置（font store），逐键独立覆盖。
 *
 * 纯函数零依赖（jsdom 直测）。Monaco 0.55 机制事实：缩进行为的权威真值是
 * model options（CursorConfiguration/ViewModel 均读 model.getOptions()），
 * per-file 约定落 model.updateOptions 才能按文件生效。
 */

/** 服务端 .editorconfig 生效键子集（file-policy 响应 editorconfig 字段；
 *  与后端 filepolicy.EditorConfig JSON 手工镜像，字段增删两侧同步；
 *  缺省/0 = 该键未约定） */
export interface EditorConfigEffective {
  indentStyle?: 'tab' | 'space'
  indentSize?: number
  tabWidth?: number
  endOfLine?: 'lf' | 'crlf' | 'cr'
}

/** Monaco model 缩进选项（model.updateOptions 接受形态） */
export interface IndentModelOptions {
  tabSize: number
  insertSpaces: boolean
}

/** 缩进宽度钳制界：与 Monaco model 侧 tabSize 合法域 1..100 同界，
 *  越界/非法值按未约定处理回落全局（服务端已钳一次，此处防御手改存储/旧对端） */
const TAB_SIZE_MIN = 1
const TAB_SIZE_MAX = 100

/**
 * editorconfig > 全局设置合成生效缩进选项：
 * - indent_style 命中即定 insertSpaces（tab → false / space → true）
 * - 缩进宽度 indent_size > tab_width（规范优先级；indent_size=tab 已由服务端
 *   折算 tab_width 下发）→ tabSize
 * - 逐键独立：只约定了 style 未约定宽度时宽度仍走全局，反之亦然；
 *   end_of_line 不在此换算——Monaco 模型 setEOL 会改写缓冲内容（文件变脏/
 *   干扰保存链），缩进遵循 MVP 不做隐式行尾改写
 */
export function resolveIndentOptions(global: IndentModelOptions, ec?: EditorConfigEffective | null): IndentModelOptions {
  const out: IndentModelOptions = { tabSize: global.tabSize, insertSpaces: global.insertSpaces }
  if (!ec) return out
  if (ec.indentStyle === 'tab') out.insertSpaces = false
  else if (ec.indentStyle === 'space') out.insertSpaces = true
  const width = positiveWithin(ec.indentSize) ?? positiveWithin(ec.tabWidth)
  if (width !== null) out.tabSize = width
  return out
}

function positiveWithin(n: number | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const r = Math.round(n)
  if (r < TAB_SIZE_MIN || r > TAB_SIZE_MAX) return null
  return r
}
