// TS 项目上下文按需注入（P-20261004-45）
//
// 动机：standalone Monaco 的 TS worker 项目上下文 = 已注册 model 集（worker 侧
// `getScriptFileNames()` 即镜像模型清单、`fileExists()` 也只认镜像），而 model 域
// 只有打开过的文件——import 了未打开文件时 F12「找不到定义」、references 残缺。
// 本模块在跳转零结果时按导入说明符把目标文件拉进 model 域，解锁跨文件
// definition / references（自动生效，settings 无新增）。
//
// 关键机制事实（monaco 0.55 源码核过）：
//  ① worker 对「使用处符号 = 未解析导入别名」返回的定义不是目标声明，而是本
//     文件导入子句里的别名位（kind 'alias' + failedAliasResolution）——直接问
//     worker 判「有没有结果」恒非空，必须过滤掉伪定义才算零结果；
//  ② 注入（createModel + wfn(uri) 同步进 worker 镜像）后重问即得真定义，无需
//     等待程序重算（retry 窗口仅作兜底）；
//  ③ 内建 F12 action 的结果来自 provider 注册表合并——别名伪定义 + 注入真定义
//     并存时会落入 peek 行为而不是直接跳转；且 standalone 对「非当前 model」的
//     openCodeEditor 默认 no-op（findModel 只认 source 当前 model）。因此 definition
//     侧用「editor.addAction 同键位后注册覆盖」（KeybindingResolver._findCommand
//     从后往前取候选，后注册者胜）接管 F12：真定义已可解析时原样让位内建 action
//     （既有行为零变化），伪定义/零结果才走「解析导入 → 注入 → 重问 → 直接派发
//     OPS_OPEN_FILE_AT 既有『打开文件+行定位』链」（注入即打开语义，不依赖合并
//     注册表）；references 侧同键位接管，注入成功后转交内建 references 面板
//     （其注册表重问时镜像已含目标文件，peek 即跨文件完整）。
//  ④ definition/references provider 增补保留（typescript/javascript 各自独立
//     worker 按 model 语言取用）：服务 Ctrl+click 跳转（goToDefinitionAtPosition
//     走注册表）——先问 worker 有真定义直返空让位防重复条目，伪定义/零结果才
//     注入并回真位置；peek 内跨文件条目点击经 registerEditorOpener 路由开 tab。
//
// 编辑器 chunk 反向注册接线（同 useEditorProblems / pathCompletion /
// monacoViewStateMoves）：connectEditorProjectContext 挂全局面（opener/provider/
// 项目切换清池，幂等单例），attachEditorProjectContext 挂每编辑器实例键位。
// 本模块只被 MonacoEditor.vue 引入（编辑器 chunk 内），monaco-editor 静态导入
// 不影响首屏 chunk（EditorGroupPane 懒加载约束以调用方为界）。
//
// 诚实边界（MVP，任务书③）：只解锁跳转/references，跨文件诊断（全量 include
// 注册）不做；相对路径形态（./ ../ /），裸包名/协议形态不解析，保持内建现状
// 不误开；lib.d.ts（file:///lib.*）条目不入路由防误开项目文件占位 tab；Vue SFC
// script 块与 Go 等其他语言不在本条（探测序只含 TS 族扩展名自然收口）。内存
// 上限由注入池 LRU 封顶（monacoInjectedModels，独立 24 与打开集分池互不挤占；
// 项目切换同拍清池）。
import { effectScope, watch } from 'vue'
import * as monaco from 'monaco-editor'
import i18n from '../../i18n'
import { useProjectStore } from '../../stores/project'
import { collectProjectFileList } from '../../composables/projectFileList'
import { projectApi } from '../../api/domains/git'
import { getLanguageByPath } from '../../utils/git'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import { projectRelativePathFromUri } from './pathCompletion'
import {
  extractImportSpecifiersFromLine,
  findImportSpecifierForWord,
  resolveImportSpecifierPath,
} from './monacoImportResolve'
import { retainInjectedModel, clearInjectedMonacoModels } from './monacoInjectedModels'

