// Monaco diff 模型对池（P-20261004-100 diff 标签切文件实例热切）
//
// 历史：DiffEditor 每次 model 对换代（切 diff tab / 内容刷新）都 createModel
// 全新一对并 dispose 旧对——大 diff 审阅（agent 批量改动的逐文件走查）在
// A→B→A 往返时每次都重新分词（大文件主线程数十~数百 ms 的可见卡顿），
// 重挂场景（diff↔普通文件切换）更连视图状态一起丢。
//
// 本池与 monacoModelCache（打开文件 LRU 8）/ monacoInjectedModels（TS 注入
// LRU 24）三分池独立、互不挤占：diff model 对是「两侧全文」级别的内存体，
// 审阅流一次迭代十几份 diff，若进共享 LRU 会把真实文件的 model（undo 栈/
// 分词）挤出缓存——注入池同款分池裁决（见 monacoInjectedModels 头注）。
// 池上限按「对」计（DIFF_MODEL_POOL_PAIRS=8 对 = 16 条目），淘汰即 dispose，
// 内存有界。
//
// 生命周期与引用计数：acquire 引用 +1（挂上 editor），release -1（换下/
// 卸载——model 留池复用而非销毁）；淘汰只清引用归零的条目，仍挂在任何
// 存活编辑器上的 model 永不做候选（同键双组共挂一 model 的引用计数护栏，
// 替代 monacoModelCache 的单 attachedTo 参数——diff 对是两 model 且可能
// 双组同挂）。onWillDispose 出池钩子：model 经任意路径 dispose（池淘汰/
// 外部清理）自动出池，池内不落 disposed 引用。
//
// 诚实边界：键 = diff 伪键（diff:<ref>:<ref>:<path>）+ 侧别 fragment，池不
// 感知项目上下文——跨项目同键残留的 model 由取用方内容对齐（setValue 兜底）
// 自愈，内存由 LRU 封顶；同键内容变化（剪贴板对比同键重开）同样走内容对齐。
// 同一伪键在不同 ref 内容下（HEAD 推进后重开同键由 openDiffView 去重不重取，
// 不经此池换代路径）不产生键碰撞。
import * as monaco from 'monaco-editor'

/** 池上限（按「对」计：两侧独立条目，总量 = ×2） */
export const DIFF_MODEL_POOL_PAIRS = 8

interface PoolEntry { model: monaco.editor.ITextModel; at: number; refs: number }

const pool = new Map<string, PoolEntry>()
// onWillDispose 出池钩子按 model 去重（同 model 反复 acquire 不重复挂；
// WeakSet 不阻止 model 被淘汰后正常 GC）
const disposeHookWired = new WeakSet<monaco.editor.ITextModel>()

/** diff 伪键 + 侧别 → model URI 键：专用 sc-diff scheme（非 file://）——池化后
 *  model 长存全局注册表，必须延续「diff model 不入项目路径寻址面」的既有不变量：
 *  问题面板聚合按 scheme==='file' 过滤（utils/editorProblems，匿名 inmemory 同款
 *  排除）、路径补全按 scheme!=='file' 短路（pathCompletion），file:// 伪 URI 会
 *  以 diff:HEAD:wt:... 幽灵分组漏进两者。侧别走 URI fragment——两侧独立入池
 *  （提案「左右两 model 独立入缓存」）。已知边界：伪键内含 '#'（Linux 文件名
 *  合法）会被 parse 归入 fragment——与 monacoModelCache 对文件名 '#' 同类限制，
 *  碰撞只发生在两个只读 diff 视图间且内容由对齐兜底 */
export function diffSideModelUriKey(diffKey: string, side: 'old' | 'mod'): string {
  return monaco.Uri.parse(`sc-diff:///${diffKey}#sc-diff-${side}`).toString()
}

function wireDisposeHook(uriKey: string, model: monaco.editor.ITextModel): void {
  if (disposeHookWired.has(model)) return
  disposeHookWired.add(model)
  model.onWillDispose(() => {
    pool.delete(uriKey)
  })
}

/** 取用一侧 model：池命中复用（内容对齐——池内残留与本次内容不一致时
 *  setValue 覆盖，剪贴板/冲突对比同键换内容的更新路径），未命中新建入池；
 *  引用 +1（挂上编辑器）。超限淘汰只清引用归零的最旧条目，候选耗尽（全部
 *  在挂）时放弃本轮淘汰（软上限，monacoModelCache 同款） */
