// Monaco 视图状态跨 tab 保留缓存（模块级，按编辑器组分桶）
//
// 动机：undo 栈已由 monacoModelCache（模块级 LRU）精心保留，唯独视图状态
// （光标/选区/滚动）在每次 setModel 切 tab 时丢弃——重度用户在多文件间往返，
// 每次切回都光标回 1:1、滚动回顶。
//
// 为什么模块级而非组件级：新开文件走 loading 占位（EditorGroupPane 的
// v-if 分支）会把 MonacoEditor 整个卸载重挂，组件级 Map 随实例消亡，本轮
// 保存的全部快照丢失；模块级让快照跨 remount 存活——卸载前快照
// （onBeforeUnmount）+ 重挂/切回恢复（onMounted / path watcher）闭环。
//
// 为什么按组分桶（双组各持一份）：P-13 分屏后同一文件（共享同一 OpenFile
// 对象与同一 Monaco model）可同时挂在两组编辑器上，单一 Map 会让两组互相
// 恢复对方的位置（串位）——键为组号，组间天然隔离。
//
// 与 monacoModelCache 的联动：model 被 LRU 淘汰或随文件关闭 dispose 时，
// onWillDispose 钩子同步清掉各组对应快照，防死数据残留与过期位置恢复。
import type * as monaco from 'monaco-editor'

type ViewState = monaco.editor.ICodeEditorViewState

/** 组号 → (model URI → 视图状态快照)；双组 MVP 按需建桶 */
const stores = new Map<number, Map<string, ViewState>>()

function groupStore(gi: number): Map<string, ViewState> {
  let store = stores.get(gi)
  if (!store) {
    store = new Map()
    stores.set(gi, store)
  }
  return store
}

/** 已挂 dispose 清理钩子的 model：同一 model 反复挂上 editor（A→B→A 往返）
 *  不重复注册；WeakSet 不阻止 model 被淘汰后正常 GC */
const hookInstalled = new WeakSet<monaco.editor.ITextModel>()

function installDisposeHook(model: monaco.editor.ITextModel): void {
  if (hookInstalled.has(model)) return
  hookInstalled.add(model)
  model.onWillDispose(() => {
    // model 被淘汰/关闭销毁：清各组的快照（快照虽是纯数据，留着是死重量，
    // 且重开同路径新 model 时会试图恢复过期位置）
    const key = model.uri.toString()
    for (const store of stores.values()) store.delete(key)
  })
}

/** 切走/卸载前快照当前视图（光标+选区+滚动），以编辑器当前 model URI 为键
 *  存入 gi 组；model 已被 dispose（关 tab 时销毁先于组件卸载）则跳过 */
export function saveEditorViewState(gi: number, editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  if (!model || model.isDisposed()) return
  const state = editor.saveViewState()
  if (!state) return
  installDisposeHook(model)
  groupStore(gi).set(model.uri.toString(), state)
}

/** 切到/挂载后恢复 gi 组记录的视图状态；无记录（首次打开/已淘汰）为幂等 no-op */
export function restoreEditorViewState(gi: number, editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  if (!model) return
  const state = groupStore(gi).get(model.uri.toString())
  if (state) editor.restoreViewState(state)
}

/** 跨组移动 tab 时迁移视图快照（P-20261003-38）：源组桶中该 model 的记录原子
 *  搬到目标组桶——按组分桶的设计本意是双组并挂互不串位，移动场景快照应随签走
 *  （留在源组桶=死数据，目标组桶无记录=落地回顶部）。无记录幂等 no-op。
 *  uriKey 调用方经 moveMonacoViewStateBetweenGroups 注册表传入（monaco.Uri
 *  推导留在编辑器 chunk，键须与 saveEditorViewState 落下的 model.uri.toString()
 *  同构，见 MonacoEditor 的注册处） */
export function migrateEditorViewState(fromGi: number, toGi: number, uriKey: string): void {
  const src = stores.get(fromGi)
  const state = src?.get(uriKey)
  if (!src || !state) return
  src.delete(uriKey)
  groupStore(toGi).set(uriKey, state)
}

// ── 「复制引用（路径:行）」跨层读数口（P-20261006-17）──────────────
// tab 右键菜单（EditorGroupPane，主 chunk）要读任意非活动 tab 的最后已知光标
// 行，但快照键是 monaco.Uri.toString() 形态（路径含空格/CJK 时被百分号编码，
// 主 chunk 没有 monaco 无法复原同构键）——monacoViewStateMoves 同款注入注册
// 表：编辑器侧注册带 monaco.Uri 推导的实现，主 chunk 只碰本注册表。本模块对
// monaco 仅类型依赖（import type），主 chunk 导入不进编辑器 chunk。

/** 快照光标行读取实现：gi 组桶中该路径快照的最后已知光标行（无快照 undefined） */
export type ViewStateCursorLineReader = (gi: number, path: string) => number | undefined

let cursorLineReader: ViewStateCursorLineReader | null = null

/** 注册读取实现（MonacoEditor 挂载期调用，幂等覆盖；setMonacoViewStateMover
 *  同款——实现须为无实例状态的纯函数，注册不随组件作用域销毁） */
export function setViewStateCursorLineReader(fn: ViewStateCursorLineReader): void {
  cursorLineReader = fn
}

/** tab 右键「复制引用」取该文件最后已知光标行；未注册（编辑器 chunk 未加载/
 *  单测环境）= 无快照（未打开过内容，如刷新后未激活的恢复签）= undefined，
 *  调用方按无光标态降级纯路径 */
export function viewStateCursorLineOf(gi: number, path: string): number | undefined {
  try {
    return cursorLineReader?.(gi, path)
  } catch { /* 读数失败按无光标态降级，不阻断复制 */ }
  return undefined
}

/** 取 gi 组桶中 uriKey 快照的最后已知光标行：saveViewState 落下的可序列化公开
 *  形态 ICodeEditorViewState.cursorState[0].position（多光标取主光标），与切
 *  tab 恢复同源数据。仅编辑器 chunk 消费（注册 reader 时的键推导半段，
 *  MonacoEditor 经 monaco.Uri 合成 uriKey），主 chunk 一律走 viewStateCursorLineOf */
export function peekViewStateCursorLine(gi: number, uriKey: string): number | undefined {
  const pos = stores.get(gi)?.get(uriKey)?.cursorState[0]?.position
  return pos && pos.lineNumber >= 1 ? pos.lineNumber : undefined
}
