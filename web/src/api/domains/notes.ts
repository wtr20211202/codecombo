// 笔记库领域 API（P-20261107-2 多篇 → P-20261107-5 全局库独立化 → P-20261108-3
// 单库化）：/api/notes 族是唯一笔记库——项目无关的 notepad 库（原「全局库|项目库」
// 双源切换与项目族 /projects/:id/notes(-multi) 端点随单库化退役）。清单只回元数据
// （不内联 content），内容单篇 GET；PUT 可选 baseUpdatedAt 乐观校验（过期 409
// notes.conflict 携 currentContent/currentUpdatedAt）；DELETE 软删（回收站 30 天），
// ?purge=1 彻底删除（agent 令牌服务端硬拒——前端入口同样只对人在场动作开放）。
// 响应泛型按 envprofile/sync 域同款收口（axios 拦截器已解包 HTTP body，断言
// Promise<{data?}> 让消费方统一 res.data 取值）
import api from '../http'

/** 单篇笔记完整形态（GET 单篇 / POST 新建 / PUT 保存响应的 data） */
export interface MultiNote {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
  deletedBy?: string
}

/** 默认篇 id（well-known，与服务端 store.DefaultNoteID 同源）：空库时面板合成的
 *  占位篇 id——首写经 PUT /notes/default 由服务端 upsert 落真身 */
export const DEFAULT_NOTE_ID = 'default'

/** 清单条目（元数据面——绝不内联 content） */
export interface MultiNoteMeta {
  id: string
  title: string
  updatedAt: string
  size: number
  deletedAt?: string
  deletedBy?: string
}

/** 笔记库作用域键（与服务端 store.GlobalNotesScope 同值）：notes.updated 广播的
 *  projectId 取此值 = 笔记库已变（字段名沿用多篇时代命名，面板按此值对位） */
export const GLOBAL_NOTES_SCOPE = '_global'

/** 单库化迁移滞留计数（GET /notes/migration；P-20261108-3）：pending = 仍未并入
 *  的旧项目笔记篇数，full = 笔记库已到 100 篇额度（满额中止的主因） */
export interface NotesMigrationStatus {
  pending: number
  full: boolean
}

/** 手动续迁结果（POST /notes/migration）：本轮迁入 / 仍滞留 / 是否再次满额 */
export interface NotesMigrationResult {
  migrated: number
  pending: number
  full: boolean
}

/** 笔记库 API（/api/notes 族） */
export const notesGlobalApi = {
  /** 在册篇清单（updatedAt 降序）；trash=1 回收站视图 */
  list: (trash?: boolean) =>
    api.get<{ data: MultiNoteMeta[] }>('/notes', { params: trash ? { trash: 1 } : undefined }) as unknown as Promise<{ data?: MultiNoteMeta[] }>,
  /** 新建一篇（id 服务端生成）→ 201；满 100 篇 400 notes.global_limit */
  create: (body: { title?: string; content?: string }) =>
    api.post<{ data: MultiNote }>('/notes', body) as unknown as Promise<{ data: MultiNote }>,
  /** 读单篇 */
  get: (noteId: string) =>
    api.get<{ data: MultiNote }>(`/notes/${noteId}`) as unknown as Promise<{ data: MultiNote }>,
  /** 保存（title 携带即重命名；baseUpdatedAt 携带即乐观校验） */
  save: (noteId: string, body: { content: string; title?: string; baseUpdatedAt?: string }) =>
    api.put<{ data: MultiNote }>(`/notes/${noteId}`, body) as unknown as Promise<{ data: MultiNote }>,
  /** 软删进回收站（幂等） */
  remove: (noteId: string) =>
    api.delete<{ message: string }>(`/notes/${noteId}`) as unknown as Promise<{ message: string }>,
  /** 彻底删除（人侧；不可恢复） */
  purge: (noteId: string) =>
    api.delete<{ message: string }>(`/notes/${noteId}?purge=1`) as unknown as Promise<{ message: string }>,
  /** 回收站恢复（幂等） */
  restore: (noteId: string) =>
    api.post<{ message: string }>(`/notes/${noteId}/restore`) as unknown as Promise<{ message: string }>,
  /** 单库化迁移滞留计数（只读，面板续迁横幅数据源） */
  migrationStatus: () =>
    api.get<{ data: NotesMigrationStatus }>('/notes/migration') as unknown as Promise<{ data?: NotesMigrationStatus }>,
  /** 手动续迁（满额中止后腾出空间再续；幂等可重复调用） */
  migrate: () =>
    api.post<{ data: NotesMigrationResult }>('/notes/migration') as unknown as Promise<{ data?: NotesMigrationResult }>,
}

/**
 * 单篇保存端点的原始路径（beforeunload keepalive fetch 用——卸载期绕开 axios
 * 拦截链直发，故需自拼 /api 前缀；与 notesGlobalApi.save 同址）
 */
export function notesSaveUrl(noteId: string): string {
  return `/api/notes/${noteId}`
}