// ── TS worker 访问（结构化接口收窄类型缺口）──
// monaco 0.55 起 languages.typescript 的 .d.ts 标记 deprecated（运行时命名空间
// 仍在：editor.main.js `monacoApi.languages.typescript = monaco_contribution`）。
// 按 CLAUDE.md 类型缺口纪律用结构化接口取用，不落 any 直通
interface TsWorkerEntry {
  fileName?: string
  textSpan?: { start?: number; length?: number }
  kind?: string
  failedAliasResolution?: boolean
}
interface TsWorkerClient {
  getDefinitionAtPosition(fileName: string, position: number): Promise<TsWorkerEntry[] | undefined>
  getReferencesAtPosition(fileName: string, position: number): Promise<TsWorkerEntry[] | undefined>
}
type TsWorkerAccessor = (...uris: monaco.Uri[]) => Promise<TsWorkerClient>

/** 导航种类（键位接管链的用户视角命名；worker 问询名见 WorkerAskFn） */
type NavKind = 'definitions' | 'references'
type WorkerAskFn = 'getDefinitionAtPosition' | 'getReferencesAtPosition'

/** 按语言取对应 worker 访问器：typescript/javascript 各有独立 worker 实例
 *  （workerManager 按 modeId 分例），注入与重问必须落在内建 provider 同一个
 *  worker 里——错例（js 模型注入进 TS worker）会让 js 侧内建 provider 恒空而
 *  预问恒真，第二次跳转起零增益。取不到（TS 语言面未装配）返回 null */
async function workerAccessorFor(languageId: string): Promise<TsWorkerAccessor | null> {
  const ns = (monaco.languages as unknown as {
    typescript?: {
      getTypeScriptWorker?: () => Promise<TsWorkerAccessor>
      getJavaScriptWorker?: () => Promise<TsWorkerAccessor>
    }
  }).typescript
  if (!ns) return null
  const pick = languageId === 'javascript' ? ns.getJavaScriptWorker : ns.getTypeScriptWorker
  if (!pick) return null
  try {
    return await pick.call(ns)
  } catch {
    return null
  }
}

// ── 模块状态（编辑器 chunk 单例，随应用生命周期存活——useEditorProblems 同姿态）──

let registered = false
// 注入去重：同目标文件并发注入共享同一 promise（F12 连按/Ctrl+click 同拍不重复拉取）
const inflightInjections = new Map<string, Promise<monaco.editor.ITextModel | null>>()

/** 注入后 worker 重问的受限重试窗口：实测首问即中（注入同步后程序立即可解），
 *  窗口仅兜 worker 冷启动抖动——200/400ms 各补问一次，只发生在注入路径 */
const RETRY_DELAYS_MS = [200, 400]

/** 注入内容上限：与 useOpenFiles 大文件守卫同值（8_000_000）——超大 TS 文件
 *  分词/镜像成本远超跳转收益，诚实放弃 */
const INJECT_MAX_CONTENT_LENGTH = 8_000_000

/** 编辑器 chunk 首次挂载接线（幂等：MonacoEditor 每次实例化都调用，opener/
 *  provider 全局只注册一份，项目切换 watch 只挂一次） */
export function connectEditorProjectContext(editorMonaco: typeof monaco): void {
  if (registered) return
  registered = true
  wireJumpOpener(editorMonaco)
  wireInjectProviders(editorMonaco)
  wireProjectSwitchCleanup()
}

/** 每编辑器实例接线（MonacoEditor onMounted 调用）：F12 / Shift+F12 键位接管。
 *  同键位后注册者胜（KeybindingResolver._findCommand 从后往前取候选），内建
 *  action 在命令面板仍可达，仅键位走本接管链 */
export function attachEditorProjectContext(editorMonaco: monaco.editor.IStandaloneCodeEditor): void {
  const t = i18n.global.t
  editorMonaco.addAction({
    id: 'sc-goto.reveal-definition',
    label: t('keymap.inv.editorGotoDefinition'),
    keybindings: [monaco.KeyCode.F12],
    run: () => { void runNavigationWithInjection(editorMonaco, 'definitions') },
  })
  editorMonaco.addAction({
    id: 'sc-goto.go-to-references',
    label: t('keymap.inv.editorGotoReferences'),
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    run: () => { void runNavigationWithInjection(editorMonaco, 'references') },
  })
}