export function acquireDiffModel(uriKey: string, language: string, content: string): monaco.editor.ITextModel {
  let entry = pool.get(uriKey)
  if (!entry || entry.model.isDisposed()) {
    // 全局注册表防御性复用（monacoModelCache 同款两段查询）：池外存活同键
    // model（理论不产生，防外部 createModel 撞 URI 抛错）
    const uri = monaco.Uri.parse(uriKey)
    let model = monaco.editor.getModel(uri) ?? undefined
    if (!model || model.isDisposed()) model = monaco.editor.createModel(content, language, uri)
    else if (model.getValue() !== content) model.setValue(content)
    entry = { model, at: Date.now(), refs: 0 }
    pool.set(uriKey, entry)
    wireDisposeHook(uriKey, model)
  } else if (entry.model.getValue() !== content) {
    entry.model.setValue(content)
  }
  entry.refs++
  entry.at = Date.now()
  evictIfNeeded(uriKey)
  return entry.model
}

/** 归还一侧 model：引用 -1，model 留池复用（往返免重新分词）而非销毁；
 *  生命周期归池管（淘汰时 dispose） */
export function releaseDiffModel(model: monaco.editor.ITextModel): void {
  for (const entry of pool.values()) {
    if (entry.model !== model) continue
    if (entry.refs > 0) entry.refs--
    return
  }
}

/** 超限淘汰：只清引用归零条目（在挂 model 不动——dispose 在挂 model 会腐蚀
 *  编辑器内部上下文，DiffEditor 既有释放次序注记同理）；候选耗尽放弃本轮 */
function evictIfNeeded(justAcquiredKey: string): void {
  if (pool.size <= DIFF_MODEL_POOL_PAIRS * 2) return
  let oldestKey = ''
  let oldestAt = Infinity
  for (const [k, v] of pool) {
    if (k === justAcquiredKey) continue
    if (v.refs > 0) continue
    if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
  }
  if (!oldestKey) return
  const entry = pool.get(oldestKey)!
  pool.delete(oldestKey)
  if (!entry.model.isDisposed()) entry.model.dispose()
}

// ── diff 视图状态（滚动/折叠/双侧视口）按伪键保留 ──────────────
// setModel 换代天然重置视图——「切回上次看过的 diff 不跳顶」需要显式快照。
// 与 monacoViewStateCache（普通编辑器 ICodeEditorViewState 按组分桶）平行：
// IDiffEditorViewState 是 diff 复合形态（双侧 state），键拼组号+项目+伪键
// （双组同键互不串位；项目段防跨项目同伪键恢复到错位内容），FIFO 封顶。
// 快照是纯数据不挂 model 生命周期——model 被淘汰后同键重开（内容未变）
// 恢复滚动依然正确（行号钳制由 Monaco 兜底），内容大改时最多恢复到邻近位。
type DiffViewState = monaco.editor.IDiffEditorViewState

const DIFF_VIEW_STATE_MAX = 48
const viewStates = new Map<string, DiffViewState>()

/** 视图状态键：组号 + 项目 + diff 伪键（projectId 由调用方传入，'' 允许——
 *  远程伪路径 diff 无项目上下文） */
export function diffViewStateKey(groupIndex: number, projectId: string, diffKey: string): string {
  return `${groupIndex}\u0000${projectId}\u0000${diffKey}`
}

/** 换代/卸载前快照当前视图（diffEditor.saveViewState() 的落位由调用方负责；
 *  该 API 可返回 null——无视图可存时静默跳过） */
export function saveDiffEditorViewState(stateKey: string, state: DiffViewState | null): void {
  if (!state) return
  viewStates.delete(stateKey) // 重写 = 提到队尾（FIFO 按最近使用保留）
  viewStates.set(stateKey, state)
  while (viewStates.size > DIFF_VIEW_STATE_MAX) {
    const oldest = viewStates.keys().next().value as string | undefined
    if (oldest === undefined) break
    viewStates.delete(oldest)
  }
}

/** 换代/重挂后取回快照（无记录 = no-op，Monaco 默认顶部）；记录保留供再次
 *  往返恢复，随 FIFO 封顶淘汰 */
export function peekDiffEditorViewState(stateKey: string): DiffViewState | undefined {
  return viewStates.get(stateKey)
}

/** 测试隔离用：清空池与视图状态（不 dispose，model 生命周期由调用方自持；
 *  resetMonacoModelCacheForTest 先例） */
export function resetDiffModelPoolForTest(): void {
  pool.clear()
  viewStates.clear()
}
