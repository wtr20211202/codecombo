import { ref } from 'vue'
import type { Ref } from 'vue'
import { dirLogApi } from '../api/client'

/**
 * 提交列表查询过滤（自 LogView 迁移 + 自 CommitsPanel.vue 抽出）：
 * 作者/时间范围走服务端 /log 的 --author/--since/--until 参数，目录历史走 dirLog 接口。
 */
export function useCommitFilters(options: {
  projectId: () => string
  loading: Ref<boolean>
  /** 接收查询结果行（目录历史模式），宿主负责写入 commits 并停用分页 */
  onCommits: (rows: any[]) => void
  /** 退出目录模式等场景的整表刷新 */
  refresh: () => Promise<void>
}) {
  const { projectId, loading, onCommits, refresh } = options

  const authorFilter = ref('')
  const dateRange = ref<[number, number] | null>(null)
  const dirPath = ref('')
  const dirActive = ref(false)

  /** 作者 + 时间范围过滤参数（YYYY-MM-DD，服务端 --author/--since/--until） */
  function filterParams(): Record<string, unknown> {
    const p: Record<string, unknown> = {}
    const author = authorFilter.value.trim()
    if (author) p.author = author
    if (dateRange.value) {
      const fmt = (ts: number) => {
        const d = new Date(ts)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      }
      p.since = fmt(dateRange.value[0])
      p.until = fmt(dateRange.value[1])
    }
    return p
  }

  /** 目录历史：按目录查看提交，覆盖当前列表（无分页） */
  async function searchDirLog() {
    if (!projectId()) return
    if (!dirPath.value.trim()) { clearDirLog(); return }
    dirActive.value = true
    loading.value = true
    try {
      const res: any = await dirLogApi.getLog(projectId(), dirPath.value.trim())
      onCommits((res.data || []).map((c: any) => c))
    } catch { /* 拦截器处理 */ }
    finally { loading.value = false }
  }

  function clearDirLog() {
    dirPath.value = ''
    if (dirActive.value) {
      dirActive.value = false
      void refresh()
    }
  }

  return {
    authorFilter, dateRange, dirPath, dirActive,
    filterParams, searchDirLog, clearDirLog,
  }
}
