/**
 * useOpenFiles 域拆分（P-20261003-98）：外部改写重载域（OPS_FILES_EXTERNAL_CHANGE
 * 广播消费）。磁盘已被外部流程（全工程替换 / git 检出、还原、重置等）改写时，
 * 打开中的干净文件自动重读；脏文件保留用户内容但点名提示。从 useOpenFiles.ts
 * 原地迁出，行为零变化——监听注册与作用域清理仍发生在 useOpenFiles() 调用期
 * （工厂被组合根同步调用），与其他域的监听（persist 的 pagehide）互不影响。
 */
import { getCurrentScope, onScopeDispose } from 'vue'
import { projectApi } from '../../api/client'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../utils/opsEvents'
import { isRemoteEditorPath } from '../../utils/remoteEditorPath'
import type { OpenFilesCtx } from './context'
import { isUntitledPath } from './types'

export function createExternal(ctx: OpenFilesCtx): void {
  const { projectStore, notificationStore } = ctx

  // ── 外部改写重载（全工程替换 / git 检出、还原、重置等改盘流程）：磁盘已变，
  // 打开中的干净文件自动重读，避免陈旧内存内容在下次保存时覆盖外部修改；
  // 已有未保存修改的文件不动用户内容（与 VS Code「干净自动重载 / 脏文件保留」
  // 惯例一致），但要点名提示——这些文件的下次保存会覆盖外部修改，用户需人工核对。
  // detail.paths 为空 = 广播方不知道具体路径（如分支切换/重置影响面大），
  // 语义为「所有干净打开文件都重读」
  async function onFilesExternalChange(e: Event) {
    const detailPaths = ((e as CustomEvent).detail?.paths || []) as string[]
    if (!projectStore.currentProjectId) return
    const dirtySkipped: string[] = []
    // 全组去重池（共享对象只重读一次）；未命名草稿无磁盘对应物，不参与重读/
    // 脏提示（重读必 404，草稿也不存在「被外部改写」）；远程伪路径的失效源
    // 是远端主机不是项目文件事件，同样不参与
    const pool = ctx.allOpenFiles.value.filter(f => !isUntitledPath(f.path) && !isRemoteEditorPath(f.path))
    const targets = detailPaths.length
      ? pool.filter(f => detailPaths.includes(f.path))
      : pool.slice()
    for (const f of targets) {
      if (f.content !== f.originalContent) {
        dirtySkipped.push(f.name)
        continue
      }
      try {
        const res: any = await projectApi.readFile(projectStore.currentProjectId, f.path, { silent: true })
        const fresh = typeof res?.data === 'string' ? res.data : ''
        f.content = fresh
        f.originalContent = fresh
        f.encoding = typeof res?.encoding === 'string' ? res.encoding : ''
        // 重读即新磁盘状态：检测基线一并刷新，否则下次保存会误报冲突
        f.baseHash = typeof res?.hash === 'string' ? res.hash : ''
      } catch { /* 文件可能已被删除/移动：保留内存内容 */ }
    }
    if (dirtySkipped.length > 0) {
      notificationStore.add({
        type: 'warning',
        category: 'error',
        title: ctx.t('layout.externalChangeDirtyTitle'),
        body: ctx.t('layout.externalChangeDirtyBody', { names: dirtySkipped.join('、') }),
        projectId: projectStore.currentProjectId,
        projectName: projectStore.currentProject?.name,
      })
    }
  }
  function onFilesExternalChangeWindow(e: Event) { void onFilesExternalChange(e) }
  window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, onFilesExternalChangeWindow)
  if (getCurrentScope()) {
    onScopeDispose(() => {
      window.removeEventListener(OPS_FILES_EXTERNAL_CHANGE, onFilesExternalChangeWindow)
    })
  }
}
