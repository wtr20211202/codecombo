// 远程文件「最近打开」环形清单（P-20261004-137）
//
// 为什么独立于 useRecentFiles：项目域最近文件按 projectId/projectPath 过滤，
// 远程签（remote:<hostId>:<path>）跨项目保留、不属任何项目上下文，混进项目域
// 清单会被过滤链整体滤掉。本模块以 safeStorage 键 remote-recent-files 持久
// ≤8 条，hostId+rpath 去重、新项置顶——Quick Open 的远程层据此在文件关闭后
// 仍能 Ctrl+P 直达（此前重开唯一入口是 RemoteFileManager 树浏览）。
//
// 数据面定位：可重建的本地 UI 缓存（不是 source of truth，丢只影响候选记忆），
// 不入持久化三车道；写入点 = 远程文件打开/保存成功（OpenFileHooks 回调），
// 主机已删（打开 404）时惰性清死条目（useRecentFiles.removeRecent 同款惯例）。
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

export interface RemoteRecentFileEntry {
  /** 远程主机 ID（稳定寻址键，主机重命名不撕毁记录） */
  hostId: string
  /** 远端绝对路径（POSIX） */
  rpath: string
  /** 文件名（路径末段，展示/匹配用） */
  name: string
  /** 最近一次打开/保存时刻（排序即环形序，仅诊断用） */
  ts: number
}

export const REMOTE_RECENT_FILES_KEY = 'remote-recent-files'
/** 环形清单上限（与项目域最近文件同档 8 条） */
export const REMOTE_RECENT_MAX = 8

/** 读侧形状防御：手工改坏的 localStorage/旧版本残留条目逐条丢弃，不炸面板 */
function normalizeEntry(raw: unknown): RemoteRecentFileEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.hostId !== 'string' || !r.hostId) return null
  if (typeof r.rpath !== 'string' || !r.rpath) return null
  const name = typeof r.name === 'string' && r.name
    ? r.name
    : (r.rpath.split('/').pop() || r.rpath)
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0
  return { hostId: r.hostId, rpath: r.rpath, name, ts }
}

function load(): RemoteRecentFileEntry[] {
  try {
    const raw = safeStorage.getItem(REMOTE_RECENT_FILES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: RemoteRecentFileEntry[] = []
    const seen = new Set<string>()
    for (const item of arr) {
      const e = normalizeEntry(item)
      if (!e) continue
      const key = `${e.hostId}:${e.rpath}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
      if (out.length >= REMOTE_RECENT_MAX) break
    }
    return out
  } catch {
    return []
  }
}

// 模块级单例（useRecentFiles 同范式）：写入发生在 useOpenFiles 打开/保存链，
// 读取在 useQuickNav 远程层派生，两处不共享组件树，不能靠 provide/inject
const entries = ref<RemoteRecentFileEntry[]>(load())

export function useRemoteRecentFiles() {
  function persist() {
    // safeStorage：隐私模式/配额满时自动降级为会话内内存兜底，绝不阻断打开链
    safeStorage.setItem(REMOTE_RECENT_FILES_KEY, JSON.stringify(entries.value))
  }

  /** 记录一次远程文件打开/保存：同 hostId+rpath 去重后置顶，超上限截尾 */
  function pushRemoteRecent(item: { hostId: string; rpath: string; name?: string; ts?: number }) {
    const e = normalizeEntry({ ...item, ts: item.ts ?? Date.now() })
    if (!e) return
    entries.value = entries.value.filter(x => !(x.hostId === e.hostId && x.rpath === e.rpath))
    entries.value.unshift(e)
    if (entries.value.length > REMOTE_RECENT_MAX) entries.value.length = REMOTE_RECENT_MAX
    persist()
  }

  /** 打开/保存命中 404（主机已删）：惰性清死条目，防面板常驻点开必错的僵尸项 */
  function removeRemoteRecent(hostId: string, rpath: string) {
    const next = entries.value.filter(x => !(x.hostId === hostId && x.rpath === rpath))
    if (next.length === entries.value.length) return
    entries.value = next
    persist()
  }

  /** 清空（e2e/单测隔离用；未来如有「清空最近」入口也走此正门） */
  function clearRemoteRecent() {
    entries.value = []
    persist()
  }

  return { remoteRecentFiles: entries, pushRemoteRecent, removeRemoteRecent, clearRemoteRecent }
}
