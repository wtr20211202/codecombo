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
 *
 * 标签裁决链（P-20261112-7 S2 评审修订点）：409 挂起期间未落盘的本地标签编辑
 * （tagsDirty 挂起）在三动作路径各自承接，不静默丢弃——
 *   ①用我的覆盖：携 content+tags 一并写回（无挂起标签编辑仍不带 tags，nil
 *     保全他窗标签）；
 *   ②载入服务端版本：本地标签编辑一并放弃，编辑面标签回落 409 快照
 *     currentTags（异常缺省回退清单 meta.tags）；
 *   ③另存为新篇：本地标签随篇带去新篇（空标签不携——新建篇无标签）。
 */

/** 保存态（per-note 状态机——dirty/saving/error 互不牵连） */
export type NoteSaveState = 'idle' | 'dirty' | 'saving' | 'error'

/** 冲突现场（409 notes.conflict 响应载荷；挂起期间至多一条——冲突条是模态裁决面） */
export interface NotesConflictState {
  noteId: string
  currentContent: string
  currentUpdatedAt: string
  /** 服务端当前标签（P-20261112-7 S2：409 快照三字段自洽；「载入服务端版本」
   *  放弃本地标签编辑的回落真值。旧服务端载荷缺省——回退清单 meta 兜底） */
  currentTags?: string[]
}

/** 冲突动作 deps：引擎装配期显式传入（全部为引擎内已就绪的引用/闭包） */
export interface NotesConflictDeps {
  conflict: Ref<NotesConflictState | null>
  contents: Record<string, string>
  bases: Record<string, string>
  tags: Record<string, string[]>
  tagsDirty: Record<string, boolean>
  saveStates: Record<string, NoteSaveState>
  notes: Ref<MultiNoteMeta[]>
  /** 保存成功回写（内容/基准/状态/清单序，引擎单点）；tagsSynced=本请求携 tags */
  applySaved: (n: { id: string; title: string; updatedAt: string; size?: number; tags?: string[] }, tagsSynced?: boolean) => void
  createNote: (title?: string) => Promise<MultiNoteMeta | null>
  edit: (noteId: string, content: string) => void
  editTags: (noteId: string, next: string[]) => void
  flushSave: (noteId: string) => Promise<void>
  /** 递增 per-note 在途令牌：裁决前使 409 挂起期间 editTags 排出的防抖重试
   *  PUT 的迟到响应过期（乱序守卫丢弃），不重挂冲突条打断已完成的裁决 */
  bumpSaveToken: (noteId: string) => void
  message: { error: (content: string) => void }
  t: (key: string) => string
}

export function createNotesConflictResolvers(deps: NotesConflictDeps) {
  const { conflict, contents, bases, tags, tagsDirty, saveStates, notes, applySaved, createNote, edit, editTags, flushSave, bumpSaveToken, message, t } = deps

  /** 冲突动作①：用我的覆盖（丢 baseUpdatedAt 直写——显式意图）。挂起期间
   *  未落盘的本地标签编辑随载荷一并写回（tagsDirty 判据；无挂起标签编辑不带
   *  tags——nil 不动他窗标签，与服务端三态语义同源） */
  async function resolveConflictOverwrite(): Promise<void> {
    const cf = conflict.value
    if (!cf) return
    bumpSaveToken(cf.noteId) // 在途重试 PUT 的迟到 409 过期（本动作已接管写回）
    const carryTags = tagsDirty[cf.noteId] === true
    conflict.value = null
    saveStates[cf.noteId] = 'saving'
    try {
      const res = await notesGlobalApi.save(cf.noteId, {
        content: contents[cf.noteId] ?? '',
        ...(carryTags ? { tags: tags[cf.noteId] ?? [] } : {}),
      })
      applySaved(res.data, carryTags)
    } catch (e) {
      saveStates[cf.noteId] = 'error'
      message.error((e as { userMessage?: string }).userMessage || t('notes.panel.saveFailed'))
    }
  }

  /** 冲突动作②：载入服务端版本（本地未保存编辑让位——用户显式选择）。本地
   *  标签编辑一并放弃：编辑面标签回落 409 快照 currentTags（S2 裁决链——
   *  冲突条文案明示；旧载荷缺省回退清单 meta.tags 兜底），tagsDirty 复位 */
  function resolveConflictLoadServer(): void {
    const cf = conflict.value
    if (!cf) return
    bumpSaveToken(cf.noteId) // 同步回落：在途重试 PUT 的迟到 409 过期
    contents[cf.noteId] = cf.currentContent
    bases[cf.noteId] = cf.currentUpdatedAt
    tags[cf.noteId] = cf.currentTags ?? notes.value.find(n => n.id === cf.noteId)?.tags ?? []
    tagsDirty[cf.noteId] = false
    saveStates[cf.noteId] = 'idle'
    conflict.value = null
  }

  /** 冲突动作③：另存为新篇（多文档独有逃生门——本地内容不丢，冲突篇留服务端态）。
   *  本地标签（含挂起编辑）随篇带去新篇：editTags 走同一归一化，与内容合并进
   *  同一次 flushSave（新篇 PUT 一次携 content+tags）；空标签不携 */
  async function resolveConflictSaveAsNew(): Promise<void> {
    const cf = conflict.value
    if (!cf) return
    const local = contents[cf.noteId] ?? ''
    const localTags = tags[cf.noteId] ?? []
    const meta = notes.value.find(n => n.id === cf.noteId)
    bumpSaveToken(cf.noteId) // 原篇回落不经网络：在途重试 PUT 的迟到 409 过期
    conflict.value = null
    const created = await createNote(meta?.title ? `${meta.title} · ${t('notes.panel.conflictCopySuffix')}` : t('notes.panel.conflictCopySuffix'))
    if (!created) return
    edit(created.id, local)
    if (localTags.length > 0) editTags(created.id, localTags)
    await flushSave(created.id)
    // 原篇回落服务端版本（冲突已由新篇承接；不经 conflict.value——它已清空，
    // 指定捕获的冲突现场复位）。本地标签编辑一并放弃：回落 409 快照 currentTags
    contents[cf.noteId] = cf.currentContent
    bases[cf.noteId] = cf.currentUpdatedAt
    tags[cf.noteId] = cf.currentTags ?? meta?.tags ?? []
    tagsDirty[cf.noteId] = false
    saveStates[cf.noteId] = 'idle'
  }

  return { resolveConflictOverwrite, resolveConflictLoadServer, resolveConflictSaveAsNew }
}
