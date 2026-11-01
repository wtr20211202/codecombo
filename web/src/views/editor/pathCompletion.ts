// 编辑器字符串内路径补全（P-20261003-107）
//
// 动机：字符串里写文件路径（import / 配置 / 脚本参数）无补全。触发从严防误弹：
// 引号上下文 + 「/ \ 触发字符 或 ./ ../ / 盘符 开头的显式路径意图」双门槛才产出
// 条目，代码区/普通文本零打扰。路径基准 = 相对当前文件所在目录（/ 开头按项目根
// 相对）；条目 = 基准目录的直接子文件 + 由文件清单合成的子目录钻取项（插 `xx/`
// 后再触发即逐级下钻）。
//
// 绝对宿主路径二阶段（P-20261005-232）：盘符形态（`D:/` `D:\`，Windows 肌肉
// 记忆）与 posix 绝对形态命中项目根前缀时剥根映射进既有钻取链——绝对形态仅作
// 输入匹配键，条目回填 `/` 项目根相对形态（回填后尾 `/` 经既有 atRoot 链续钻，
// 任意文件位置不断链）；项目根之外的绝对路径如实不响应（越界补全误导）。
//
// 数据面：编辑器域文件清单缓存（editorFileListCache，P-20261005-214 提取共享——
// 行内路径链接层 pathLinks 同链消费），失效/TTL 与 Quick Open 同源同拍。
//
// 分层与 useEditorProblems / monacoViewStateMoves 同款「编辑器 chunk 反向注册」：
// 本模块不运行时依赖 monaco-editor（仅 type 引用），MonacoEditor.vue 首次挂载把
// monaco 命名空间回传 connectEditorPathCompletion，provider 以 '*' 选择器全语言
// 注册一次（幂等，分屏双编辑器/路由进出重复挂载只注册一份）。纯逻辑（引号探测/
// 门槛/路径解析/模糊匹配/条目构建）导出供单测，不经 monaco、可在 jsdom 直测。
import type * as monacoNS from 'monaco-editor'
import { useProjectStore } from '../../stores/project'
import type { PaletteFileItem } from '../../composables/projectFileList'
import { isRemoteEditorPath } from '../../utils/remoteEditorPath'
import { getFileListForCompletion, parentDir, resetEditorFileListCacheForTests } from './editorFileListCache'

// ── 纯逻辑：引号上下文探测 ──

export interface PathQuoteContext { quote: string; prefix: string }

const PATH_QUOTES = new Set(['"', "'", '`'])

/** 引号上下文探测：光标前文本里找最近一个「开启且未闭合」的引号，返回引号与
 *  其后到光标的路径前缀。行内启发（跨行模板串首行之外不探测——MVP 边界，误报
 *  方向是少弹不误弹）。前缀里再混入任意引号即视为口语/拼接语境（`"it's ./x/`
 *  类）返回 null */
