/**
 * 编辑器未保存草稿的 IndexedDB mini wrapper（P-20261002-6）。
 *
 * 单表设计：object store「drafts」，主键 `${projectId}\u0000${path}`，
 * 值为 DraftRecord（脏文件全文 + 写入时间戳 + 写入时的磁盘内容 hash）。
 * 项目维度清理走主键前缀范围删除，不建二级索引。
 * untitled 草稿（P-20261003-97）复用同一 store，以双 NUL 前缀命名空间隔离
 * （见文件尾 untitled 节注释）。
 *
 * 防御语义（safeStorage 同款思路）：隐私模式/无 indexedDB/建连或事务失败
 * 一律静默降级（写入返回 false、读取返回 null），功能失效不报错——草稿是
 * 纯增益能力，绝不能因它打断编辑主流程。首次建连失败后置 disabled，
 * 避免每次击键防抖都重试建连。
 *
 * 跨标签同步：写路径成功分支广播 localStorage 信标（P-20261006-8，见下方
 * 信标节注释），接收与重载判定在 persist 域。
 */
import { safeStorage } from './storage'

/** 一条草稿记录：恢复时与磁盘当前状态比对决定提示还是丢弃 */
export interface DraftRecord {
  /** 脏文件全文（openFile.content） */
  content: string
  /** 最后写入时间戳（恢复提示条展示「检测到未保存的草稿 <时间>」） */
  savedAt: number
  /** 写入草稿时磁盘内容的 sha256（ReadFile 响应 hash 字段）：恢复探测时与
   *  磁盘当前 hash 比对，不一致 = 磁盘已前行（agent/外部改写），草稿视为
   *  陈旧静默丢弃。空 = 写入时无基线（旧响应），跳过该比对 */
  baseHash?: string
}

const DB_NAME = 'sc-editor-drafts'
const STORE = 'drafts'

// ── 跨标签写竞争保护信标（P-20261006-8，P-20261002-8 uiState 键级 patch 的
// 草稿域对称）──IndexedDB 草稿跨标签页共享且 last-write-wins：双标签同开一
// 文件时，后写方的防抖落库会无声踩掉先写方的草稿（崩溃恢复拿到的是被踩后的
// 内容，自动保存使互踩无声）。两条写路径（saveDraft/saveUntitledDraft）的
// 成功分支在此统一广播一枚 localStorage 信标，接收侧（persist 域）比较
// savedAt 决定重载。收口在本层而非调用点：所有写路径（含 untitled 启动迁移）
// 结构性全覆盖，未来新增写路径零遗漏。storage 事件浏览器语义只派发给「其他
// 标签页」，同页写入不回环（settingsSync P-36 同机制）；localStorage 屏蔽时
// safeStorage 落内存兜底、不产生 storage 事件，同步静默降级——与草稿本体
// 的防御口径一致。信标 key 与 settingsSync 的按 key 分发表天然隔离：该表
// 精确匹配各设置键，未登记键（本信标）忽略
//
// key 用固定单键 + JSON 载荷而非提案原文的 draft-saved:{project}:{path}:{savedAt}
// 键编码形态：path 可能含冒号（untitled://N、remote:<hostId>:<path>），编码进
// key 无法无歧义拆分；载荷含 savedAt 保证每次写入值必变（storage 事件只在新旧
// 值不同时派发，同值覆写不触发）

/** 草稿落库成功信标的 localStorage 键（payload 见 DraftSavedBeacon） */
export const DRAFT_SAVED_BEACON_KEY = 'sc.draft-saved'

/** 信标载荷：project 为草稿键的项目维度（本地项目 id / 远程固定命名空间），
 *  path 为草稿内部键（本地文件路径或 untitled://N） */
export interface DraftSavedBeacon {
  project: string
  path: string
  savedAt: number
}

function emitDraftSavedBeacon(projectId: string, path: string, savedAt: number): void {
  try {
    safeStorage.setItem(DRAFT_SAVED_BEACON_KEY, JSON.stringify({ project: projectId, path, savedAt }))
  } catch { /* 序列化异常静默：信标是纯增益，草稿本体已落库 */ }
}

/** 单文件草稿上限（按字符数近似 2MB 文本）：超大文件不进 DB，防止把配额塞爆 */
export const DRAFT_MAX_CHARS = 2 * 1024 * 1024

let dbPromise: Promise<IDBDatabase | null> | null = null
let disabled = false

function openDb(): Promise<IDBDatabase | null> {
  if (disabled) return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') {
          disabled = true
          resolve(null)
          return
        }
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => { disabled = true; resolve(null) }
        req.onblocked = () => { disabled = true; resolve(null) }
      } catch {
        disabled = true
        resolve(null)
      }
    })
  }
  return dbPromise
}

function draftKey(projectId: string, path: string): string {
  // \u0000 分隔：projectId 不含控制字符，前缀扫描天然按项目隔离
  return `${projectId}\u0000${path}`
}

/** 写入草稿。内容超限返回 false 不写（保留 DB 中已有的旧草稿供降级恢复）。
 *  成功即广播跨标签信标（P-20261006-8）：其他标签页据此重载较新草稿 */
export async function saveDraft(projectId: string, path: string, record: DraftRecord): Promise<boolean> {
  if (record.content.length > DRAFT_MAX_CHARS) return false
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record, draftKey(projectId, path))
      tx.oncomplete = () => {
        emitDraftSavedBeacon(projectId, path, record.savedAt)
        resolve(true)
      }
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

