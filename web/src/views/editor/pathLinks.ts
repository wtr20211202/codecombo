// 编辑器行内路径链接层（P-20261005-214）
//
// 动机：读日志/README/报错消息时，字符串里的 ./src/foo.ts:12 不可点击——终端域
// 已有 Ctrl+click 文件链接（useTerminalFileLinks），编辑器域此前零 LinkProvider。
// 本模块经 monaco.languages.registerLinkProvider('*') 补阅读态：文件引用从
// 「选中复制 → Quick Open 粘贴」变 Ctrl/Cmd+Click 一键直达（Monaco 链接默认
// 手势：multiCursorModifier 缺省 'altKey' 时链接触发键即 Ctrl/Cmd）。
//
// 匹配核复用 utils/pathScan 的 matchPathCandidates（终端链接层/通知正文链接化
// 同一匹配器——「./ ../ 开头或含 / 的路径样 + 可选 :line:col 尾缀」，正则守卫
// 只养一份；http(s) 协议地址被前置守卫天然排除，外链零改动）。有效性即时校验
// 收敛「在册文件才渲染链接」：文件清单走 editorFileListCache（与补全 P-107
// 同源同失效拍），不在册的模块名/示意路径保持死文本。
//
// 打开链零新做：链接 url = file:///<项目相对路径>#L<行>[,<列>]（extractSelection
// 片段语法，与 model URI 的 file:///<path> 约定同构——同文件链接 URI 精确等值，
// 内建 reveal 原地定位依赖它）。点击 → OpenerService → EditorOpener →
// openCodeEditor → monacoProjectContext.wireJumpOpener 既有 registerEditorOpener
// 路由（跨文件派 OPS_OPEN_FILE_AT → Layout handleSearchOpenFile 开文件+行定位；
// 同文件回落内建 doOpenEditor 原地 reveal）。
//
// 分层与 pathCompletion 同款「编辑器 chunk 反向注册」：本模块不运行时依赖
// monaco-editor（仅 type 引用），MonacoEditor.vue 首次挂载把 monaco 命名空间
// 回传 connectEditorPathLinks，provider 以 '*' 选择器全语言注册一次（幂等）。
// 纯逻辑（基准折叠/在册校验/链接描述构建）导出供单测，不经 monaco、jsdom 直测。
import type * as monacoNS from 'monaco-editor'
import { useProjectStore } from '../../stores/project'
import { isAbsolutePath, matchPathCandidates } from '../../utils/pathScan'
import { getFileListForCompletion, parentDir, resetEditorFileListCacheForTests } from './editorFileListCache'
import { projectRelativePathFromUri } from './pathCompletion'

// ── 纯逻辑：路径核 → 项目相对目标 ──

/** 相对路径核按基准目录折叠为项目相对路径：`.` 原地 `..` 上级（越出项目根返回
 *  null），`/` `\` 两种分隔符都收（Windows 工具链输出的 src\api\file.go 同样
 *  可链——与终端匹配器同口径）；核内段非法字符已由 matchPathCandidates 守卫 */
export function foldToProjectPath(baseDir: string, core: string): string | null {
  const segs = baseDir ? baseDir.split('/') : []
  for (const part of core.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segs.length === 0) return null
      segs.pop()
      continue
    }
    segs.push(part)
  }
  return segs.join('/')
}

/** 候选解析 + 在册校验（提案②「collectProjectFileList 在册文件才渲染链接」）：
 *  ./ ../ 显式相对只按当前文件目录基准（编辑器路径语义，与补全 P-107 同基准）；
 *  纯相对先按当前文件目录、未命中再按项目根（日志/README 两种书写习惯都命中，
 *  markdown 链接解析惯例）。都查无 → null（模块名/示意路径天然不链）。
 *  绝对路径不链：编辑器链接是本地项目域（远程伪路径 model 已被 URI 守卫挡在
 *  provideLinks 入口），系统绝对路径落项目外无消费语义 */