export function detectPathQuoteContext(linePrefix: string): PathQuoteContext | null {
  for (let i = linePrefix.length - 1; i >= 0; i--) {
    const ch = linePrefix[i]
    if (ch === undefined || !PATH_QUOTES.has(ch)) continue
    let count = 0
    for (let j = 0; j < i; j++) if (linePrefix[j] === ch) count++
    if (count % 2 === 1) continue // 奇数个同类引号在前：这是闭合引号，继续向前找开启引号
    const prefix = linePrefix.slice(i + 1)
    if (/["'`]/.test(prefix)) return null
    return { quote: ch, prefix }
  }
  return null
}

/** 盘符绝对路径形态（`D:/` `D:\` 开头，P-20261005-232）：出现即显式绝对路径
 *  意图（mac/linux 无盘符书写习惯——正则天然不命中零影响）；是否落在项目根内
 *  由 resolvePathRequest 按项目根前缀映射裁决 */
const DRIVE_ABS_PREFIX = /^[A-Za-z]:[\\/]/

/** 激活门槛（提案「触发字符 / 与 ./ 开头才激活，防噪声」）：前缀以 / 结尾
 *  （刚敲的 / 触发字符，或目录钻取插入落点），以 ./ ../ / 开头，或呈盘符绝对
 *  形态（P-20261005-232——反斜杠形态经 \ 触发字符进入），均为显式路径意图。
 *  空前缀（刚开引号）与普通文本一律不激活 */
export function isPathCompletionIntent(prefix: string): boolean {
  if (!prefix) return false
  if (prefix.endsWith('/')) return true
  if (DRIVE_ABS_PREFIX.test(prefix)) return true
  return prefix.startsWith('./') || prefix.startsWith('../') || prefix.startsWith('/')
}

// parentDir / 路径解析工具见 editorFileListCache（P-20261005-214 提取共享）

export interface PathRequest {
  /** 补全基准目录（项目相对，''=项目根） */
  baseDir: string
  /** 光标前正在输入的过滤段（最后一个 / 之后的部分） */
  filter: string
  /** 已敲定的导航前缀（引号内到过滤段之前，如 `./src/`），条目 detail 展示用 */
  navPrefix: string
  /** 绝对宿主形态命中项目根剥根映射而来（P-20261005-232）：主替换区间照常
   *  只盖过滤段，绝对前缀头部由条目 additionalTextEdits 原子回填为
   *  navPrefix（/ 项目根相对形态）——绝对形态仅作输入匹配键 */
  fromAbsolute?: true
}

/** 绝对宿主路径 → 项目内相对前缀映射（P-20261005-232 二阶段核心）。
 *  三态返回：undefined=前缀非绝对形态（不适用，走既有链）；null=绝对形态但
 *  未命中项目根（界外/部分根）；string=剥根后的项目内前缀（''=项目根本身，
 *  保留已敲大小写与分隔形态）。匹配口径（P-113 relpath 同款）：完整路径段
 *  前缀（兄弟目录名前缀不命中）、正反斜杠双形态、盘符形态大小写不敏感——
 *  盘符本身即 Windows 路径语义信号，「win 不敏感/linux 敏感」平台口径无需
 *  嗅探平台；posix 形态大小写敏感精确匹配。退化根（`C:` 盘根级、posix `/`）
 *  不映射（relpath.go relRoot 同款闸：过泛前缀会误伤整盘路径） */
function mapAbsolutePrefixToProjectRelative(
  prefix: string,
  projectRoot: string | undefined,
): string | null | undefined {
  const driveForm = DRIVE_ABS_PREFIX.test(prefix)
  if (!driveForm && !prefix.startsWith('/')) return undefined
  const normRoot = (projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normRoot || normRoot === '/' || /^[A-Za-z]:$/.test(normRoot)) return null
  const fold = (s: string): string => (driveForm ? s.toLowerCase() : s)
  const np = fold(prefix.replace(/\\/g, '/'))
  const nr = fold(normRoot)
  if (np === nr) return ''
  if (!np.startsWith(`${nr}/`)) return null
  // 归一化只换分隔符/折大小写（均保长）——按长度差回原文切片保留已敲形态
  return prefix.slice(prefix.length - (np.length - nr.length - 1))
}

/** 由「当前文件路径 + 引号内已敲前缀」解析补全基准：前缀按 / 切段，`.` 原地、
 *  `..` 上级（越出项目根返回 null），中间导航段必须是清单里真实存在的目录
 *  （防 `C:/Users/` 类非项目路径与口语串误弹——两处都收敛为「导航段不是真实
 *  目录 → 零条目」）；/ 开头以项目根为基准（P-107「绝对项目路径」最小集）。
 *  P-20261005-232 扩展：传入 projectRoot 时盘符/宿主绝对形态先按项目根前缀
 *  映射——命中剥根映射为 / 项目根相对形态进既有钻取链；盘符形态未命中=界外
 *  如实不激活，posix 绝对形态未命中回落「/ 项目根相对」既有语义 */
export function resolvePathRequest(
  currentFile: string,
  prefix: string,
  dirSet: ReadonlySet<string>,
  projectRoot?: string,
): PathRequest | null {
  let effective = prefix
  let fromAbsolute: true | undefined
  const mapped = mapAbsolutePrefixToProjectRelative(prefix, projectRoot)
  if (mapped !== undefined) {
    if (mapped === null) {
      // 盘符形态未命中项目根=界外（提案②如实不激活——posix 绝对形态回落下方
      // 既有「/ 项目根相对」语义，与 P-107 最小集兼容）
      if (DRIVE_ABS_PREFIX.test(prefix)) return null
    } else {
      effective = `/${mapped.replace(/\\/g, '/')}`
      fromAbsolute = true
    }
  }
  const atRoot = effective.startsWith('/')
  const segments = effective.split('/')
  const filter = segments.pop() || ''
  let base = atRoot ? '' : parentDir(currentFile)
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!base) return null
      base = parentDir(base)
      continue
    }
    const next = base ? `${base}/${seg}` : seg
    if (!dirSet.has(next)) return null
    base = next
  }
  return {
    baseDir: base,
    filter,
    navPrefix: effective.slice(0, effective.length - filter.length),
    fromAbsolute,
  }
}

