// Monaco model 缓存「打开集保活」的注入注册表（零依赖）
//
// 独立于 monacoModelCache 成模块的原因：monacoModelCache 静态依赖
// monaco-editor（Uri 键推导），而 useLayoutShell 等主包代码需要静态导入本
// 注册表来完成注入——直接导缓存模块会把 monaco-editor 拖进首屏 chunk
//（Monaco 懒加载是 EditorGroupPane 的既有约束）。
//
// 缓存层在 LRU 淘汰时经此询问「当前打开文件路径集」，路径集内的 model
// 免遭淘汰（P-20261002-90）；未注册时返回空集，缓存退化为纯 LRU 原行为。

/** 打开文件路径集提供者：每次淘汰时现查（打开集随开/关动态变化，不做快照缓存） */
export type MonacoModelOpenPathProvider = () => ReadonlySet<string>

let openPathProvider: MonacoModelOpenPathProvider | null = null

const EMPTY_PATHS: ReadonlySet<string> = new Set()

/** 注册打开集提供者（useLayoutShell 装配时调用）；重复注册以最后一次为准
 *  （Layout remount 换新 shell 作用域，旧注册随之被顶替） */
export function setMonacoModelOpenPathProvider(provider: MonacoModelOpenPathProvider): void {
  openPathProvider = provider
}

/** 注销提供者（宿主作用域销毁时调用，防陈旧闭包跨实例残留） */
export function clearMonacoModelOpenPathProvider(): void {
  openPathProvider = null
}

/** 当前打开文件路径集；未注册 = 空集 */
export function currentMonacoModelOpenPaths(): ReadonlySet<string> {
  return openPathProvider ? openPathProvider() : EMPTY_PATHS
}
