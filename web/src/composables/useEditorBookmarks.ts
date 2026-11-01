import { ref } from 'vue'
import { useUIStateStore } from '../stores/uiState'
import { useInstanceStore } from '../stores/instance'
import { isUntitledPath } from './useOpenFiles'
import { isRemoteEditorPath } from '../utils/remoteEditorPath'
import {
  normalizeBookmarkAnchor,
  normalizeBookmarkRecords,
  relocateBookmarkRecords,
  type BookmarkRecord,
} from '../utils/bookmarkAnchor'

/**
 * 编辑器书签锚（P-20261002-131；P-20261004-105 行内容锚自愈）：per 项目 per
 * 文件的书签记录表，跨文件往返从「凭记忆」变一键——Ctrl+Alt+B 当前行加/删书签，
 * 命令面板「书签列表」跳转。
 * Ctrl+Alt+PgUp/PgDn 上/下一个书签环形跳转（neighborBookmark，P-20261004-102）。
 *
 * 为什么模块级单例（useEditorNavHistory / useCompareBaseline 同范式）：消费方
 * 横跨多个互不隶属的层——MonacoEditor（深层组件，装饰/快捷键/gutter 点击，
 * 分屏双组实例共享同一份状态）、BookmarkListPopover（命令面板弹层，跳转数据源）；
 * useOpenFiles 是 shell 实例级组合式，深层组件拿不到实例。
 *
 * 状态模型：内存权威（byProject），uiState `bookmarks` 命名空间持久化——
 * 首次消费前懒加载一次（ensureLoaded），此后写内存 + 落盘（toggle 即时写、
 * 行漂移/重锚防抖写）。记录 = 行号 + 行内容锚（BookmarkRecord，utils/
 * bookmarkAnchor）；锚在加书签与行漂移回写时按当前行内容刷新，失效标为会话内
 * 派生态（staleAnchors，不落盘——重定位只在打开/外部重读时机跑，未打开的文件
 * 不知情不虚报）。行号 1-based、按文件升序；每项目总条目上限
 * BOOKMARKS_MAX_PER_PROJECT，超出按「文件键插入序 × 行升序」近似最早加入
 * 先淘汰（确定性收口，防 uiState 膨胀；无时间戳的精确 FIFO 需要并行有序表，
 * 复杂度大于收益）。
 *
 * 行号漂移（④）：文件在编辑器中打开期间，Monaco model 装饰范围随编辑自动
 * 跟随（插入/删除上方行整体平移）——MonacoEditor 从装饰范围回读真实行号
 * （replaceRecords）同步回本模块。未打开期间外部改写（agent 批量改动/跨会话）：
 * 重开或外部重读时按锚内容重定位自愈（装饰桥 relocateForCurrentFile 判定，
 * 匹配逻辑在 utils/bookmarkAnchor.relocateBookmarkRecords）——失配 ±20 行滑窗
 * 唯一命中→重定位+弱提示；无匹配/多义→保持原行号+失效弱标（诚实降级不瞎猜）。
 */

/** 每项目书签总条目上限（防 uiState 膨胀） */
export const BOOKMARKS_MAX_PER_PROJECT = 100

/** 单点书签位置：line 为 1-based 行号；anchor/stale 见 BookmarkRecord 与失效标注记 */
export interface BookmarkLocation {
  path: string
  line: number
  /** 行内容锚（规范化前 80 字符；缺省 = 旧数据降级记录） */
  anchor?: string
  /** 失效弱标：最近一次重定位判定未在窗口内找回该锚（会话内派生态） */
  stale?: boolean
}

const byProject = ref<Record<string, Record<string, BookmarkRecord[]>>>({})
/** 失效弱标（会话内派生，不落盘）：projectId → path → 判定未找回的锚集——
 *  锚是「该内容是否找得到」的判据本体，按锚记失效天然覆盖同锚多记录；重定位
 *  每次对整文件重算改写，实例切换随重载清空（新会话重新判定） */
const staleAnchors = ref<Record<string, Record<string, string[]>>>({})
/** 状态版本号：MonacoEditor watch 它在任意变更（含另一分屏组的 toggle）后重放装饰 */
const version = ref(0)
let loaded = false
let loadPromise: Promise<void> | null = null
/** 内存缓存归属的实例会话（instanceId）：跨实例切换后强制重载，防旧实例
 *  状态写进新实例的持久化槽 */
let sessionKey = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 书签不可落点路径：diff 伪键（diff:...）、未命名草稿（untitled://N）与
 *  远程伪路径（remote:...）非项目内真实磁盘文件，无法跨会话按路径回放
 *  （同 useEditorNavHistory.isNavTrackable 口径） */