/** 大小写不敏感子序列模糊匹配（提案②）：filter 逐字符按序出现在 name 里即命中 */
export function fuzzyMatchPath(filter: string, name: string): boolean {
  if (!filter) return true
  const f = filter.toLowerCase()
  const t = name.toLowerCase()
  let i = 0
  for (let k = 0; k < t.length && i < f.length; k++) if (t[k] === f[i]) i++
  return i === f.length
}

export interface PathSuggestionDescriptor {
  /** 展示名：文件名 / `目录/` */
  label: string
  /** Monaco 过滤用文本（目录不带尾 / ，与光标前过滤段同粒度） */
  filter: string
  /** 插入文本（替换过滤段；目录带尾 / 触发下钻） */
  insert: string
  kind: 'file' | 'folder'
  /** 补全落定后引号内的完整形态（navPrefix + label） */
  detail: string
  /** 目录优先、同组字典序（sortText 首字符分组） */
  sortText: string
}

/** 单次补全条目上限：基准目录子项极多（项目根数千文件）时截断，Monaco 面板
 *  可视行 ~12，100 已远超扫视需要 */
export const PATH_SUGGESTION_CAP = 100

/** 由文件清单构建基准目录的直接子条目：子文件直接列出，更深层路径按首段合成
 *  目录钻取项（文件清单只有文件没有目录，目录项即由此派生） */
export function buildPathSuggestions(
  files: readonly PaletteFileItem[],
  baseDir: string,
  filter: string,
  navPrefix: string,
): PathSuggestionDescriptor[] {
  const baseSlash = baseDir ? `${baseDir}/` : ''
  const dirs = new Set<string>()
  const fileHits: PathSuggestionDescriptor[] = []
  for (const f of files) {
    if (baseSlash && !f.path.startsWith(baseSlash)) continue
    const rest = baseSlash ? f.path.slice(baseSlash.length) : f.path
    if (!rest) continue
    const slash = rest.indexOf('/')
    if (slash === -1) {
      if (fuzzyMatchPath(filter, rest)) {
        fileHits.push({
          label: rest, filter: rest, insert: rest, kind: 'file',
          detail: navPrefix + rest, sortText: `1${rest.toLowerCase()}`,
        })
      }
    } else {
      const dir = rest.slice(0, slash)
      if (!dirs.has(dir) && fuzzyMatchPath(filter, dir)) dirs.add(dir)
    }
  }
  const dirHits: PathSuggestionDescriptor[] = [...dirs].sort().map((d) => ({
    label: `${d}/`, filter: d, insert: `${d}/`, kind: 'folder' as const,
    detail: `${navPrefix}${d}/`, sortText: `0${d.toLowerCase()}`,
  }))
  return [...dirHits, ...fileHits]
    .sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0))
    .slice(0, PATH_SUGGESTION_CAP)
}

/** Monaco model URI → 项目相对路径（file:///src/App.vue → src/App.vue）。
 *  非 file scheme（DiffEditor 匿名 model inmemory://）、远程伪路径
 *  remote:/未命名草稿 untitled://（前缀定义见 useOpenFiles UNTITLED_PATH_PREFIX，
 *  此处字面量判定以免拖入重依赖链）、diff: 伪键、无 path 兜底形态
 *  （MonacoEditor 的 untitled.txt fallback）一律 null——补全只服务本地项目文件 */
export function projectRelativePathFromUri(uri: { scheme: string; path: string }): string | null {
  if (uri.scheme !== 'file') return null
  let p: string
  try {
    p = decodeURIComponent(uri.path)
  } catch {
    return null
  }
  if (!p.startsWith('/')) return null
  p = p.slice(1)
  if (!p || p === 'untitled.txt') return null
  if (isRemoteEditorPath(p) || p.startsWith('untitled://') || p.startsWith('diff:')) return null
  return p
}

// ── 补全期文件清单缓存：见 editorFileListCache.ts（P-20261005-214 提取共享，
//    行内路径链接层同链消费；本模块只保留补全语义的纯逻辑与接线）──

