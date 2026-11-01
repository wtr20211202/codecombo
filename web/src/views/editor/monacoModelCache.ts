// Monaco 模型跨实例保留缓存（模块级 LRU + 打开集保活）
//
// 历史问题：缓存放在 MonacoEditor 组件实例作用域内，组件卸载（切 tab /
// RouterView :key 整树 remount）时缓存随之消亡，但 model 本体仍留在
// monaco 全局注册表（全文 + undo 栈 + 分词数据）——每个打开过的文件
// 泄漏一个 model，永不释放。
//
// 模块级缓存让 LRU 淘汰真正生效（淘汰即 dispose），并把 model 生命周期
// 与组件实例解耦：实例切换后 undo 栈照样保留（顺手修复了原实现中
// "实例级缓存在 remount 后失效" 的缺陷）。
//
// 打开集保活（P-20261002-90）：纯 LRU 会把「已打开但未显示」tab 的 model
// 淘汰 dispose，切回该 tab 时整文件重新分词（偶发卡顿的显著来源）。淘汰
// 候选收敛为已关闭文件：打开集内的 model 免遭淘汰（分词结果 + undo 栈
// 常驻），关闭的文件正常 LRU。总量上限保留——候选耗尽（剩余全为打开集）
// 时放弃本轮淘汰、缓存暂超上限，总量仍被「打开 tab 数 + MODEL_CACHE_MAX」
// 封顶，不会无限增长。
import * as monaco from 'monaco-editor'
import { currentMonacoModelOpenPaths } from './monacoModelOpenSet'

interface CacheEntry { model: monaco.editor.ITextModel; at: number }

const cache = new Map<string, CacheEntry>()
const MODEL_CACHE_MAX = 8

/** 路径 → 缓存键：与 MonacoEditor 的 model URI 约定（file:///<path>）共用
 *  同一 monaco.Uri 推导，保证打开集比对与 retain 键控天然同构 */
function monacoModelCacheKey(path: string): string {
  return monaco.Uri.parse(`file:///${path}`).toString()
}

/** 当前打开集的缓存键视图（淘汰时现查现转：打开集随开/关动态变化） */
function openSetCacheKeys(): Set<string> {
  const keys = new Set<string>()
  for (const p of currentMonacoModelOpenPaths()) keys.add(monacoModelCacheKey(p))
  return keys
}

/** 按 URI key 取缓存模型（不改变 LRU 顺序，命中后由调用方 retain） */
export function getCachedMonacoModel(key: string): monaco.editor.ITextModel | undefined {
  return cache.get(key)?.model
}

/**
 * 保留模型进缓存（LRU，超限淘汰最久未用并 dispose；打开集内的条目免遭淘汰）。
 * @param attachedTo 当前仍挂在存活 editor 上的模型（淘汰命中它时只摘引用不销毁）
 */
export function retainMonacoModel(
  key: string,
  model: monaco.editor.ITextModel,
  attachedTo?: monaco.editor.ITextModel,
) {
  cache.set(key, { model, at: Date.now() })
  if (cache.size <= MODEL_CACHE_MAX) return
  const openKeys = openSetCacheKeys()
  let oldestKey = ''
  let oldestAt = Infinity
  for (const [k, v] of cache) {
    // 在挂模型与本次保留模型不做淘汰候选（沿用原 dispose 防御；改为跳过候选——
    // 原实现时间戳并列时会误删刚 refresh 的缓存条目）
    if (v.model === attachedTo || v.model === model) continue
    if (openKeys.has(k)) continue
    if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
  }
  // 候选耗尽（剩余全为打开集/在挂模型）：放弃本轮淘汰，缓存暂超上限
  if (!oldestKey) return
  cache.get(oldestKey)!.model.dispose()
  cache.delete(oldestKey)
}

/** 按URI key 主动销毁缓存模型（文件关闭时调用）；返回是否命中缓存 */
export function disposeCachedMonacoModel(key: string): boolean {
  const entry = cache.get(key)
  if (!entry) return false
  entry.model.dispose()
  cache.delete(key)
  return true
}

/** 测试隔离用：清空缓存（不 dispose，model 生命周期由调用方自持；
 *  resetForTest 先例：stores/terminal-sessions） */
export function resetMonacoModelCacheForTest(): void {
  cache.clear()
}