// ── ① 跨资源跳转路由（peek 条目点击 / 内建跳转的非当前 model 落地）──

/** monaco TS lib 的 project 相对形态（LibFiles isLibFile 同判：uri.path 以 /lib.
 *  开头）。跳转到 lib.d.ts（如 Promise）的条目保持内建原状（standalone 默认
 *  no-op）——误路由会把 lib 文件当项目文件打开出错误占位 tab。真实项目文件以
 *  lib. 开头且 .d.ts 结尾属极端巧合，代价只是该文件的跳转维持原状 */
function isMonacoTsLibPath(projectPath: string): boolean {
  return projectPath.startsWith('lib.') && projectPath.endsWith('.d.ts')
}

function wireJumpOpener(editorMonaco: typeof monaco): void {
  editorMonaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      // 就地跳转（定义在同一文件）：内建 doOpenEditor 直接 reveal，不路由
      if (source.getModel()?.uri.toString() === resource.toString()) return false
      const path = projectRelativePathFromUri(resource)
      if (!path || isMonacoTsLibPath(path)) return false
      const projectId = useProjectStore().currentProjectId
      if (!projectId) return false
      // IRange（跳转带选区）与 IPosition 两形态统一折算为 OpenFileAtDetail 的
      // line/col（IRange 取起点）
      const at = selectionOrPosition
        ? ('startLineNumber' in selectionOrPosition
          ? { line: selectionOrPosition.startLineNumber, col: selectionOrPosition.startColumn }
          : { line: selectionOrPosition.lineNumber, col: selectionOrPosition.column })
        : undefined
      window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
        detail: { path, projectId, line: at?.line, col: at?.col },
      }))
      return true
    },
  })
}

// ── ② definition / references 注入 provider（Ctrl+click 注册表面）──

function wireInjectProviders(editorMonaco: typeof monaco): void {
  editorMonaco.languages.registerDefinitionProvider(['typescript', 'javascript'], {
    provideDefinition: async (model, position) =>
      provideWithInjection(model, position, 'getDefinitionAtPosition'),
  })
  editorMonaco.languages.registerReferenceProvider(['typescript', 'javascript'], {
    provideReferences: async (model, position) =>
      provideWithInjection(model, position, 'getReferencesAtPosition'),
  })
}

/** 伪定义判定：未解析导入别名的「定义」= 本文件导入子句别名位（见头注①） */
function isAliasPseudoDefinition(e: TsWorkerEntry): boolean {
  return e.kind === 'alias' && e.failedAliasResolution === true
}

function hasRealDefinition(entries: TsWorkerEntry[] | undefined): boolean {
  if (!entries || entries.length === 0) return false
  return entries.some((e) => !isAliasPseudoDefinition(e))
}

/** 零结果路径的按需注入编排（Ctrl+click provider 面）。任何一步不成立都返回
 *  空数组——本 provider 只做增益（pathCompletion 同姿态），失败不打扰内建链 */
async function provideWithInjection(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  ask: WorkerAskFn,
): Promise<monaco.languages.Location[]> {
  try {
    const currentPath = projectRelativePathFromUri(model.uri)
    const projectId = useProjectStore().currentProjectId
    if (!currentPath || !projectId) return []

    const wfn = await workerAccessorFor(model.getLanguageId())
    if (!wfn) return []
    const offset = model.getOffsetAt(position)

    // 预问（definition 探针统一判两类跳转的「已有结果」）：真定义已在上下文 =
    // 内建 provider 同题必非空，直返空让位防重复条目
    const client = await wfn(model.uri)
    const pre = await client.getDefinitionAtPosition(model.uri.toString(), offset)
    if (hasRealDefinition(pre)) return []

    const targetPath = await resolveTargetPath(model, position, currentPath, projectId)
    if (!targetPath) return []

    const targetModel = await injectTarget(projectId, targetPath)
    if (!targetModel || targetModel.isDisposed()) return []
    await wfn(monaco.Uri.parse(`file:///${targetPath}`))

    // 注入后重问（受限重试窗口）；definition 侧只认真定义——注入未生效时重问
    // 仍会拿到别名位伪定义，收下它等于把内建「跳回 import 行」现状重复一遍
    for (let i = 0; ; i++) {
      const entries = await askWorker(wfn, ask, [model.uri], model.uri.toString(), offset)
      const found = ask === 'getDefinitionAtPosition' ? hasRealDefinition(entries) : !!entries && entries.length > 0
      if (found && entries) return mapWorkerEntries(entries)
      if (i >= RETRY_DELAYS_MS.length) return []
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]))
    }
  } catch {
    return []
  }
}

