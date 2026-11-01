// Monaco 保存前格式化的跨层注册表（零依赖，monacoViewStateMoves 同款模式）
//
// 独立成零依赖模块的原因：保存链编排在 useOpenFiles（组合式层，主 chunk），而
// 「格式化文档」action 只存在于编辑器实例（静态依赖 monaco-editor）——组合式层
// 直接导入编辑器组件会把 monaco 拖进首屏 chunk（Monaco 懒加载是 EditorGroupPane
// 的既有约束，monacoViewStateMoves 头注同因）。编辑器侧挂载时注册实现，保存链
// 侧只碰本注册表。
//
// 「全部保存」格式化前置（P-20261004-139，对标 VS Code Save All 逐文件格式化）：
// saveAllFiles 串行链对每个脏文件保存前查表调用。开关/只读/编辑器在场判定封装
// 在编辑器侧实现内（与单文件链 formatThenSave 的格式化半段同一内聚），注册表
// 本身无策略；文件未在编辑器中显示（后台标签/diff 视图）= 无注册 = 不格式化
// 直接保存——格式化动作只对可见编辑器承诺（与单文件链同口径）。

/** 编辑器侧格式化实现：执行内建「格式化文档」。开关关闭/只读态/无 formatter
 *  语言 = 幂等 no-op（同单文件保存链静默跳过语义）；失败在实现内降级不抛出 */
export type EditorFormatter = () => Promise<void>

/** path → 实现集：同路径双组各挂一个编辑器实例（分屏同文件），Set 按实现身份
 *  去重收集——两实例共享同一 monaco model（monacoModelCache 按路径缓存复用），
 *  任一实例格式化等效；一组的实现换签/卸载摘除自身后另一组的实现仍在册 */
const formatters = new Map<string, Set<EditorFormatter>>()

/** 注册实现（MonacoEditor 挂载/换签时调用）；同实现重复注册幂等（Set 语义） */
export function registerEditorFormatter(path: string, format: EditorFormatter): void {
  let set = formatters.get(path)
  if (!set) {
    set = new Set()
    formatters.set(path, set)
  }
  set.add(format)
}

/** 注销实现（MonacoEditor 换签/卸载时调用）：按实现身份摘除，双宿主同路径时
 *  只摘自己那份不误删他组实现（卸载必注销防泄漏的 ownership 比对）；集合空则
 *  整键摘除防 Map 无界增长 */
export function unregisterEditorFormatter(path: string, format: EditorFormatter): void {
  const set = formatters.get(path)
  if (!set) return
  set.delete(format)
  if (set.size === 0) formatters.delete(path)
}

/** 保存链查询调用：无注册实现（文件未在可见编辑器中/编辑器 chunk 未加载/
 *  单测环境）= 幂等 no-op；实现抛错在此兜住（不阻断保存链）——与单文件链
 *  「格式化失败降级直接保存」同语义 */
export async function runEditorFormatter(path: string): Promise<void> {
  const format = formatters.get(path)?.values().next().value
  if (!format) return
  try {
    await format()
  } catch { /* 格式化失败降级直接保存（Console 痕迹在实现内），不阻断保存 */ }
}
