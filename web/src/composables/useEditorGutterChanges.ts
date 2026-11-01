import { ref, onScopeDispose } from 'vue'
import { diffApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { OPS_FILES_EXTERNAL_CHANGE, OPS_FILES_SAVED } from '../utils/opsEvents'
import { isUntitledPath } from './useOpenFiles'
import { isRemoteEditorPath } from '../utils/remoteEditorPath'

/**
 * 编辑器 gutter 变更条（P-20261003-14）：打开文件即可见哪些行相对上次提交
 * 动过——added 绿条 / modified 蓝条，评审不再依赖 diff 面板来回切。
 *
 * 数据源：复用既有 /file/hunks 端点（staged=false，工作区 vs 暂存区，未暂存
 * 常态下与 HEAD vs 工作区同口径）——纯前端编排，不新增后端。
 *
 * 通道：Monaco linesDecorations 车道，与 blame 的 after 注入文本、书签的
 * glyphMargin 互不同车道，装饰间无冲突。
 *
 * 失效链（保存成功 / 外部改写事件后刷新）：本组合式挂 window 事件监听，
 * 事件由 useOpenFiles（OPS_FILES_SAVED）与各广播方（OPS_FILES_EXTERNAL_CHANGE）
 * 派发，MonacoEditor 侧只消费。状态为组件实例私有（transient，不持久化），
 * 非模块单例——分屏双组各自拉取各自标记。
 */

/** 性能护栏：单文件变更行数超限跳过标记（生成式大 diff 冻结 gutter 得不偿失） */
export const GUTTER_CHANGES_MAX_LINES = 5000

/** hunk 展开所需的最小形状（与 model.DiffHunk JSON 对齐，便于单测构造） */
export interface DiffHunkLike {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

export interface ChangedLineMark {
  line: number
  kind: 'added' | 'modified'
}

/** hunk 列表展开为行级标记。
 *  解析 hunk.content（含 @@ 头行）：`-` 行挂起待配对；`+` 行落新行号——
 *  前面有挂起删除的按 modified（改动行，VS Code dirty-diff 同款分类），
 *  纯新增段记 added；上下文行推进新侧行号并收口配对。
 *  超 GUTTER_CHANGES_MAX_LINES 变更行整单跳过（返回空 = 无标记）。 */
export function expandHunksToChangedLines(hunks: DiffHunkLike[]): ChangedLineMark[] {
  const marks: ChangedLineMark[] = []
  let changed = 0
  for (const hunk of hunks) {
    let newLine = hunk.newStart
    let pendingDels = 0
    for (const raw of hunk.content.split('\n')) {
      if (raw.startsWith('+')) {
        const kind = pendingDels > 0 ? 'modified' : 'added'
        if (pendingDels > 0) pendingDels--
        marks.push({ line: newLine, kind })
        changed++
        newLine++
      } else if (raw.startsWith('-')) {
        pendingDels++
        changed++
      } else if (raw.startsWith(' ')) {
        // 上下文行：推进新侧行号；变更块收口（隔了上下文的增删不跨块配对）
        pendingDels = 0
        newLine++
      }
      // 其余（@@ 头行、"\\ No newline at end of file"、尾部空串）无行号语义
    }
  }
  return changed > GUTTER_CHANGES_MAX_LINES ? [] : marks
}

/** gutter 变更条状态 + 失效刷新（MonacoEditor setup 内调用，作用域随组件卸载清理） */
export function useEditorGutterChanges(options: {
  /** 当前编辑文件的项目相对路径求值器（事件与竞态守卫都取实时值） */
  getPath: () => string
}) {
  const projectStore = useProjectStore()
  /** added/modified 行级标记；空数组 = 无标记（干净文件 / untracked / 超限 / 拉取失败）。
   *  untracked 文件 git diff 为空（提案④ MVP：不标新文件全部行） */
  const changedLines = ref<ChangedLineMark[]>([])
  // 迟到响应丢弃：保存与外部改写连续触发时，先发出的旧响应不覆盖新状态
  let fetchSeq = 0

  /** 拉取当前文件的工作区变更并重算标记。无项目/伪路径（untitled 草稿、
   *  diff 伪键、remote: 远程伪路径——远端文件不在项目 git 域内，
   *  isBookmarkablePath 同口径）直接清空；失败静默回无标记（同 blame 当前态口径） */
  async function refresh() {
    const path = options.getPath()
    const pid = projectStore.currentProjectId
    if (!pid || !path || path.startsWith('diff:') || isUntitledPath(path) || isRemoteEditorPath(path)) {
      changedLines.value = []
      return
    }
    const seq = ++fetchSeq
    try {
      const res: any = await diffApi.getFileHunks(pid, path, false)
      if (seq !== fetchSeq || options.getPath() !== path) return
      changedLines.value = expandHunksToChangedLines((res.data || []) as DiffHunkLike[])
    } catch {
      if (seq === fetchSeq) changedLines.value = []
    }
  }

  // 失效链（提案③）：保存成功与外部改写事件后刷新。paths 空 = 广播方不知道
  // 具体路径（分支切换/重置等大范围），语义为「当前文件也刷新」
  const pathInEvent = (e: Event) => {
    const paths = ((e as CustomEvent).detail?.paths || []) as string[]
    return paths.length === 0 || paths.includes(options.getPath())
  }
  const onFilesSaved = (e: Event) => { if (pathInEvent(e)) void refresh() }
  const onFilesExternalChange = (e: Event) => { if (pathInEvent(e)) void refresh() }
  window.addEventListener(OPS_FILES_SAVED, onFilesSaved)
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, onFilesExternalChange)
  onScopeDispose(() => {
    window.removeEventListener(OPS_FILES_SAVED, onFilesSaved)
    window.removeEventListener(OPS_FILES_EXTERNAL_CHANGE, onFilesExternalChange)
  })

  return { changedLines, refresh }
}