/** 读取草稿。无记录/环境不可用返回 null */
export async function readDraft(projectId: string, path: string): Promise<DraftRecord | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(draftKey(projectId, path))
      req.onsuccess = () => resolve((req.result as DraftRecord | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 删除单文件草稿（保存成功/关闭文件/用户丢弃） */
export async function removeDraft(projectId: string, path: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(draftKey(projectId, path))
  } catch { /* 静默降级 */ }
}

/** 清空某项目全部草稿（项目删除时）：主键 \u0000 前缀范围删除 */
export async function removeProjectDrafts(projectId: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const range = IDBKeyRange.bound(`${projectId}\u0000`, `${projectId}\u0000\uffff`)
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(range)
  } catch { /* 静默降级 */ }
}

// ── 陈旧对账（P-20261003-152）：文件已删除的草稿永久滞留（恢复探测只在文件
// 打开成功后触发，已删文件永远探测不到自己的草稿）——启动恢复时对账清理，
// 取数/清账原语收口在本层，判定逻辑在 persist 域 ──

/** 一条文件草稿行（对账遍历用）：path 为项目相对路径 */
export interface FileDraftRow {
  path: string
  record: DraftRecord
}

/** 列出某项目全部「文件」草稿（前缀范围游标，排除 untitled 命名空间）。
 *  键形态判别：文件键 = `${projectId}\u0000${path}`（路径不含 NUL，其余部分
 *  即路径）；untitled 键在首个 NUL 后紧跟第二个 NUL（见下方 untitled 节注释），
 *  以此构造性区分，两命名空间互斥。环境不可用返回空数组 */
export async function listFileDrafts(projectId: string): Promise<FileDraftRow[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const prefix = `${projectId}\u0000`
      const range = IDBKeyRange.bound(prefix, `${projectId}\u0000\uffff`)
      const rows: FileDraftRow[] = []
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range)
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve(rows)
          return
        }
        const rest = String(cursor.key).slice(prefix.length)
        if (!rest.startsWith('\u0000')) {
          rows.push({ path: rest, record: cursor.value as DraftRecord })
        }
        cursor.continue()
      }
      req.onerror = () => resolve(rows)
    } catch {
      resolve([])
    }
  })
}

/** 批量删除该项目的一组文件草稿（对账清理用）：单事务一次提交，
 *  替代逐条 removeDraft 的 N 次事务。无记录的键删除是 no-op，静默完成 */
export async function removeDrafts(projectId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const path of paths) store.delete(draftKey(projectId, path))
  } catch { /* 静默降级 */ }
}

// ── untitled 草稿命名空间（P-20261003-97，草稿热退出）──
// 真实文件草稿键 = `${projectId}\u0000${path}`（恰含一个 NUL——路径不可能含
// NUL）；untitled 键在其后插入第二个 NUL 作命名空间标记，两族键空间构造性
// 不相交：linux 文件名合法含冒号斜杠（文件可以叫 untitled://1），单 NUL 键
// 无法与 untitled 内部键区分，双 NUL 后永不串。下方 removeProjectDrafts 的
// 前缀范围覆盖双命名空间（untitled 键同样以 `${projectId}\u0000` 起头），
// 项目删除清账不需要额外挂钩。

function untitledKey(projectId: string, key: string): string {
  return `${projectId}\u0000\u0000untitled\u0000${key}`
}

/** 一条 untitled 草稿记录：key 为草稿内部键（untitled://N） */
export interface UntitledDraftRow {
  key: string
  record: DraftRecord
}

/** 写入 untitled 草稿。内容超限返回 false 不写（与 saveDraft 同口径）。
 *  成功即广播跨标签信标（P-20261006-8）：两条写路径同挂，untitled 草稿同链；
 *  路径为草稿内部键（untitled://N）。启动恢复迁移写（untitled.ts，保原
 *  savedAt）也经此广播——接收方按 savedAt 判定，同值自然幂等跳过 */
export async function saveUntitledDraft(projectId: string, key: string, record: DraftRecord): Promise<boolean> {
  if (record.content.length > DRAFT_MAX_CHARS) return false
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record, untitledKey(projectId, key))
      tx.oncomplete = () => {
        emitDraftSavedBeacon(projectId, key, record.savedAt)
        resolve(true)
      }
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

/** 读取单条 untitled 草稿（跨标签同步重载用，与 save/remove 对称的原语，
 *  P-20261006-8）。无记录/环境不可用返回 null */
export async function readUntitledDraft(projectId: string, key: string): Promise<DraftRecord | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(untitledKey(projectId, key))
      req.onsuccess = () => resolve((req.result as DraftRecord | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 列出某项目全部 untitled 草稿（前缀范围游标；key 顺序即主键字典序）。
 *  无记录/环境不可用返回空数组 */
export async function listUntitledDrafts(projectId: string): Promise<UntitledDraftRow[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const prefix = untitledKey(projectId, '')
      const range = IDBKeyRange.bound(prefix, untitledKey(projectId, '\uffff'))
      const rows: UntitledDraftRow[] = []
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range)
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve(rows)
          return
        }
        rows.push({ key: String(cursor.key).slice(prefix.length), record: cursor.value as DraftRecord })
        cursor.continue()
      }
      req.onerror = () => resolve(rows)
    } catch {
      resolve([])
    }
  })
}

/** 删除单条 untitled 草稿（另存为转正/确认丢弃/回净态时清账） */
export async function removeUntitledDraft(projectId: string, key: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(untitledKey(projectId, key))
  } catch { /* 静默降级 */ }
}
