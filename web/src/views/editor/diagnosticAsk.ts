import type * as monacoNS from 'monaco-editor'
import type { useI18n } from '../../composables/useI18n'
import type { DiagnosticAskPayload } from '../../composables/useEditorAskAgent'
import {
  diagnosticSourceOf,
  normalizeDiagnosticCode,
  pickDiagnosticMarker,
} from '../../utils/editorProblems'
import { projectRelativePathFromUri } from './pathCompletion'

/**
 * 诊断「问智能体：解释此错误」（P-20261006-2）：Monaco code action provider
 * 形态注册——不覆写默认 marker hover 的消息展示，在 marker hover 与光标
 * lightbulb 共源的 quickfix 面挂入口。monaco 0.55.1 API 面核查结论（实施
 * 依据，动此处前先复核）：
 * - provideCodeActions 收到的 context 只有 { only, trigger }，context.markers
 *   不填充（esm/vs/editor/contrib/codeAction/browser/codeAction.js
 *   getCodeActions 构造处）——marker 归属由本模块经 getModelMarkers({ resource })
 *   自取后与请求 range 裁决（utils/editorProblems.pickDiagnosticMarker 三档优先序）
 * - code action 菜单项点击经 commandService.executeCommand 走**全局**
 *   CommandsRegistry——命令用 editor.addCommand(0, handler) 注册（keybinding 0
 *   仅表示无键位，decodeKeybinding 对 0 返回 null 不产键位规则）；handler 首参
 *   是 invokeFunction 注入的 accessor，载荷从第二参起
 * - registerCodeActionProvider 注册在 monaco.languages 全局面且不可按编辑器
 *   限定，而命令随编辑器实例生灭——故每个编辑器实例各注册一份 provider +
 *   命令，provider 以 model 守卫只答自己编辑器的当前模型（分屏双编辑器互不
 *   重复出动作），编辑器卸载时 provider 与命令同 dispose 无悬挂引用
 *
 * 路径语义复用 pathCompletion.projectRelativePathFromUri：非 file scheme
 * （diff 匿名模型）、远程伪路径、未命名草稿一律不产动作（询问链对无项目
 * 语义的模型无意义）。
 */
export function registerDiagnosticAsk(
  editor: monacoNS.editor.IStandaloneCodeEditor,
  monaco: typeof monacoNS,
  t: ReturnType<typeof useI18n>['t'],
  ask: (payload: DiagnosticAskPayload) => void,
): monacoNS.IDisposable {
  const commandId = editor.addCommand(0, (_accessor: unknown, payload: DiagnosticAskPayload) => {
    ask(payload)
  })
  if (!commandId) {
    // 键位服务缺位（本应用形态不会发生）：入口不可达就整段不注册，防菜单
    // 点击落 executeCommand "command not found" 的静默失败
    console.warn('diagnostic ask: editor command unavailable, skip code action registration')
    return { dispose() {} }
  }
  const empty: monacoNS.languages.CodeActionList = { actions: [], dispose() {} }
  return monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      try {
        // only 过滤（命令面板重构类请求只取声明 kinds 的动作）：quickfix
        // 层级不相交就不产动作，履行 provider 对 only 的契约语义
        if (context.only && !kindIntersectsQuickFix(context.only)) return empty
        if (model !== editor.getModel()) return empty
        const path = projectRelativePathFromUri(model.uri)
        if (!path) return empty
        const marker = pickDiagnosticMarker(monaco.editor.getModelMarkers({ resource: model.uri }), range)
        if (!marker) return empty
        const title = t('editor.ask.menuDiagnostic')
        const payload: DiagnosticAskPayload = {
          path,
          line: marker.startLineNumber,
          col: marker.startColumn,
          message: marker.message,
          code: normalizeDiagnosticCode(marker.code),
          source: diagnosticSourceOf(marker),
        }
        return {
          actions: [{
            title,
            kind: 'quickfix',
            diagnostics: [marker],
            command: { id: commandId, title, arguments: [payload] },
          }],
          dispose() {},
        }
      } catch {
        // worker 竞态等异常兜底空结果：询问是增益路径，不得打扰编辑器交互
        return empty
      }
    },
  }, { providedCodeActionKinds: ['quickfix'] })
}

/** context.only（单一 kind 串）与 quickfix 的层级相交判定：
 *  相等 / 任一为另一的前缀层级（'quickfix' ↔ 'quickfix.fix'）即相交 */
function kindIntersectsQuickFix(only: string): boolean {
  return only === 'quickfix' || only.startsWith('quickfix.') || 'quickfix'.startsWith(`${only}.`)
}
