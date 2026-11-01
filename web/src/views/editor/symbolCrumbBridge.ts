// 面包屑符号段数据源桥（P-20261005-195）：按模型收集 DocumentSymbol 树 +
// 按光标行归属出祖先链，载荷上抛宿主（MonacoEditor emit → EditorGroupPane →
// Breadcrumb 符号段）。本模块随编辑器 chunk 加载（MonacoEditor 静态引入），
// 不触碰懒加载约束。
//
// 收集通道（版本适配，任务书原锚「DocumentSymbolProviderRegistry」在
// monaco-editor 0.55.x 已不存在——符号 provider 注册表内化为
// ILanguageFeaturesService.documentSymbolProvider，公开稳定面是 VS Code 内建
// 命令 `_executeDocumentSymbolProvider`（contrib/documentSymbols 注册，经
// IOutlineModelService 按模型 versionId LRU 缓存，命中缓存零 provider 往返）。
// 经 StandaloneServices.get(ICommandService) 直调拿返回值——editor.trigger
// 同命令会丢弃返回值不可用。TS/JS/JSON/HTML/CSS 内建语言即刻有 provider；
// basic-languages 族（Go 等）无 provider → 命令 resolve 空 → 空链上抛，
// UI 不显示空段（语言覆盖硬约束如实限定，零降级）。
//
// 节流护栏两段式：内容变更 → 去抖重收集（provider 往返是成本所在，键入期
// 不逐击键重跑）；光标移动 → 只从缓存树 O(深度×log n) 重算归属（纯读，
// 与 Ln/Col 徽标同量级，无计时器）。
import type * as monaco from 'monaco-editor'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { ICommandService, type CommandServiceLike } from 'monaco-editor/esm/vs/platform/commands/common/commands.js'
import { ILanguageFeaturesService, type LanguageFeaturesServiceLike } from 'monaco-editor/esm/vs/editor/common/services/languageFeatures.js'
import {
  symbolChainAtLine, symbolSiblingsOf, toCrumbRefs, toCrumbSymbols,
  type CrumbSymbol, type DocumentSymbolLite,
} from '../../utils/symbolCrumb'

/** 面包屑符号段载荷：path 自描述（宿主按 path 对位当前 tab，防切签窗口期
 *  陈旧串显——@cursor 载荷 P-20261004-141 同款口径）；chain 空 = 无符号段 */
export interface SymbolCrumbPayload {
  path: string
  chain: { name: string; kind: number; line: number }[]
  siblings: { name: string; kind: number; line: number }[]
}

/** 内容变更后重收集去抖：provider 往返（TS worker 导航树）数百微秒~毫秒级，
 *  键入期 500ms 静默后一次收集足够跟进 */
const RECOLLECT_DEBOUNCE_MS = 500

export function createSymbolCrumbBridge(opts: {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
  emit: (payload: SymbolCrumbPayload) => void
}) {
  let roots: CrumbSymbol[] = []
  // 过期守卫：换签/重收集后到期的在途收集一律丢弃（async 竞态比乱序串显更糟）
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 从缓存树按当前光标行归属并上抛（光标移动/收集完成的统一出口） */
  function computeAndEmit() {
    const editor = opts.getEditor()
    const pos = editor?.getPosition()
    const path = opts.getPath()
    if (!editor || !pos || !path) return
    const chain = symbolChainAtLine(roots, pos.lineNumber)
    opts.emit({
      path,
      chain: toCrumbRefs(chain),
      siblings: toCrumbRefs(symbolSiblingsOf(roots, chain)),
    })
  }

  /** 内容变更：去抖后重收集（符号行号随编辑漂移） */
  function scheduleRefresh() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void collect()
    }, RECOLLECT_DEBOUNCE_MS)
  }

  // 语言服务惰性激活的权威重触发：TS 等模式在模型创建后才异步完成激活并注册
  // symbol provider——首挂紧跟模型创建的收集会扑空拿到空树（probe 实测），
  // 注册表一变（激活完成）即补一次去抖收集，空段窗口收敛到激活耗时
  const registryChangeSub = StandaloneServices
    .get<LanguageFeaturesServiceLike>(ILanguageFeaturesService)
    .documentSymbolProvider.onDidChange(() => scheduleRefresh())

  /** 收集当前模型符号树（命令返回顶层 DocumentSymbol[]，children 嵌套保留） */
  async function collect() {
    const editor = opts.getEditor()
    const model = editor?.getModel()
    if (!editor || !model) return
    const mySeq = ++seq
    let next: CrumbSymbol[]
    try {
      const res: unknown = await StandaloneServices.get<CommandServiceLike>(ICommandService)
        .executeCommand('_executeDocumentSymbolProvider', model.uri)
      next = toCrumbSymbols(Array.isArray(res) ? (res as DocumentSymbolLite[]) : [])
    } catch {
      next = [] // provider 异常/无命令 = 空链（UI 不显示空段，零降级）
    }
    if (mySeq !== seq) return // 收集期间已换签/再收集：丢弃过期树
    roots = next
    computeAndEmit()
  }

  return {
    /** 模型切换（首挂/换签）：立即上抛空链清掉旧文件符号段，再异步收集 */
    onModelSwitched() {
      seq++
      if (timer) { clearTimeout(timer); timer = null }
      roots = []
      const path = opts.getPath()
      if (path) opts.emit({ path, chain: [], siblings: [] })
      void collect()
    },
    /** 内容变更：去抖后重收集（符号行号随编辑漂移；语言服务激活完成同样经此） */
    scheduleRefresh,
    /** 光标移动：缓存树上重算归属（无 provider 往返，免节流计时器） */
    onCursorMoved: computeAndEmit,
    dispose() {
      seq++
      if (timer) { clearTimeout(timer); timer = null }
      registryChangeSub.dispose()
      roots = []
    },
  }
}
