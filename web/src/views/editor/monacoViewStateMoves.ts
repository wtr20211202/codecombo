// Monaco 视图快照跨组迁移的注入注册表（零依赖，monacoModelOpenSet 同款模式）
//
// 独立成零依赖模块的原因：跨组拖签移动（P-20261003-38）的编排在 useOpenFiles
//（组合式层，主 chunk），而快照桶与 monaco.Uri 键推导都在编辑器代码（静态依赖
// monaco-editor）——组合式层直接导入会把 monaco 拖进首屏 chunk（Monaco 懒加载
// 是 EditorGroupPane 的既有约束，monacoModelOpenSet 头注同因）。编辑器侧挂载时
// 注册实现，组合式侧只碰本注册表。

/** 迁移实现：把 fromGi 组桶中该路径 model 的视图快照搬到 toGi 组桶 */
export type ViewStateMover = (fromGi: number, toGi: number, path: string) => void

let mover: ViewStateMover | null = null

/** 注册迁移实现（MonacoEditor 挂载时调用，幂等覆盖）；传 null 注销。
 *  实现须为无实例状态的纯函数——本注册表不随组件作用域销毁 */
export function setMonacoViewStateMover(fn: ViewStateMover | null): void {
  mover = fn
}

/** 跨组移动 tab 时迁移视图快照；未注册（编辑器 chunk 未加载/单测环境）= 幂等
 *  no-op。迁移失败只降级为「目标组从顶部打开」，不影响 tab 移动本身 */
export function moveMonacoViewStateBetweenGroups(fromGi: number, toGi: number, path: string): void {
  try {
    mover?.(fromGi, toGi, path)
  } catch { /* 快照迁移失败不阻断移动 */ }
}