// ── Monaco 接线（反向注册）──

let monacoNs: typeof monacoNS | null = null
let registered = false

/** 编辑器 chunk 挂载后回传 monaco 命名空间完成接线；幂等（provider 全局只
 *  注册一份）。provider 异常兜底空结果——补全是增益路径，任何探测异常不得
 *  打扰打字。失效监听由缓存模块自接线（getFileListForCompletion 首次消费挂） */
export function connectEditorPathCompletion(monaco: typeof monacoNS): void {
  if (registered) return
  registered = true
  monacoNs = monaco
  // '\' 触发字符服务反斜杠形态的盘符路径（`D:\src\` 全程无 / 可敲——P-107
  // 只有 / 触发时反斜杠形态永远无法激活）；非盘符前缀在 intent 门槛即零条目，
  // 多出的触发面只是行级 O(n) 前缀探测，不产生面板噪声
  monaco.languages.registerCompletionItemProvider('*', {
    triggerCharacters: ['/', '\\'],
    async provideCompletionItems(model, position) {
      try {
        return await providePathSuggestions(model, position)
      } catch {
        return { suggestions: [] }
      }
    },
  })
}

async function providePathSuggestions(
  model: monacoNS.editor.ITextModel,
  position: { lineNumber: number; column: number },
): Promise<{ suggestions: monacoNS.languages.CompletionItem[] }> {
  const currentFile = projectRelativePathFromUri(model.uri)
  if (!currentFile) return { suggestions: [] }
  // 光标前整行文本：引号探测与门槛判定只需要这一小段（行级 O(n)，n=行长；
  // '/' 触发才进入本函数，非每击键热路径）
  const linePrefix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  })
  const ctx = detectPathQuoteContext(linePrefix)
  if (!ctx || !isPathCompletionIntent(ctx.prefix)) return { suggestions: [] }

  const pid = useProjectStore().currentProjectId
  if (!pid) return { suggestions: [] }
  // 项目根宿主路径：绝对形态剥根映射的比对基准（P-20261005-232）
  const projectRoot = useProjectStore().currentProject?.path
  const { files, dirs } = await getFileListForCompletion(pid)
  const req = resolvePathRequest(currentFile, ctx.prefix, dirs, projectRoot)
  if (!req) return { suggestions: [] }
  if (!monacoNs) return { suggestions: [] }

  // 替换区间 = 引号内过滤段（最后一个 / 之后到光标），插入语义与语言无关的
  // 词边界解耦（Monaco 默认按词取 range，`/` 非词字符会导致 range 不稳）。
  // 绝对宿主形态主区间照常只盖过滤段——Monaco 以「range 起点到光标」的行内
  // 文本为条目过滤口径，主区间拓宽到整段绝对前缀会把条目全部滤灭（实测）；
  // 绝对前缀头部（引号内到过滤段之前）由 additionalTextEdits 在条目落定时
  // 原子替换为 / 项目根相对导航前缀（回填相对形态，绝对形态仅作输入匹配键）
  const filterLen = req.fromAbsolute
    ? req.filter.length
    : ctx.prefix.length - req.navPrefix.length
  const range = new monacoNs.Range(position.lineNumber, position.column - filterLen, position.lineNumber, position.column)
  const additionalTextEdits = req.fromAbsolute
    ? [{
        range: new monacoNs.Range(
          position.lineNumber,
          position.column - ctx.prefix.length,
          position.lineNumber,
          position.column - filterLen,
        ),
        text: req.navPrefix,
      }]
    : undefined
  const suggestions = buildPathSuggestions(files, req.baseDir, req.filter, req.navPrefix).map((d) => ({
    label: d.label,
    kind: d.kind === 'folder' ? monacoNs!.languages.CompletionItemKind.Folder : monacoNs!.languages.CompletionItemKind.File,
    insertText: d.insert,
    filterText: d.filter,
    detail: d.detail,
    sortText: d.sortText,
    range,
    additionalTextEdits,
  }))
  return { suggestions }
}

/** 供测试用：清缓存（委托共享缓存模块）+ 复位注册态（生产代码不调用——模块
 *  单例随应用生命周期存活，useEditorProblems.disconnectEditorProblems 同姿态） */
export function resetPathCompletionForTests(): void {
  resetEditorFileListCacheForTests()
  registered = false
  monacoNs = null
}