async function askWorker(
  wfn: TsWorkerAccessor,
  ask: WorkerAskFn,
  uris: monaco.Uri[],
  fileName: string,
  offset: number,
): Promise<TsWorkerEntry[] | undefined> {
  const client = await wfn(...uris)
  return ask === 'getDefinitionAtPosition'
    ? client.getDefinitionAtPosition(fileName, offset)
    : client.getReferencesAtPosition(fileName, offset)
}

/** worker 条目 → Monaco Location（DefinitionAdapter 同款折算：目标 model 在册
 *  才能 offset→行列；lib 条目由内建 provider 自管不重复） */
function mapWorkerEntries(entries: TsWorkerEntry[]): monaco.languages.Location[] {
  const result: monaco.languages.Location[] = []
  for (const e of entries) {
    const startOffset = e.textSpan?.start
    const fileName = e.fileName
    if (typeof startOffset !== 'number' || !fileName) continue
    const path = fileName.startsWith('file:///') ? fileName.slice('file:///'.length) : ''
    if (!path) continue
    try {
      if (isMonacoTsLibPath(decodeURIComponent(path))) continue
    } catch {
      continue // 非法编码形态的 fileName 不在本 provider 面
    }
    const uri = monaco.Uri.parse(fileName)
    const target = monaco.editor.getModel(uri)
    if (!target) continue
    const endOffset = startOffset + Math.max(0, e.textSpan?.length ?? 0)
    result.push({
      uri,
      range: monaco.Range.fromPositions(target.getPositionAt(startOffset), target.getPositionAt(endOffset)),
    })
  }
  return result
}

// ── ③ F12 / Shift+F12 接管链（注入即打开）──

/** 键位接管主链：真定义已在上下文 → 原样转交内建 action（既有行为零变化）；
 *  伪定义/零结果 → 解析导入 → 注入 → definition 直接派发既有打开链（绕开
 *  注册表合并的 peek 行为，注入即打开）/ references 转交内建面板（注册表重问
 *  时镜像已含目标文件）。任何一步不成立都转交内建——保持现状不误开 */
async function runNavigationWithInjection(
  editor: monaco.editor.IStandaloneCodeEditor,
  kind: NavKind,
): Promise<void> {
  const fallback = () => delegateBuiltin(editor, kind)
  try {
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position) return fallback()
    const currentPath = projectRelativePathFromUri(model.uri)
    const projectId = useProjectStore().currentProjectId
    const languageId = model.getLanguageId()
    // 非项目 TS/JS 文件（remote 伪路径/untitled/JSON/md…）整链不介入
    if (!currentPath || !projectId) return fallback()
    if (languageId !== 'typescript' && languageId !== 'javascript') return fallback()

    const wfn = await workerAccessorFor(languageId)
    if (!wfn) return fallback()
    const offset = model.getOffsetAt(position)
    const client = await wfn(model.uri)
    const pre = await client.getDefinitionAtPosition(model.uri.toString(), offset)
    if (hasRealDefinition(pre)) return fallback()

    const targetPath = await resolveTargetPath(model, position, currentPath, projectId)
    if (!targetPath) return fallback() // 裸包名 / 探测未命中：内建现状（伪定义跳回 import 行 / 找不到）

    const targetModel = await injectTarget(projectId, targetPath)
    if (!targetModel || targetModel.isDisposed()) return fallback()
    await wfn(monaco.Uri.parse(`file:///${targetPath}`))

    if (kind !== 'definitions') return fallback() // references：镜像就位后交内建面板
    for (let i = 0; ; i++) {
      const entries = await client.getDefinitionAtPosition(model.uri.toString(), offset)
      const real = (entries || []).filter((e) => !isAliasPseudoDefinition(e))
      if (real.length > 0) {
        const location = mapWorkerEntries(real)[0]
        const path = location ? projectRelativePathFromUri(location.uri) : null
        if (location && path && !isMonacoTsLibPath(path)) {
          window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
            detail: {
              path,
              projectId,
              line: location.range.startLineNumber,
              col: location.range.startColumn,
            },
          }))
          return
        }
      }
      if (i >= RETRY_DELAYS_MS.length) return fallback()
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]))
    }
  } catch {
    fallback()
  }
}

