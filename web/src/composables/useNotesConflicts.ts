import type { Ref } from 'vue'
import type { MultiNoteMeta } from '../api/client'
import { notesGlobalApi } from '../api/client'

/**
 * 笔记冲突三动作（P-20261107-5 自 useNotesMulti 拆出，openfiles 域拆分同款
 * 装配契约：域拆模块、跨模块引用经显式 deps 注入，依赖单向——本模块只依
 * api/client，不回引引擎）。
 *
 * 覆盖保护三件套的裁决半边：409 由引擎侧 handleConflict 挂起冲突现场后，人经
 * 三动作处置——①用我的覆盖（丢 baseUpdatedAt 直写，显式意图）②载入服务端
 * 版本（本地未保存编辑让位）③另存为新篇（多文档独有逃生门，本地内容不丢）。
 * P-20261108-3 单库化后写目标恒为 /api/notes 族（原按挂起编辑归属作用域选
 * 项目/全局端点的分支随双源切换退役）。
 */

/** 保存态（per-note 状态机——dirty/saving/error 互不牵连） */
export type NoteSaveState = 'idle' | 'dirty' | 'saving' | 'error'

/** 冲突现场（409 notes.conflict 响应载荷；挂起期间至多一条——冲突条是模态裁决面） */
export interface NotesConflictState {
  noteId: string
  currentContent: string
  currentUpdatedAt: string
}

/** 冲突动作 deps：引擎装配期显式传入（全部为引擎内已就绪的引用/闭包） */
export interface NotesConflictDeps {
  conflict: Ref<NotesConflictState | null>
  contents: Record<string, string>
  bases: Record<string, string>
  saveStates: Record<string, NoteSaveState>
  notes: Ref<MultiNoteMeta[]>
  /** 保存成功回写（内容/基准/状态/清单序，引擎单点） */
  applySaved: (n: { id: string; title: string; updatedAt: string; size?: number }) => void
  createNote: (title?: string) => Promise<MultiNoteMeta | null>
  edit: (noteId: string, content: string) => void
  flushSave: (noteId: string) => Promise<void>
  message: { error: (content: string) => void }
  t: (key: string) => string
}

export function createNotesConflictResolvers(deps: NotesConflictDeps) {
  const { conflict, contents, bases, saveStates, notes, applySaved, createNote, edit, flushSave, message, t } = deps

  /** 冲突动作①：用我的覆盖（丢 baseUpdatedAt 直写——显式意图） */
  async function resolveConflictOverwrite(): Promise<void> {
    const cf = conflict.value
    if (!cf) return
    conflict.value = null
    saveStates[cf.noteId] = 'saving'
    try {
      const res = await notesGlobalApi.save(cf.noteId, { content: contents[cf.noteId] ?? '' })
      applySaved(res.data)
    } catch (e) {
      saveStates[cf.noteId] = 'error'
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.saveFailed'))
    }
  }

  /** 冲突动作②：载入服务端版本（本地未保存编辑让位——用户显式选择） */
  function resolveConflictLoadServer(): void {
    const cf = conflict.value
    if (!cf) return
    contents[cf.noteId] = cf.currentContent
    bases[cf.noteId] = cf.currentUpdatedAt
    saveStates[cf.noteId] = 'idle'
    conflict.value = null
  }

  /** 冲突动作③：另存为新篇（多文档独有逃生门——本地内容不丢，冲突篇留服务端态） */
  async function resolveConflictSaveAsNew(): Promise<void> {
    const cf = conflict.value
    if (!cf) return
    const local = contents[cf.noteId] ?? ''
    const meta = notes.value.find(n => n.id === cf.noteId)
    conflict.value = null
    const created = await createNote(meta?.title ? `${meta.title} · ${t('notes.panel.conflictCopySuffix')}` : t('notes.panel.conflictCopySuffix'))
    if (!created) return
    edit(created.id, local)
    await flushSave(created.id)
    // 原篇回落服务端版本（冲突已由新篇承接；不经 conflict.value——它已清空，
    // 指定捕获的冲突现场复位）
    contents[cf.noteId] = cf.currentContent
    bases[cf.noteId] = cf.currentUpdatedAt
    saveStates[cf.noteId] = 'idle'
  }

  return { resolveConflictOverwrite, resolveConflictLoadServer, resolveConflictSaveAsNew }
}
