// Monaco 语言 worker chunk 空闲预取（P-20261002-103）
//
// ts.worker/css.worker 走 monaco-env.ts 的 ?worker 导入，首个类型文件打开时
// （getWorker → new Worker）才拉取对应 chunk——慢网/远程形态下语法着色、诊断、
// 补全要现场等待。这里在 Layout 挂载后空闲时段低优先预取 worker chunk
// （fetch 落 HTTP 缓存，命中后 new Worker 即时就绪），不阻塞任何交互。
//
// URL 经 Vite 的 ?worker&url 导入从既有 monaco 导入链探测：同一入口文件的
// ?worker 与 ?worker&url 在 Vite 构建期解析到同一 worker 产物（vite:worker
// 插件按入口缓存 worker bundle），不硬编码带哈希文件名；且 ?worker&url 只导出
// URL 字符串，monaco 源码不进主包（EditorGroupPane 懒加载约束不破坏）。
import tsWorkerUrl from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker&url'
import cssWorkerUrl from 'monaco-editor/esm/vs/language/css/css.worker?worker&url'

// 空闲调度兜底时限：主线程持续繁忙时最长等 3s 也要触发（setTimeout 降级同值）
const IDLE_TIMEOUT_MS = 3000

let started = false

// 预取单个 chunk：失败静默——预取是纯增益，不能产生任何用户可见错误
function warm(url: string): void {
  // priority 为 fetch 的低优先提示（Chromium/Safari 已支持），不支持的浏览器
  // 忽略该项按默认优先级，无副作用
  void fetch(url, { priority: 'low' }).catch(() => {})
}

/** Layout 挂载后调用一次：空闲时预取 ts/css 语言 worker chunk；重复调用幂等
 *  （实例切换 remount 多次触发也只调度一轮，HTTP 缓存跨挂载有效） */
export function prefetchMonacoLanguageWorkers(): void {
  if (started) return
  started = true
  const warmAll = () => {
    warm(tsWorkerUrl)
    warm(cssWorkerUrl)
  }
  // rIC 不可用的环境（旧 Safari/jsdom）降级 setTimeout 3s
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(warmAll, { timeout: IDLE_TIMEOUT_MS })
  } else {
    setTimeout(warmAll, IDLE_TIMEOUT_MS)
  }
}
