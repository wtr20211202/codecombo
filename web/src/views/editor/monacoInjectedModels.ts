// Monaco 注入模型池（P-20261004-45 TS 项目上下文按需注入）
//
// 跨文件跳转注入的 model 与 monacoModelCache（打开文件 LRU 8）分池独立：
// 打开集保活语义（分词/undo 常驻）属于用户打开的文件，注入池独立上限 24
// 互不挤占。淘汰即 dispose model——TS worker 的镜像随 onWillDispose 自动
// 摘除（$acceptRemovedModel），被淘汰文件的跳转/references 回到「找不到」
// 原状，内存由 LRU 封顶。
//
// 淘汰守卫与 monacoModelCache 同款两条：
//  ① 打开集（已开 tab）内的注入 model 免淘汰——tab 打开链（OPS_OPEN_FILE_AT
//     跳转路由）会把注入 model 挂上存活 editor，淘汰 dispose 会留 disposed
//     model 在编辑器上；
//  ② 本次保留的 model 不做候选（时间戳并列防误删刚 refresh 的条目）。
// 候选耗尽（剩余全为打开集）时放弃本轮淘汰（软上限）。
import * as monaco from 'monaco-editor'
import { currentMonacoModelOpenPaths } from './monacoModelOpenSet'

/** 注入池独立上限（与 monacoModelCache 的 MODEL_CACHE_MAX=8 分池不挤占） */
export const INJECTED_MODEL_MAX = 24

interface PoolEntry { model: monaco.editor.ITextModel; at: number }

const pool = new Map<string, PoolEntry>()
// onWillDispose 出池钩子按 model 去重（同 model 重复 retain 不重复挂）
const disposeHookWired = new WeakSet<monaco.editor.ITextModel>()

/** 路径 → 池键：与 MonacoEditor / monacoModelCache 的 URI 约定
 *  （file:///<path>）共用同一 monaco.Uri 推导 */
function injectedPoolKey(path: string): string {
  return monaco.Uri.parse(`file:///${path}`).toString()
}

/** 当前打开集的池键视图（淘汰时现查现转：打开集随开/关动态变化） */
function openSetPoolKeys(): Set<string> {
  const keys = new Set<string>()
  for (const p of currentMonacoModelOpenPaths()) keys.add(injectedPoolKey(p))
  return keys
}

/** 按 URI key 取池内模型（注入方先用 monaco.editor.getModel 全局注册表复用，
 *  此处主要供测试与防御性查询） */
export function getInjectedMonacoModel(uriKey: string): monaco.editor.ITextModel | undefined {
  return pool.get(uriKey)?.model
}

/** 保留注入模型进池（LRU，超限淘汰最久未用并 dispose） */
export function retainInjectedModel(uriKey: string, model: monaco.editor.ITextModel): void {
  if (!disposeHookWired.has(model)) {
    disposeHookWired.add(model)
    // model 经任意路径 dispose（tab 关闭链 MonacoEditor.disposeModel 命中全局
    // 注册表等）时自动出池——池内不落 disposed 引用，与打开链的销毁路径天然互斥
    model.onWillDispose(() => { pool.delete(uriKey) })
  }
  pool.set(uriKey, { model, at: Date.now() })
  if (pool.size <= INJECTED_MODEL_MAX) return
  const openKeys = openSetPoolKeys()
  let oldestKey = ''
  let oldestAt = Infinity
  for (const [k, v] of pool) {
    if (v.model === model) continue
    if (openKeys.has(k)) continue
    if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
  }
  // 候选耗尽（剩余全为打开集/本次条目）：放弃本轮淘汰，池暂超上限
  if (!oldestKey) return
  pool.get(oldestKey)!.model.dispose()
  pool.delete(oldestKey)
}

/** 项目切换清池（与 useOpenFiles 项目切换「清空打开文件」watcher 同拍）：注入
 *  模型属于项目上下文，路径在另一项目下同名异实，跨项目保留只会误导跳转。
 *  打开集内的条目跳过——归 openfiles 切换链管（同一事件里已先 dispose，出池
 *  钩子自然清账）；返回清掉的条目数（测试断言用） */
export function clearInjectedMonacoModels(): number {
  const openKeys = openSetPoolKeys()
  let cleared = 0
  for (const [k, entry] of [...pool]) {
    if (openKeys.has(k)) continue
    pool.delete(k)
    cleared++
    if (!entry.model.isDisposed()) entry.model.dispose()
  }
  return cleared
}

/** 测试隔离用：清空池（不 dispose，model 生命周期由调用方自持；
 *  resetMonacoModelCacheForTest 先例） */
export function resetInjectedMonacoModelsForTest(): void {
  pool.clear()
}
