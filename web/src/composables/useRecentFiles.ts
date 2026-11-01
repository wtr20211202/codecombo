import { ref, computed } from 'vue'
import { safeStorage } from '../utils/storage'
import { useProjectStore } from '../stores/project'

export interface RecentEntry { path: string; name: string; projectId: string; projectName: string; projectPath?: string; ts: number }

// 模块级单例：记录与展示分离——文件打开即记录，不依赖欢迎面板是否挂载
//（此前经 EditorArea→WelcomePanel 的 ref 链推送，打开文件必然切走欢迎页，
// 面板卸载后 ref 为 null，记录被可选链静默丢弃）
const recents = ref<RecentEntry[]>(loadRecents())

function loadRecents(): RecentEntry[] {
  try {
    const raw = safeStorage.getItem('editor-recent-files')
    return raw ? JSON.parse(raw) as RecentEntry[] : []
  } catch { return [] }
}
function saveRecents() {
  safeStorage.setItem('editor-recent-files', JSON.stringify(recents.value.slice(0, 8)))
}

export function useRecentFiles() {
  const projectStore = useProjectStore()

  function pushRecent(entry: RecentEntry) {
    // 去重键 = 路径 + 项目位置（projectPath 稳定；projectId 会随项目重建轮换，
    // 仅按 projectId 去重会在重建后产生同路径双条目 → WelcomePanel :key 冲突）
    const norm = (p?: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const sameSpot = (r: RecentEntry) =>
      r.path === entry.path &&
      (r.projectId === entry.projectId ||
        (!!r.projectPath && !!entry.projectPath && norm(r.projectPath) === norm(entry.projectPath)))
    const idx = recents.value.findIndex(sameSpot)
    if (idx !== -1) recents.value.splice(idx, 1)
    recents.value.unshift(entry)
    if (recents.value.length > 8) recents.value.length = 8
    saveRecents()
  }

  /** 移除死条目：文件已删除/不可打开时由打开失败路径调用，避免列表常驻
   *  点击必错的「僵尸项」。path 为稳定键；projectPath 匹配用于同名歧义消解 */
  function removeRecent(path: string) {
    const idx = recents.value.findIndex(r => r.path === path)
    if (idx === -1) return
    recents.value.splice(idx, 1)
    saveRecents()
  }

  // 当前项目下的最近文件：projectId 会随项目删除重建而轮换（e2e/清理场景），
  // 记录里补存稳定的 projectPath，旧条目（无 projectPath）回退按项目名匹配
  const currentProjectRecents = computed(() => {
    const proj = projectStore.currentProject
    const pid = projectStore.currentProjectId
    if (!pid || !proj) return []
    return recents.value.filter(r =>
      r.projectId === pid ||
      (r.projectPath && r.projectPath === proj.path) ||
      (!r.projectPath && r.projectName === proj.name))
  })

  return { recents, pushRecent, removeRecent, currentProjectRecents }
}