export function isBookmarkablePath(path: string): boolean {
  return !!path && !path.startsWith('diff:') && !isUntitledPath(path) && !isRemoteEditorPath(path)
}

/** 懒加载（首次消费前从 uiState 拉一次）：实例切换后重拉，失败回落内存现状。
 *  装载边界再归一一次记录表（旧 number[]/记录双形态、去重升序）——不依赖 store
 *  读取端的归一保真；跨实例重载同时清失效标（派生态随会话重建） */
function ensureLoaded(): Promise<void> {
  const key = useInstanceStore().currentInstanceId
  if (loaded && key === sessionKey) return Promise.resolve()
  if (!loadPromise || sessionKey !== key) {
    sessionKey = key
    loaded = false
    loadPromise = useUIStateStore().getEditorBookmarks()
      .then((b) => {
        for (const [pid, files] of Object.entries(b)) {
          for (const [p, records] of Object.entries(files)) files[p] = normalizeBookmarkRecords(records)
        }
        byProject.value = b
        staleAnchors.value = {}
        loaded = true
        version.value++
      })
      .catch(() => { loaded = true })
  }
  return loadPromise
}

/** 把 ≤ 上限的裁剪应用到单项目文件表：按文件键插入序 × 行升序近似最早加入先淘汰 */
function enforceCap(files: Record<string, BookmarkRecord[]>): void {
  let total = 0
  for (const records of Object.values(files)) total += records.length
  for (const p of Object.keys(files)) {
    while (total > BOOKMARKS_MAX_PER_PROJECT && files[p]!.length > 0) {
      files[p]!.shift()
      total--
    }
    if (files[p]!.length === 0) delete files[p]
    if (total <= BOOKMARKS_MAX_PER_PROJECT) break
  }
}

/** 跳转锚点：活跃文件路径 + 光标行（line 0 = 行号未知，如 tab 切换的占位锚） */
export interface BookmarkAnchor {
  path: string
  line: number
}

/**
 * 书签间跳转的相邻项（P-20261004-102，Ctrl+Alt+PgUp/PgDn）：在全局排序环形序
 * （listBookmarksOf 产物：路径字典序 × 行升序）上取锚点的上/下一个书签。
 * 锚点语义（JetBrains next/previous bookmark 同族）：
 * - next（delta=1）：同文件首个行号 > 锚点行的书签，否则按路径序首个「更大文件」
 *   的书签，环尾回绕到表头；prev（delta=-1）镜像（严格 <，环头回绕表尾）。
 *   严格比较使落位后的书签不粘滞——连按严格逐个推进、往返归位
 * - 锚点为 null（无活跃文件 / diff 伪键等不可书签形态）取表头（next）或表尾（prev）
 * - 空表返回 null（调用方越界放行，不消费按键）
 * 纯函数便于单测；locations 须已排序（消费方一律经 listBookmarksOf 取）。
 */
export function neighborBookmark(
  locations: BookmarkLocation[],
  current: BookmarkAnchor | null,
  delta: 1 | -1,
): BookmarkLocation | null {
  const n = locations.length
  if (n === 0) return null
  if (!current) return delta === 1 ? locations[0]! : locations[n - 1]!
  if (delta === 1) {
    const at = locations.findIndex(l => l.path > current.path || (l.path === current.path && l.line > current.line))
    return at < 0 ? locations[0]! : locations[at]!
  }
  for (let i = n - 1; i >= 0; i--) {
    const l = locations[i]!
    if (l.path < current.path || (l.path === current.path && l.line < current.line)) return l
  }
  return locations[n - 1]!
}

/** 持久化（delay=0 即时 / >0 防抖——行漂移/重锚随编辑与打开事件触发，不防抖
 *  会高频打 GET+PUT；快照为纯数据拷贝，与内存响应式解耦。失效标是会话内派生
 *  态，天然不在 byProject 快照里、不落盘） */
function schedulePersist(delay: number): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void useUIStateStore().saveEditorBookmarks(JSON.parse(JSON.stringify(byProject.value)))
  }, delay)
}

