/**
 * useOpenFiles 域拆分（P-20261003-98）：diff 视图域——diff: 伪键 tab 的打开
 * （openDiffView）与三个上层入口（冲突并排对比、远程冲突对比、任意两文件互比
 * P-20261002-75）。diff tab 是只读对比视图：无 Monaco model、不入关闭栈、
 * 不参与草稿/自动保存（那些域按 isDiff/伪键排除）。从 useOpenFiles.ts 原地迁出，
 * 行为零变化。
 */
import { projectApi, remoteHostApi, snapshotApi } from '../../api/client'
import { isRemoteEditorPath, parseRemoteEditorPath } from '../../utils/remoteEditorPath'
import { INDEX_REF } from '../../utils/changeDiffBaseline'
import type { OpenFilesCtx } from './context'
import type { OpenFile } from './types'

/** 索引伪 ref → git 底层取数语法（P-20261004-42）：键与面包屑层保持可读字面量
 *  index，快照取数层须是 git show :0:<path>（stage-0 = 暂存区内容）才取得到。
 *  其余 ref（HEAD/commit sha/远程形态）原样透传 */
function toSnapshotRef(ref: string): string {
  return ref === INDEX_REF ? ':0' : ref
}

export function createDiff(ctx: OpenFilesCtx): void {
  const { projectStore } = ctx

  /** 打开 diff 对比视图。
   *  leftContent：左侧内容直供（剪贴板对比等内存源）——提供时跳过 oldRef 的
   *  快照取数；oldRef 仍进 tab 键（去重）与面包屑（伪 ref 语义由渲染层映射）。
   *  oldLabel：左侧展示名（缺省截 oldRef 前 8 位）。
   *  rightContent：右侧内容直供（远程冲突对比 P-20261003-15——右=远端当前
   *  内容已由调用方从 content 端点取回；与 leftContent 对偶）。远程伪路径
   *  不要求项目上下文（对比标签打开不依赖项目域取数）。
   *  oldRef/newRef 支持 index 伪 ref（P-20261004-42 变更基线分流）＝暂存区
   *  内容，取数经 toSnapshotRef 映射为 stage-0 语法 */
  ctx.openDiffView = async function openDiffView(params) {
    if (!projectStore.currentProjectId && !isRemoteEditorPath(params.path)) return
    const g = ctx.groupAt(ctx.activeGroup.value)
    const key = `diff:${params.oldRef}:${params.newRef || 'wt'}:${params.path}`
    const existIdx = g.files.findIndex(f => f.path === key)
    if (existIdx >= 0) {
      // 内存直供侧（剪贴板等）内容随时间变化：同键已开时就地更新左侧内容，
      // 否则「复制新内容再对比」看到的是旧 diff
      if (params.leftContent !== undefined) {
        const f = g.files[existIdx]
        if (f) {
          f.diffOldContent = params.leftContent
          if (params.oldLabel) f.diffOldLabel = params.oldLabel
        }
      }
      g.activeIndex = existIdx
      return
    }
    g.files.push({
      path: key,
      name: params.name + ' (Diff)',
      content: '',
      originalContent: '',
      loading: true,
      isDiff: true,
      diffOldContent: '',
      diffOldLabel: params.oldLabel || params.oldRef.substring(0, 8),
      diffNewLabel: params.newRef ? params.newRef.substring(0, 8) : ctx.t('changes.working'),
    })
    const fileIdx = g.files.length - 1
    g.activeIndex = fileIdx

    try {
      // diff 取数对「文件在某一侧不存在」属预期失败：silent 静默 + 空内容兜底，
      // 已删除文件呈现为整段删除而非弹「服务器异常」并关页
      let oldContent = ''
      if (params.leftContent !== undefined) {
        oldContent = params.leftContent
      } else {
        try {
          const oldRes = await snapshotApi.showFile(projectStore.currentProjectId!, toSnapshotRef(params.oldRef), params.path, { silent: true })
          oldContent = oldRes.data || ''
        } catch { oldContent = '' }
      }

      let newContent = ''
      if (params.rightContent !== undefined) {
        newContent = params.rightContent
      } else {
        try {
          if (params.newRef) {
            const newRes = await snapshotApi.showFile(projectStore.currentProjectId!, toSnapshotRef(params.newRef), params.path, { silent: true })
            newContent = newRes.data || ''
          } else if (isRemoteEditorPath(params.path)) {
            // 远程伪路径右侧取远端当前内容（content 端点），非项目 readFile
            const rp = parseRemoteEditorPath(params.path)
            if (rp) {
              const newRes = await remoteHostApi.files.content(rp.hostId, rp.rpath, { silent: true }) as unknown as { data?: string }
              newContent = newRes?.data || ''
            }
          } else {
            const newRes = await projectApi.readFile(projectStore.currentProjectId!, params.path, { silent: true })
            newContent = newRes.data || ''
          }
        } catch { newContent = '' }
      }
      const f = g.files[fileIdx]
      if (f) {
        f.diffOldContent = oldContent
        f.content = newContent
        f.originalContent = newContent
        f.loading = false
      }
    } catch {
      g.files.splice(fileIdx, 1)
      g.activeIndex = Math.min(g.activeIndex, g.files.length - 1)
    }
  }

  /** 并排对比：左 = 我的未保存内存内容（leftContent 直供），右 = 磁盘当前
   *  内容（openDiffView 的 newRef 缺省路径走 readFile 现拉）。伪 ref 带
   *  时间戳保证每次对比都是新鲜两侧取数，面包屑截前 8 位仍显示为 conflict */
  ctx.openConflictDiff = function openConflictDiff(file: OpenFile) {
    void ctx.openDiffView({
      path: file.path,
      name: file.name,
      oldRef: `conflict-${Date.now()}`,
      leftContent: file.content,
      oldLabel: ctx.t('files.conflict.diffMySide'),
    })
  }

  /** 远程冲突并排对比（openConflictDiff 的远端孪生）：左 = 我的未保存内存
   *  内容（leftContent 直供），右 = 远端当前内容（content 端点现拉，经
   *  openDiffView 的 rightContent 直供免走项目 readFile） */
  ctx.openRemoteConflictDiff = async function openRemoteConflictDiff(file) {
    const remote = parseRemoteEditorPath(file.path)
    if (!remote) return
    let rightContent = ''
    try {
      const res = await remoteHostApi.files.content(remote.hostId, remote.rpath, { silent: true }) as unknown as { data?: string }
      rightContent = typeof res?.data === 'string' ? res.data : ''
    } catch { /* 拉不到按空侧呈现，diff 标签内可见差距 */ }
    void ctx.openDiffView({
      path: file.path,
      name: file.name,
      oldRef: `conflict-${Date.now()}`,
      leftContent: file.content,
      oldLabel: ctx.t('files.conflict.diffMySide'),
      rightContent,
    })
  }

  /** 任意两工作区文件互比（P-20261002-75）：左 = 基准文件（readFile 现拉 +
   *  leftContent 直供），右 = 目标文件（openDiffView 的 newRef 缺省路径走
   *  readFile 现拉）。伪 ref = cmpto-<encodeURIComponent(基准路径)>@<时间戳>：
   *  时间戳保证每次对比都是新鲜两侧取数（同 openConflictDiff 口径），编码段
   *  供 Breadcrumb 解码出基准名（不含冒号，不破坏 diff: 键的冒号分段）。
   *  too-large/binary 走 filePolicy 既有拦截（就地提示并放弃）。
   *  返回 false = 被策略/读取拦下（调用方据此保留基准，一次性清除只在成功后） */
  ctx.openTwoFilesDiff = async function openTwoFilesDiff(params) {
    if (!projectStore.currentProjectId) return false
    const projectId = projectStore.currentProjectId
    // 策略先行（openFileInto 同款一次 stat）：两侧任一 too-large/binary 都不进 diff
    try {
      const pols = await Promise.all([
        projectApi.filePolicy(projectId, params.basePath),
        projectApi.filePolicy(projectId, params.targetPath),
      ]) as { data?: { kind?: string; sizeHuman?: string } }[]
      for (let i = 0; i < pols.length; i++) {
        const d = pols[i]?.data
        if (d && (d.kind === 'too-large' || d.kind === 'binary')) {
          ctx.message.warning(ctx.t('compare.pick.blocked', { name: i === 0 ? params.baseName : params.targetName }))
          return false
        }
      }
    } catch {
      // 策略查询失败 → 继续走读取路径兜底（服务端 ReadFile 自身仍有策略拦截）
    }
    let baseContent: string
    try {
      const res = await projectApi.readFile(projectId, params.basePath)
      baseContent = res.data || ''
    } catch { /* 拦截器已提示（基准文件被删/移走）：保留基准由用户处置 */ return false }
    void ctx.openDiffView({
      path: params.targetPath,
      name: `${params.baseName} ↔ ${params.targetName}`,
      oldRef: `cmpto-${encodeURIComponent(params.basePath)}@${Date.now()}`,
      leftContent: baseContent,
      oldLabel: params.baseName,
    })
    return true
  }
}
