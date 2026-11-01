// 编辑器诊断聚合接线（P-20261003-297「问题面板」）
//
// 数据源是浏览器端 Monaco ts.worker 的运行态产物——服务端无此状态，纯前端
// 聚合不设 API 面（agent 需要权威类型检查走 npm run check 命令通道）。
//
// 分层与 monacoViewStateMoves 同款「编辑器 chunk 反向注册」模式：本模块不
// import monaco-editor（被 StatusBar 主包引用，不能拖编辑器 chunk 进主包），
// MonacoEditor.vue 挂载后把 monaco 命名空间回传 connectEditorProblems——
// 因此「从未打开过任何文件」时计数恒为 0 且不预载编辑器 chunk，打开首个
// 文件后徽标/面板自动激活。
//
// onDidChangeMarkers 打字/worker 计算期间高频触发，按提案口径 300ms 防抖
// （与 WS 事件客户端防抖同数量级）；聚合本身 O(n) 全量重算（markers 数
// = 打开文件数 × 诊断数，编辑器场景 < 数千，无增量必要）。
import { reactive, readonly } from 'vue'
import { aggregateProblems, type ProblemAggregate, type RawProblemMarker } from '../utils/editorProblems'

const DEBOUNCE_MS = 300

interface MonacoProblemsApi {
  editor: {
    onDidChangeMarkers(cb: (uris: readonly unknown[]) => void): { dispose(): void }
    getModelMarkers(params: { owner?: string; resource?: unknown; take?: number }): RawProblemMarker[]
  }
}

const state = reactive({
  aggregate: { groups: [], errorCount: 0, warningCount: 0, infoCount: 0, total: 0 } as ProblemAggregate,
})

let disposeMarkerListener: (() => void) | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function recalc(api: MonacoProblemsApi) {
  debounceTimer = null
  try {
    state.aggregate = aggregateProblems(api.editor.getModelMarkers({}))
  } catch { /* worker 竞态下 markers 取数失败：保留下一次变更事件重算 */ }
}

/** 编辑器 chunk 挂载后回传 monaco 命名空间完成接线；幂等（分屏双编辑器
 *  重复挂载/路由进出项目只注册一次监听），失败不抛出——徽标是增益不是关键路径 */
export function connectEditorProblems(api: MonacoProblemsApi): void {
  if (disposeMarkerListener) return
  try {
    const disposable = api.editor.onDidChangeMarkers(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => recalc(api), DEBOUNCE_MS)
    })
    if (!disposable || typeof disposable.dispose !== 'function') return
    disposeMarkerListener = () => disposable.dispose()
    recalc(api)
  } catch { disposeMarkerListener = null }
}

/** 供测试用：断开监听并清零聚合（生产代码不调用——监听随应用生命周期存活，
 *  模型关闭时 monaco 自行移除其 markers，下次变更事件全量重算自然对账） */
export function disconnectEditorProblems(): void {
  disposeMarkerListener?.()
  disposeMarkerListener = null
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  state.aggregate = { groups: [], errorCount: 0, warningCount: 0, infoCount: 0, total: 0 }
}

/** 只读视图：消费方（StatusBar 徽标 / ProblemsPanel 列表）拿到的代理始终
 *  指向 state 本体，整体替换 aggregate 不丢响应性；外部不得直接写 */
export function useEditorProblems() {
  return readonly(state)
}