export function resolveLinkTarget(core: string, currentFile: string, fileSet: ReadonlySet<string>): string | null {
  if (isAbsolutePath(core)) return null
  const base = parentDir(currentFile)
  if (core.startsWith('./') || core.startsWith('../')) {
    const p = foldToProjectPath(base, core)
    return p !== null && fileSet.has(p) ? p : null
  }
  const fromFile = foldToProjectPath(base, core)
  if (fromFile !== null && fileSet.has(fromFile)) return fromFile
  const fromRoot = foldToProjectPath('', core)
  return fromRoot !== null && fileSet.has(fromRoot) ? fromRoot : null
}

/** 链接描述（model 行文本换算面）：列号 1-based（Monaco 约定），:LINE[:COL]
 *  尾缀解析结果随行——定位走 handleSearchOpenFile 既有链 */
export interface PathLinkDescriptor {
  lineNumber: number
  startColumn: number
  endColumn: number
  /** 命中的完整文本（路径核 + :line:col 后缀），hover tooltip 展示用 */
  text: string
  /** 项目相对目标路径（在册已校验） */
  target: string
  line?: number
  col?: number
}

/** 全文行扫描 → 链接描述。自引用（链接回本文件）保留：Monaco 内建 doOpenEditor
 *  对同 model 资源原地 reveal 行，VS Code 同形态。O(全文) 单趟，provider 由
 *  Monaco 按需防抖调度（模型版本变化才重算），非每击键热路径 */
export function buildPathLinkDescriptors(
  lines: readonly string[],
  currentFile: string,
  fileSet: ReadonlySet<string>,
): PathLinkDescriptor[] {
  const out: PathLinkDescriptor[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text) continue
    for (const m of matchPathCandidates(text)) {
      const target = resolveLinkTarget(m.core, currentFile, fileSet)
      if (!target) continue
      out.push({
        lineNumber: i + 1,
        startColumn: m.start + 1,
        endColumn: m.start + m.text.length + 1,
        text: m.text,
        target,
        line: m.line,
        col: m.col,
      })
    }
  }
  return out
}

/** 链接 url：file:///<项目相对路径>#L<行>[,<列>]。片段语法 = monaco
 *  extractSelection 可解析形态（L 后行号、逗号后裸列号），无行号省略片段 */
export function linkUrl(rel: string, line?: number, col?: number): string {
  if (!line) return `file:///${rel}`
  return col ? `file:///${rel}#L${line},${col}` : `file:///${rel}#L${line}`
}

// ── Monaco 接线（反向注册）──

let monacoNs: typeof monacoNS | null = null
let registered = false

/** 编辑器 chunk 挂载后回传 monaco 命名空间完成接线；幂等（provider 全局只注册
 *  一份）。provider 异常兜底空结果——链接是增益路径，任何探测异常不得打扰阅读。
 *  失效监听由缓存模块自接线（getFileListForCompletion 首次消费挂） */
export function connectEditorPathLinks(monaco: typeof monacoNS): void {
  if (registered) return
  registered = true
  monacoNs = monaco
  monaco.languages.registerLinkProvider('*', {
    async provideLinks(model) {
      try {
        return { links: await providePathLinks(model) }
      } catch {
        return { links: [] }
      }
    },
  })
}

async function providePathLinks(model: monacoNS.editor.ITextModel): Promise<monacoNS.languages.ILink[]> {
  // 非 file scheme（diff/inmemory）/远程伪路径/未命名草稿 → 无项目文件语义，
  // 零链接零取数（本地项目域，P-137 同口径）
  const currentFile = projectRelativePathFromUri(model.uri)
  if (!currentFile || !monacoNs) return []
  const pid = useProjectStore().currentProjectId
  if (!pid) return []
  const { files } = await getFileListForCompletion(pid)
  const fileSet = new Set(files.map((f) => f.path))
  const lines: string[] = []
  const lineCount = model.getLineCount()
  for (let i = 1; i <= lineCount; i++) lines.push(model.getLineContent(i))
  return buildPathLinkDescriptors(lines, currentFile, fileSet).map((d) => ({
    range: new monacoNs!.Range(d.lineNumber, d.startColumn, d.lineNumber, d.endColumn),
    url: monacoNs!.Uri.parse(linkUrl(d.target, d.line, d.col)),
    tooltip: d.text,
  }))
}

/** 供测试用：复位注册态（缓存面委托共享缓存模块；生产代码不调用） */
export function resetPathLinksForTests(): void {
  resetEditorFileListCacheForTests()
  registered = false
  monacoNs = null
}
