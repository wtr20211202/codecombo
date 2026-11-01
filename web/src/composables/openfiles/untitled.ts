/**
 * useOpenFiles 域拆分（P-20261003-98）：未命名草稿域（P-20261002-24，对标
 * VS Code Ctrl+N / JetBrains scratch file）——纯内存 tab（untitled://N 内部键），
 * Ctrl+S 拦截转另存为转正。从 useOpenFiles.ts 原地迁出，行为零变化。
 * P-20261003-97 草稿热退出：脏内容经 persist 域防抖落 draftDb untitled 命名
 * 空间（uiState 剔除维持不变，P-24 防 readFile 404 的原始动机保留——持久化
 * 只走 IndexedDB），本域负责启动恢复（重建 tab + toast）与另存为转正清账。
 */
import { nextTick } from 'vue'
import { useChangesStore } from '../../stores/changes'
import { projectApi } from '../../api/client'
import { listUntitledDrafts, removeUntitledDraft, saveUntitledDraft } from '../../utils/draftDb'
import { OPS_FILES_SAVED } from '../../utils/opsEvents'
import { promptDialog } from '../useDialog'
import type { OpenFilesCtx } from './context'
import { UNTITLED_PATH_PREFIX, isUntitledPath } from './types'
import type { OpenFile } from './types'

export function createUntitled(ctx: OpenFilesCtx): void {
  const { projectStore } = ctx
  const { onDisposeModel, onUntitledSavedAs } = ctx.hooks

  // 既有新建链路要求先定路径并立即落盘，「先贴段代码再决定放哪」没有去处。
  // 草稿是纯内存 tab：path 用 untitled://N 内部键，脏内容走确认丢弃，Ctrl+S
  // 拦截转另存为。编号进程内单调递增（关闭不复用，避免 model URI 残留冲突）
  let untitledSeq = 0

  /** 新建未命名草稿 tab（Ctrl/Cmd+Alt+N）：空内容进活跃组并激活 */
  ctx.openUntitled = function openUntitled() {
    untitledSeq++
    const n = untitledSeq
    const g = ctx.groupAt(ctx.activeGroup.value)
    g.files.push({
      path: `${UNTITLED_PATH_PREFIX}${n}`,
      name: ctx.t('editor.untitled.name', { n }),
      content: '',
      originalContent: '',
      loading: false,
    })
    g.activeIndex = g.files.length - 1
  }

  /** 启动恢复（P-20261003-97，草稿热退出对标 VS Code untitled backup）：
   *  读当前项目 untitled 命名空间记录，逐条重建草稿 tab（编号经 untitledSeq
   *  重新分配，防与本次会话已新建的编号冲突），内容就位保持脏态。恢复即迁移：
   *  记录搬到新编号键下（刚恢复再崩仍可恢复），旧键清除。空记录不参与。
   *  由 bootstrap 恢复链在项目恢复落地后调用（useLayoutBootstrap） */
  ctx.restoreUntitledDrafts = async function restoreUntitledDrafts() {
    const projectId = projectStore.currentProjectId
    if (!projectId) return
    let rows: Awaited<ReturnType<typeof listUntitledDrafts>>
    try {
      rows = await listUntitledDrafts(projectId)
    } catch { return } // 环境不可用由 draftDb 静默降级，此处防御兜底
    const usable = rows
      .filter(r => r.record.content)
      .sort((a, b) => untitledNum(a.key) - untitledNum(b.key))
    if (usable.length === 0) return
    const g = ctx.groupAt(ctx.activeGroup.value)
    const firstIdx = g.files.length
    for (const row of usable) {
      untitledSeq++
      const n = untitledSeq
      const path = `${UNTITLED_PATH_PREFIX}${n}`
      g.files.push({
        path,
        name: ctx.t('editor.untitled.name', { n }),
        content: row.record.content,
        originalContent: '', // 恢复即脏态：未落盘语义不变，保存仍走另存为
        loading: false,
      })
      // 记录立即迁移到重新分配的编号键（不经防抖——恢复后马上再崩也可恢复；
      // 保存原 savedAt，旧键不留陈旧副本）
      void removeUntitledDraft(projectId, row.key)
      void saveUntitledDraft(projectId, path, { content: row.record.content, savedAt: row.record.savedAt })
    }
    // 组原本为空时激活第一份恢复的草稿；已有活跃 tab 不抢焦点
    if (g.activeIndex < 0) g.activeIndex = firstIdx
    ctx.message.success(ctx.t('editor.untitled.restored', { n: usable.length }))
  }

  /** 未命名草稿另存为：路径输入（promptDialog，与新建路径输入同款输入框）→
   *  CreateFile 落盘（content 随建随写，语义即完整保存）→ tab 原地转正。
   *  取消/路径为空/落盘失败均保持草稿原状，可再次保存重试 */
  ctx.saveUntitledAs = async function saveUntitledAs(file: OpenFile) {
    if (!projectStore.currentProjectId) return
    const projectId = projectStore.currentProjectId
    const input = await promptDialog({
      title: ctx.t('editor.untitled.saveAsTitle'),
      label: ctx.t('editor.untitled.saveAsPath'),
      placeholder: ctx.t('editor.untitled.saveAsPlaceholder'),
      validate: (v) => v.trim() ? null : ctx.t('editor.untitled.pathRequired'),
    })
    const target = input?.trim()
    if (!target) return
    // 目标路径已有打开标签（同路径全工程至多一份对象的模型会被两份内存内容
    // 打破）：拒绝转正，提示换路径
    if (ctx.findOpenFile(target)) {
      ctx.message.warning(ctx.t('editor.untitled.pathOpen'))
      return
    }
    try {
      await projectApi.createFile(projectId, target, file.content)
    } catch { return } // 拦截器已提示（同名冲突/路径非法）：草稿保持原状
    const oldPath = file.path
    // tab 原地转正：对象身份不变（分屏共享组同步转正），脏基线对齐磁盘
    file.path = target
    file.name = target.split('/').pop() || target
    file.originalContent = file.content
    // CreateFile 响应无内容 hash：转正后首次保存按历史语义不做冲突检测
    file.encoding = ''
    file.baseHash = ''
    // 转正 = 内容已落盘：untitled 命名空间热退出备份同步清账（含挂起防抖，
    // P-20261003-97）。isUntitledPath 守卫仅为防御：转正后 oldPath 恒为 untitled 键
    if (isUntitledPath(oldPath)) ctx.clearFileDraft(projectId, oldPath)
    // 内容已落盘：与保存成功同语义刷新变更计数（状态栏滞留同因）
    void useChangesStore().fetchStatus(projectId)
    // 转正即落盘成功：同保存链广播（gutter 变更条等磁盘状态消费方刷新）
    window.dispatchEvent(new CustomEvent(OPS_FILES_SAVED, { detail: { paths: [target] } }))
    onUntitledSavedAs?.(target)
    // 草稿 model 已随 path 变化被 MonacoEditor 换下入 LRU 缓存，等 watcher
    // 完成换挂后再释放（同步释放会命中仍在挂载中的 model）
    void nextTick(() => onDisposeModel?.(oldPath))
    ctx.message.success(ctx.t('editor.untitled.savedAs', { name: file.name }))
  }
}

/** untitled://N 内部键的编号（恢复排序用：按编号升序重建，非数字键排最后） */
function untitledNum(key: string): number {
  const m = /(\d+)$/.exec(key)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}