export function useEditorBookmarks() {
  /** 某文件的书签记录表（内存直读，未加载/无书签返回空表；装饰渲染与重定位数据源） */
  function bookmarksFor(projectId: string, path: string): BookmarkRecord[] {
    if (!projectId || !path) return []
    return byProject.value[projectId]?.[path] || []
  }

  /** 指定项目的全部书签（路径字典序 × 行升序；弹层列表数据源，带失效弱标投影） */
  function listBookmarksOf(projectId: string): BookmarkLocation[] {
    const files = byProject.value[projectId]
    if (!files) return []
    const stale = staleAnchors.value[projectId] || {}
    const out: BookmarkLocation[] = []
    for (const p of Object.keys(files).sort()) {
      const staleSet = new Set(stale[p] || [])
      for (const rec of files[p]!) {
        const loc: BookmarkLocation = { path: p, line: rec.line }
        if (rec.anchor) loc.anchor = rec.anchor
        if (rec.anchor && staleSet.has(rec.anchor)) loc.stale = true
        out.push(loc)
      }
    }
    return out
  }

  /** 某文件判定未找回的锚集（装饰渲染失效弱标用；空集常态） */
  function staleAnchorSet(projectId: string, path: string): Set<string> {
    if (!projectId || !path) return new Set()
    return new Set(staleAnchors.value[projectId]?.[path] || [])
  }

  /** 失效标整文件改写（重定位判定唯一出口）：每次判定对该文件重算全集，确定性
 *  覆盖旧态。集合变化才 bump 版本（装饰重放由 version watch 承接） */
  function setStaleAnchors(projectId: string, path: string, anchors: string[]): void {
    if (!projectId || !isBookmarkablePath(path)) return
    const perProject = (staleAnchors.value[projectId] ??= {})
    const prev = perProject[path] || []
    const next = [...new Set(anchors.filter(a => typeof a === 'string' && a))]
    if (prev.length === next.length && prev.every((a, i) => a === next[i])) return
    if (next.length === 0) {
      delete perProject[path]
      if (Object.keys(perProject).length === 0) delete staleAnchors.value[projectId]
    } else {
      perProject[path] = next
    }
    version.value++
  }

  /** 加/删书签（toggle 语义）：返回 true = 现已加书签。加书签时捕获行内容锚
   *  （anchor 由调用方从 model 当前行取原文，此处归一截断）；即时落盘。显式
   *  加书签是用户此刻的最新意图，新锚从失效集里摘除（否则「重锚到曾判失效的
   *  同内容行」会被残留旧判定误标） */
  function toggleBookmark(projectId: string, path: string, line: number, anchor?: string): boolean {
    if (!projectId || !isBookmarkablePath(path) || !(line >= 1)) return false
    const files = (byProject.value[projectId] ??= {})
    const lines = (files[path] ??= [])
    const idx = lines.findIndex(r => r.line === line)
    if (idx >= 0) {
      lines.splice(idx, 1)
    } else {
      // 升序插入（首位大于 line 的下标；无则追加尾部）
      const norm = typeof anchor === 'string' ? normalizeBookmarkAnchor(anchor) : ''
      const rec: BookmarkRecord = norm ? { line, anchor: norm } : { line }
      const at = lines.findIndex(r => r.line > line)
      if (at < 0) lines.push(rec)
      else lines.splice(at, 0, rec)
      enforceCap(files)
      if (norm) {
        const stale = staleAnchors.value[projectId]?.[path]
        if (stale?.includes(norm)) setStaleAnchors(projectId, path, stale.filter(a => a !== norm))
      }
    }
    if (lines.length === 0) delete files[path]
    if (Object.keys(files).length === 0) delete byProject.value[projectId]
    version.value++
    schedulePersist(0)
    return idx < 0
  }

  /** 行漂移回写（MonacoEditor 从装饰范围回读后调用，记录由装饰桥构建——失效
   *  书签保原锚、其余锚随行内容刷新）：内容不变则跳过，防抖落盘（打字期间
   *  高频触发） */
  function replaceRecords(projectId: string, path: string, records: BookmarkRecord[]): void {
    if (!projectId || !isBookmarkablePath(path)) return
    const next = normalizeBookmarkRecords(records)
    const files = byProject.value[projectId]
    const prev = files?.[path] || []
    if (
      prev.length === next.length &&
      prev.every((r, i) => r.line === next[i]!.line && r.anchor === next[i]!.anchor)
    ) return
    if (next.length === 0) {
      if (files) {
        delete files[path]
        if (Object.keys(files).length === 0) delete byProject.value[projectId]
      }
    } else {
      ;(byProject.value[projectId] ??= {})[path] = next
    }
    version.value++
    schedulePersist(1500)
  }

  return {
    ensureLoaded,
    bookmarksFor,
    listBookmarksOf,
    staleAnchorSet,
    setStaleAnchors,
    toggleBookmark,
    replaceRecords,
    version,
  }
}

// 重定位匹配逻辑在 utils/bookmarkAnchor（纯函数，uiState 读取端/写入端/装饰桥
// 三方共享）；此处引用仅为类型与用例导出路径的单点收口提示
export { relocateBookmarkRecords, normalizeBookmarkRecords, normalizeBookmarkAnchor }
export type { BookmarkRecord }