/** 转交内建 action（键位被本链接管后的原生行为出口）。内建 goto 族全是
 *  registerAction2（命令注册表），不在 editor.getAction 清单里——经 trigger
 *  落到命令服务执行（Action2 无参 run 取焦点编辑器，F12 按下时焦点必在编辑器） */
function delegateBuiltin(editor: monaco.editor.IStandaloneCodeEditor, kind: NavKind): void {
  const actionId = kind === 'definitions'
    ? 'editor.action.revealDefinition'
    : 'editor.action.goToReferences'
  editor.trigger('sc-goto', actionId, null)
}

// ── 共用底座：说明符解析 / 存在性探测 / 注入 ──

/** 光标处符号的导入说明符 → 项目内目标文件路径；null = 本链不介入 */
async function resolveTargetPath(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  currentPath: string,
  projectId: string,
): Promise<string | null> {
  // 光标行说明符优先（import 行上跳转），否则全文按词找 import 子句（使用行
  // 跳转的肌肉记忆路径）。全文扫描只发生在零结果路径，非热路径
  const word = model.getWordAtPosition(position)?.word || ''
  const line = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: model.getLineMaxColumn(position.lineNumber),
  })
  const specifier = extractImportSpecifiersFromLine(line)[0]
    || (word ? findImportSpecifierForWord(model.getValue(), word) : null)
  if (!specifier) return null

  // 存在性探测：一次项目文件清单（零结果路径低频触发，无长驻缓存与失效面
  // ——每请求一条 /file-list，与 Quick Open 同源取数原语）
  const { files } = await collectProjectFileList(projectId)
  const fileSet = new Set(files.map((f) => f.path))
  return resolveImportSpecifierPath(currentPath, specifier, fileSet)
}

/** 目标文件进 model 域：全局注册表在册即复用（缓存/打开集/注入池任一处——
 *  注入不改写已挂载内容，防清掉未保存编辑）；否则 silent readFile 后
 *  createModel 并入注入池。同目标并发注入共享同一 promise */
async function injectTarget(
  projectId: string,
  path: string,
): Promise<monaco.editor.ITextModel | null> {
  const uri = monaco.Uri.parse(`file:///${path}`)
  const existing = monaco.editor.getModel(uri)
  if (existing) return existing
  const key = uri.toString()
  const inflight = inflightInjections.get(key)
  if (inflight) return inflight
  const pending = injectModel(projectId, path, uri)
  inflightInjections.set(key, pending)
  try {
    return await pending
  } finally {
    inflightInjections.delete(key)
  }
}

async function injectModel(
  projectId: string,
  path: string,
  uri: monaco.Uri,
): Promise<monaco.editor.ITextModel | null> {
  // silent：清单在册但文件被竞态删除（404）是预期分支，不弹拦截器全局错误
  const res = await projectApi.readFile(projectId, path, { silent: true })
  const content: string = res.data || ''
  if (!content || content.length > INJECT_MAX_CONTENT_LENGTH) return null
  const model = monaco.editor.createModel(content, getLanguageByPath(path), uri)
  retainInjectedModel(uri.toString(), model)
  return model
}

// ── 项目切换清池（注入池与既有缓存清理点同拍）──

function wireProjectSwitchCleanup(): void {
  // detached effectScope：模块单例生命周期不随 MonacoEditor 实例销毁（connect
  // 幂等重入时 watch 只此一份）。openfiles 的项目切换 watcher（订阅创建在先，
  // 同 tick 先执行）清打开文件并 dispose 相关 model，出池钩子自然清账；这里只
  // 补「未打开的注入 model」——路径在另一项目下同名异实，跨项目保留只会误导跳转
  effectScope(true).run(() => {
    watch(() => useProjectStore().currentProjectId, (nv, ov) => {
      if (!ov || nv === ov) return
      clearInjectedMonacoModels()
    })
  })
}
