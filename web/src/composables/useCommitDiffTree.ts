import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import { logApi } from '../api/client'
import { buildDiffTree, flattenDiffTree, type DiffFile } from '../utils/diffTree'

/**
 * 提交选中集的变更文件树（自 CommitsPanel.vue 抽出）：
 * 拉取选中提交的文件并按最新状态合并去重，构建/展平目录树供渲染。
 */
export function useCommitDiffTree(options: {
  projectId: () => string
  selectedHashes: Ref<Set<string>>
}) {
  const { projectId, selectedHashes } = options

  const diffFiles = ref<DiffFile[]>([])
  const diffLoading = ref(false)
  const expandedDiffDirs = ref<Set<string>>(new Set())

  // 防止并发请求的旧结果覆盖新结果
  let generation = 0

  const diffTree = computed(() => buildDiffTree(diffFiles.value))
  const flatDiffTree = computed(() => flattenDiffTree(diffTree.value, expandedDiffDirs.value))

  function toggleDiffDir(path: string) {
    if (expandedDiffDirs.value.has(path)) expandedDiffDirs.value.delete(path)
    else expandedDiffDirs.value.add(path)
  }

  // 默认展开所有目录
  function expandAllDiffDirs() {
    function collectDirs(nodes: ReturnType<typeof buildDiffTree>) {
      for (const n of nodes) {
        if (n.isDir) {
          expandedDiffDirs.value.add(n.path)
          collectDirs(n.children)
        }
      }
    }
    collectDirs(diffTree.value)
  }

  /** 按当前选中提交集合重新拉取合并文件列表 */
  async function loadForHashes() {
    if (!projectId() || selectedHashes.value.size === 0) {
      diffFiles.value = []
      return
    }
    diffLoading.value = true
    const gen = ++generation
    try {
      const hashes = Array.from(selectedHashes.value)
      // 并行获取所有选中提交的文件，合并去重
      const allFiles = await Promise.all(
        hashes.map(async (hash) => {
          try {
            const res: any = await logApi.getCommitFiles(projectId(), hash)
            return (res.data || []).map((f: any) => ({
              path: typeof f === 'string' ? f : f.path,
              name: typeof f === 'string' ? f.split('/').pop() : (f.path || '').split('/').pop(),
              status: typeof f === 'string' ? '' : f.status || '',
            }))
          } catch { return [] }
        })
      )
      // 旧请求完成时丢弃结果
      if (gen !== generation) return
      // 合并去重，保留最新状态
      const fileMap = new Map<string, DiffFile>()
      for (const files of allFiles) {
        for (const f of files) {
          fileMap.set(f.path, f)
        }
      }
      diffFiles.value = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path))
      expandAllDiffDirs()
    } catch { if (gen === generation) diffFiles.value = [] }
    finally { if (gen === generation) diffLoading.value = false }
  }

  return {
    diffFiles,
    diffLoading,
    flatDiffTree,
    expandedDiffDirs,
    toggleDiffDir,
    loadForHashes,
  }
}
