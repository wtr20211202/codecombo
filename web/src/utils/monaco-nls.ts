// Monaco 官方本地化注入（monaco-editor README §Localization）：
// 在 monaco 主模块求值前加载官方语言包（esm/nls.messages.<locale>.js），
// 其会设置 globalThis._VSCODE_NLS_MESSAGES / _VSCODE_NLS_LANGUAGE，
// 内置右键菜单、查找替换、悬停提示等全部原生 UI 即随语言包本地化。
//
// 时序契约：本模块的 ensureMonacoNls() 必须先于任何 monaco 导入完成——
// 历史实现为 main.ts 顶层 await（首屏被 ~93KB 语言包阻塞）；现迁移为
// 与懒加载链耦合：EditorArea 的 defineAsyncComponent 先 await 本函数再
// import 编辑器组件，monaco 求值顺序不变，首屏零等待。
// 语言跟随调用时刻的 localStorage locale；monaco 仅在求值时读取一次，
// 运行中切换语言需刷新后生效（语义不变）。
//
// ⚠️ 新增 monaco 消费组件的唯一合法形态：safeAsync(() =>
// ensureMonacoNls().then(() => import('…编辑器组件.vue')))——任何对
// DiffEditor/MonacoEditor 的静态引入都会把 monaco 主模块的求值经静态
// 依赖边提前到语言包之前，MenuRegistry 描述符就地捕获英文字符串且不可逆
// （原生右键菜单永久英文化）。run20 曾因 TerminalCompareOutputModal 静态
// 引 DiffEditor 触发此形态（进项目页即拉起 3.6MB monaco 核心），二分误判
// 环境漂移——排查时优先核对新增的 monaco 静态依赖边。
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'

const MONACO_NLS_BY_LOCALE: Record<string, () => Promise<unknown>> = {
  'zh-CN': () => import('monaco-editor/esm/nls.messages.zh-cn.js'),
  'zh-TW': () => import('monaco-editor/esm/nls.messages.zh-tw.js'),
}

let pending: Promise<void> | null = null

/** 确保语言包已加载并完成注入（幂等，memoized）；须先于 monaco 求值 await */
export function ensureMonacoNls(): Promise<void> {
  if (!pending) {
    const appLocale = localStorage.getItem(LOCALE_STORAGE_KEY) || 'zh-CN'
    const loadNls = MONACO_NLS_BY_LOCALE[appLocale]
    pending = loadNls
      ? loadNls().then(() => undefined, () => undefined) // 语言包失败不阻断编辑器
      : Promise.resolve()
  }
  return pending
}
